import type { Pool } from 'pg'
import type { QueryExecutor, QueryResultRows } from './types'
import { assertReadOnlySqlTokens } from '../sql/read-only-safety'

export class PgQueryExecutor implements QueryExecutor {
  constructor(
    private readonly pool: Pool,
    private readonly statementTimeoutMs: number
  ) {}

  async executeReadOnly(sql: string, params: unknown[]): Promise<QueryResultRows> {
    assertReadOnlySqlTokens(sql)

    const client = await this.pool.connect()

    try {
      await client.query('BEGIN READ ONLY')
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`)
      const result = await client.query(sql, params)
      await client.query('COMMIT')
      return { rows: result.rows as Record<string, unknown>[] }
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // ignore rollback failures
      }
      throw error
    } finally {
      client.release()
    }
  }
}
