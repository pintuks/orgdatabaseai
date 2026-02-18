import { Router, type Request, type Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { Logger } from 'pino'
import { queryRequestSchema, type QueryResponse } from '../types/api'
import type { SchemaSnapshot } from '../schema/introspect'
import { formatSchemaForPrompt } from '../schema/introspect'
import type { LlmClient } from '../llm/fastrouter-client'
import {
  buildSqlGenerationPrompt,
  normalizeModelSqlOrClarify
} from '../prompts/sql-generation'
import { buildResultExplanationPrompt } from '../prompts/result-explanation'
import { buildClarifyPrompt } from '../prompts/clarify'
import { SqlValidationError } from '../sql/errors'
import { validateAndRewriteSql } from '../sql/validate'
import type { QueryExecutor } from '../db/types'
import type { ClarifyStore } from '../session/redis-store'

type QueryRouterOptions = {
  llmClient: LlmClient
  schemaRegistry: {
    getSnapshot: () => SchemaSnapshot
    getPromptSchemaText?: () => string
  }
  queryExecutor: QueryExecutor
  logger: Logger
  hardRowCap: number
  enableStatefulClarify: boolean
  sessionTtlSec: number
  clarifyStore?: ClarifyStore
}

const schemaExecutionErrorCodes = new Set(['42703', '42P01', '42702', '42883', '42P10', '42601'])

function getDbErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }

  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' ? code : undefined
}

function getDbErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (!error || typeof error !== 'object') {
    return 'unknown database execution error'
  }

  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' ? message : 'unknown database execution error'
}

function isSchemaExecutionError(error: unknown): boolean {
  const code = getDbErrorCode(error)
  if (code && schemaExecutionErrorCodes.has(code)) {
    return true
  }

  const message = getDbErrorMessage(error).toLowerCase()
  return message.includes('column') || message.includes('relation') || message.includes('syntax error')
}

function extractClarifyQuestion(raw: string): string | null {
  if (!raw.toUpperCase().startsWith('CLARIFY:')) {
    return null
  }

  const question = raw.slice(raw.indexOf(':') + 1).trim()
  return question.length > 0 ? question : null
}

async function respondWithClarify(options: {
  response: Response<QueryResponse | { error: string }>
  mode: 'stateless' | 'stateful'
  statusCode?: number
  question: string
  sessionId: string | undefined
  originalQuestion: string
  sessionTtlSec: number
  clarifyStore?: ClarifyStore
}): Promise<void> {
  if (options.mode === 'stateful') {
    const persistedSessionId = options.sessionId ?? uuidv4()
    await options.clarifyStore?.set(
      persistedSessionId,
      {
        originalQuestion: options.originalQuestion,
        pendingClarifyQuestion: options.question,
        createdAtIso: new Date().toISOString()
      },
      options.sessionTtlSec
    )

    options.response.status(options.statusCode ?? 200).json({
      status: 'clarify',
      question: options.question,
      sessionId: persistedSessionId
    })
    return
  }

  options.response.status(options.statusCode ?? 200).json({
    status: 'clarify',
    question: options.question
  })
}

