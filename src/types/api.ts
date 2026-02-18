import { z } from 'zod'

export const queryRequestSchema = z.object({
  question: z.string().trim().min(1, 'question is required'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  mode: z.enum(['stateless', 'stateful']).default('stateless'),
  sessionId: z.string().trim().min(1).optional(),
  clarificationAnswer: z.string().trim().min(1).optional()
})

export type QueryRequest = z.infer<typeof queryRequestSchema>

export type ClarifyResponse = {
  status: 'clarify'
  question: string
  sessionId?: string
}

export type AnsweredResponse = {
  status: 'answered'
  sql: string
  answer: string
  data: {
    columns: string[]
    rows: Record<string, unknown>[]
    page: number
    pageSize: number
    hasMore: boolean
    rowCountReturned: number
  }
  mayBeTruncated: boolean
  sessionId?: string
}

export type QueryResponse = ClarifyResponse | AnsweredResponse

export type ClarifyState = {
  originalQuestion: string
  pendingClarifyQuestion: string
  createdAtIso: string
}
