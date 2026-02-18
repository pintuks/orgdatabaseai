import type { Logger } from 'pino'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmClient {
  chat(messages: ChatMessage[], temperature?: number): Promise<string>
}

type OpenAiLikeResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>
    }
  }>
}

type FastRouterClientOptions = {
  timeoutMs: number
  maxRetries: number
  retryBaseMs: number
}

const retryableStatusCodes = new Set([408, 409, 425, 429, 500, 502, 503, 504])

class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message)
    this.name = 'LlmRequestError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export class FastRouterClient implements LlmClient {
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryBaseMs: number

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly logger: Logger,
    options?: Partial<FastRouterClientOptions>
  ) {
    this.timeoutMs = options?.timeoutMs ?? 20000
    this.maxRetries = options?.maxRetries ?? 2
    this.retryBaseMs = options?.retryBaseMs ?? 250
  }

  private toBackoffDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt)
    const baseDelay = this.retryBaseMs * 2 ** exponent
    const jitter = Math.floor(Math.random() * this.retryBaseMs)
    return baseDelay + jitter
  }

  private shouldRetryStatus(status: number): boolean {
    return retryableStatusCodes.has(status)
  }

  private normalizeResponseContent(data: OpenAiLikeResponse): string {
    const content = data.choices?.[0]?.message?.content

    if (typeof content === 'string') {
      return content.trim()
    }

    if (Array.isArray(content)) {
      const merged = content.map((part) => part.text ?? '').join('').trim()
      if (merged) {
        return merged
      }
    }

    throw new LlmRequestError('LLM response did not include message content', false)
  }

  async chat(messages: ChatMessage[], temperature = 0): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`
    const payload = {
      model: this.model,
      temperature,
      messages
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const requestNumber = attempt + 1
      const controller = new AbortController()
      const timeoutHandle = setTimeout(() => {
        controller.abort()
      }, this.timeoutMs)

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        })

        if (!response.ok) {
          const body = await response.text()
          const error = new LlmRequestError(
            `LLM request failed with status ${response.status}`,
            this.shouldRetryStatus(response.status),
            response.status
          )

          if (!error.retryable || attempt >= this.maxRetries) {
            this.logger.error({ status: response.status, body, attempt: requestNumber }, 'llm request failed')
            throw error
          }

          this.logger.warn(
            { status: response.status, body, attempt: requestNumber, maxRetries: this.maxRetries },
            'llm request failed, retrying'
          )
          await sleep(this.toBackoffDelayMs(attempt))
          continue
        }

        const data = (await response.json()) as OpenAiLikeResponse
        return this.normalizeResponseContent(data)
      } catch (error) {
        const retryable =
          error instanceof LlmRequestError ? error.retryable : isAbortError(error) || error instanceof TypeError

        if (!retryable || attempt >= this.maxRetries) {
          throw error instanceof Error ? error : new Error('LLM request failed')
        }

        this.logger.warn(
          {
            attempt: requestNumber,
            maxRetries: this.maxRetries,
            timeoutMs: this.timeoutMs,
            error: error instanceof Error ? error.message : String(error)
          },
          'llm request failed with transient error, retrying'
        )
        await sleep(this.toBackoffDelayMs(attempt))
      } finally {
        clearTimeout(timeoutHandle)
      }
    }

    throw new Error('LLM request failed after retries')
  }
}
