import Redis from 'ioredis'
import type { ClarifyState } from '../types/api'

export interface ClarifyStore {
  get(sessionId: string): Promise<ClarifyState | null>
  set(sessionId: string, state: ClarifyState, ttlSec: number): Promise<void>
  del(sessionId: string): Promise<void>
}

export class RedisClarifyStore implements ClarifyStore {
  constructor(private readonly redis: Redis, private readonly keyPrefix = 'nl_sql_clarify') {}

  private key(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}`
  }

  async get(sessionId: string): Promise<ClarifyState | null> {
    const raw = await this.redis.get(this.key(sessionId))
    if (!raw) {
      return null
    }

    try {
      return JSON.parse(raw) as ClarifyState
    } catch {
      return null
    }
  }

  async set(sessionId: string, state: ClarifyState, ttlSec: number): Promise<void> {
    await this.redis.set(this.key(sessionId), JSON.stringify(state), 'EX', ttlSec)
  }

  async del(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId))
  }
}