async function generateSqlOrClarify(options: {
  llmClient: LlmClient
  question: string
  schemaText: string
  maxRows: number
  retryContext?: string
}): Promise<string> {
  const prompt = buildSqlGenerationPrompt({
    question: options.question,
    schemaText: options.schemaText,
    maxRows: options.maxRows,
    dialect: 'PostgreSQL',
    retryContext: options.retryContext
  })

  const output = await options.llmClient.chat(
    [
      {
        role: 'system',
        content:
          'You write SQL for analytics. Follow instructions exactly, prioritizing security and schema constraints.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    0
  )

  return normalizeModelSqlOrClarify(output)
}

async function generateClarifyFallback(
  llmClient: LlmClient,
  userQuestion: string,
  schemaText: string
): Promise<string> {
  const prompt = buildClarifyPrompt(userQuestion, schemaText)
  const output = await llmClient.chat(
    [
      {
        role: 'system',
        content: 'You ask one concise clarifying question only.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    0
  )

  return output.replace(/^CLARIFY:\s*/i, '').trim()
}

async function explainResults(options: {
  llmClient: LlmClient
  question: string
  sql: string
  rows: Record<string, unknown>[]
  mayBeTruncated: boolean
  logger: Logger
}): Promise<string> {
  const prompt = buildResultExplanationPrompt({
    question: options.question,
    sql: options.sql,
    rowsJson: JSON.stringify(options.rows),
    mayBeTruncated: options.mayBeTruncated
  })

  try {
    const output = await options.llmClient.chat(
      [
        {
          role: 'system',
          content: 'Explain query results faithfully and concisely.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      0.1
    )

    return output.trim()
  } catch (error) {
    options.logger.warn({ error }, 'result explanation failed, using fallback text')
    if (options.rows.length === 0) {
      return 'No rows matched this query. Try adding a broader date range or fewer filters.'
    }

    return `Returned ${options.rows.length} row(s).`
  }
}

export function createQueryRouter(options: QueryRouterOptions): Router {
  const router = Router()

  router.post('/', async (req: Request, res: Response<QueryResponse | { error: string }>) => {
    const startMs = Date.now()

    const parsed = queryRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(', ') })
      return
    }

    if (!req.auth?.orgId) {
      res.status(401).json({ error: 'missing auth context' })
      return
    }

    const input = parsed.data

    if (input.mode === 'stateful' && !options.enableStatefulClarify) {
      res.status(400).json({ error: 'stateful clarify mode is disabled' })
      return
    }

    if (input.mode === 'stateful' && !options.clarifyStore) {
      res.status(500).json({ error: 'stateful clarify store is not configured' })
      return
    }

    const schemaSnapshot = options.schemaRegistry.getSnapshot()
    const schemaText = options.schemaRegistry.getPromptSchemaText
      ? options.schemaRegistry.getPromptSchemaText()
      : formatSchemaForPrompt(schemaSnapshot)

    let sourceQuestion = input.question
    let activeSessionId = input.sessionId

    if (input.mode === 'stateful' && input.clarificationAnswer) {
      if (!input.sessionId) {
        res.status(400).json({ error: 'sessionId is required for stateful clarification answers' })
        return
      }

      const state = await options.clarifyStore?.get(input.sessionId)
      if (!state) {
        res.status(400).json({ error: 'clarification session was not found or expired' })
        return
      }

      sourceQuestion = `${state.originalQuestion}\nUser clarification: ${input.clarificationAnswer}`
    } else if (input.mode === 'stateless' && input.clarificationAnswer) {
      sourceQuestion = `${input.question}\nUser clarification: ${input.clarificationAnswer}`
    }

    try {
      const validate = (candidateSql: string) =>
        validateAndRewriteSql({
          sql: candidateSql,
          schemaSnapshot,
          orgId: req.auth!.orgId,
          page: input.page,
          pageSize: input.pageSize,
          hardCap: options.hardRowCap
        })

      const maxSqlGenerationAttempts = 2
      let retryContext: string | undefined
      let rewritten: ReturnType<typeof validateAndRewriteSql> | null = null
      let execution: Awaited<ReturnType<QueryExecutor['executeReadOnly']>> | null = null

      for (let attempt = 0; attempt < maxSqlGenerationAttempts; attempt += 1) {
        const modelOutput = await generateSqlOrClarify({
          llmClient: options.llmClient,
          question: sourceQuestion,
          schemaText,
          maxRows: Math.min(input.pageSize, options.hardRowCap),
          retryContext
        })

        const clarifyQuestion = extractClarifyQuestion(modelOutput)
        if (clarifyQuestion) {
          await respondWithClarify({
            response: res,
            mode: input.mode,
            statusCode: retryContext ? 422 : 200,
            question: clarifyQuestion,
            sessionId: activeSessionId,
            originalQuestion: input.question,
            sessionTtlSec: options.sessionTtlSec,
            clarifyStore: options.clarifyStore
          })
          return
        }

        try {
          rewritten = validate(modelOutput)
        } catch (error) {
          if (!(error instanceof SqlValidationError)) {
            throw error
          }

          if (attempt < maxSqlGenerationAttempts - 1) {
            retryContext = `${error.code}: ${error.message}`
            continue
          }

          throw error
        }

        try {
          execution = await options.queryExecutor.executeReadOnly(rewritten.sql, rewritten.params)
          break
        } catch (error) {
          if (!isSchemaExecutionError(error)) {
            throw error
          }

          if (attempt < maxSqlGenerationAttempts - 1) {
            retryContext = `DB_EXECUTION_ERROR: ${getDbErrorCode(error) ?? 'UNKNOWN'} ${getDbErrorMessage(error)}`
            continue
          }

          throw error
        }
      }

      if (!rewritten || !execution) {
        throw new Error('query generation failed before execution')
      }

      const hasMore = execution.rows.length > rewritten.displayLimit
      const rows = hasMore ? execution.rows.slice(0, rewritten.displayLimit) : execution.rows

      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const explanationMarkdown = await explainResults({
        llmClient: options.llmClient,
        question: input.question,
        sql: rewritten.sql,
        rows,
        mayBeTruncated: hasMore,
        logger: options.logger
      })

      if (input.mode === 'stateful' && activeSessionId) {
        await options.clarifyStore?.del(activeSessionId)
      }

      res.json({
        status: 'answered',
        sql: rewritten.sql,
        answer: explanationMarkdown,
        data: {
          columns,
          rows,
          page: input.page,
          pageSize: rewritten.displayLimit,
          hasMore,
          rowCountReturned: rows.length
        },
        mayBeTruncated: hasMore,
        sessionId: input.mode === 'stateful' ? activeSessionId : undefined
      })
    } catch (error) {
      if (error instanceof SqlValidationError || isSchemaExecutionError(error)) {
        try {
          const clarifyQuestion = await generateClarifyFallback(options.llmClient, input.question, schemaText)

          await respondWithClarify({
            response: res,
            mode: input.mode,
            statusCode: 422,
            question: clarifyQuestion,
            sessionId: activeSessionId,
            originalQuestion: input.question,
            sessionTtlSec: options.sessionTtlSec,
            clarifyStore: options.clarifyStore
          })
          return
        } catch {
          res.status(422).json({
            error: error instanceof Error ? error.message : 'query failed and clarify generation failed'
          })
          return
        }
      }

      options.logger.error({ error }, 'query pipeline failed')
      res.status(500).json({ error: 'internal server error' })
    } finally {
      options.logger.info(
        {
          durationMs: Date.now() - startMs,
          mode: input.mode,
          page: input.page,
          pageSize: input.pageSize
        },
        'query request processed'
      )
    }
  })

  return router
}
