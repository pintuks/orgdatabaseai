import express from 'express'
import request from 'supertest'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createQueryRouter } from '../../src/routes/query'
import type { LlmClient } from '../../src/llm/fastrouter-client'
import type { QueryExecutor } from '../../src/db/types'
import { buildTestSchemaSnapshot } from '../helpers/schema'

class FakeLlm implements LlmClient {
  private index = 0

  constructor(private readonly outputs: string[]) {}

  async chat(): Promise<string> {
    const output = this.outputs[this.index]
    this.index += 1
    return output ?? 'CLARIFY: Could you provide more detail?'
  }
}

class FakeExecutor implements QueryExecutor {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  async executeReadOnly(): Promise<{ rows: Record<string, unknown>[] }> {
    return { rows: this.rows }
  }
}

class FailingExecutor implements QueryExecutor {
  async executeReadOnly(): Promise<{ rows: Record<string, unknown>[] }> {
    const error = new Error('column does not exist') as Error & { code: string }
    error.code = '42703'
    throw error
  }
}

function buildApp(llmOutputs: string[], rows: Record<string, unknown>[] = []) {
  const app = express()
  app.use(express.json())

  app.use((req, _res, next) => {
    req.auth = {
      orgId: 'org_1',
      subject: 'user_1',
      tokenPayload: {}
    }
    next()
  })

  app.use(
    '/v1/query',
    createQueryRouter({
      llmClient: new FakeLlm(llmOutputs),
      schemaRegistry: {
        getSnapshot: () => buildTestSchemaSnapshot()
      },
      queryExecutor: new FakeExecutor(rows),
      logger: pino({ enabled: false }),
      hardRowCap: 100,
      enableStatefulClarify: true,
      sessionTtlSec: 900
    })
  )

  return app
}

describe('POST /v1/query', () => {
  it('returns clarify when model requests clarification', async () => {
    const app = buildApp(['CLARIFY: Which date range should I use?'])

    const response = await request(app).post('/v1/query').send({
      question: 'show recent payments'
    })

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('clarify')
    expect(response.body.question).toBe('Which date range should I use?')
  })

  it('returns answered response with paginated rows', async () => {
    const app = buildApp(
      [
        'SELECT u.id, u.name FROM users u ORDER BY u.id',
        'Found 2 matching users.'
      ],
      [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'u3', name: 'Cara' }
      ]
    )

    const response = await request(app).post('/v1/query').send({
      question: 'list users',
      page: 1,
      pageSize: 2
    })

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('answered')
    expect(response.body.answer).toBe('Found 2 matching users.')
    expect(response.body.data.rows).toHaveLength(2)
    expect(response.body.data.hasMore).toBe(true)
    expect(response.body.mayBeTruncated).toBe(true)
    expect(response.body.sql).toMatch(/"organizationId"\s*=\s*\$1/i)
  })

  it('returns clarify instead of 500 on schema execution error', async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.auth = {
        orgId: 'org_1',
        subject: 'user_1',
        tokenPayload: {}
      }
      next()
    })

    app.use(
      '/v1/query',
      createQueryRouter({
        llmClient: new FakeLlm([
          'SELECT u.id FROM users u LIMIT 3',
          'SELECT u.id FROM users u LIMIT 3',
          'CLARIFY: Which fields should be included exactly?'
        ]),
        schemaRegistry: {
          getSnapshot: () => buildTestSchemaSnapshot()
        },
        queryExecutor: new FailingExecutor(),
        logger: pino({ enabled: false }),
        hardRowCap: 100,
        enableStatefulClarify: true,
        sessionTtlSec: 900
      })
    )

    const response = await request(app).post('/v1/query').send({
      question: 'list users',
      page: 1,
      pageSize: 2
    })

    expect(response.status).toBe(422)
    expect(response.body.status).toBe('clarify')
    expect(response.body.question).toBe('Which fields should be included exactly?')
  })
})
