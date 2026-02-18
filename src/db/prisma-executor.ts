import type { QueryExecutor, QueryResultRows } from './types'
import { assertReadOnlySqlTokens } from '../sql/read-only-safety'

type PrismaLikeClient = {
  $transaction: <T>(fn: (tx: PrismaTransactionClient) => Promise<T>) => Promise<T>
}

type PrismaTransactionClient = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>
}

export class PrismaQueryExecutor implements QueryExecutor {
  constructor(private readonly prisma: PrismaLikeClient) {}

  async executeReadOnly(sql: string, params: unknown[]): Promise<QueryResultRows> {
    assertReadOnlySqlTokens(sql)

    const response = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      return tx.$queryRawUnsafe(sql, ...params)
    })

    if (!Array.isArray(response)) {
      throw new Error('Prisma adapter expected row-array result')
    }

    return { rows: response as Record<string, unknown>[] }
  }
}
