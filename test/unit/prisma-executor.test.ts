import { describe, expect, it, vi } from 'vitest'
import { PrismaQueryExecutor } from '../../src/db/prisma-executor'

describe('PrismaQueryExecutor', () => {
  it('runs inside read-only transaction', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1)
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'u1' }])

    const prisma = {
      $transaction: async <T>(fn: (tx: any) => Promise<T>) => {
        return fn({
          $executeRawUnsafe: executeRaw,
          $queryRawUnsafe: queryRaw
        })
      }
    }

    const executor = new PrismaQueryExecutor(prisma)
    const result = await executor.executeReadOnly('SELECT id FROM users LIMIT 1', [])

    expect(executeRaw).toHaveBeenCalledWith('SET TRANSACTION READ ONLY')
    expect(queryRaw).toHaveBeenCalledWith('SELECT id FROM users LIMIT 1')
    expect(result.rows).toEqual([{ id: 'u1' }])
  })

  it('rejects mutating SQL before execution', async () => {
    const prisma = {
      $transaction: async <T>(fn: (tx: any) => Promise<T>) => {
        return fn({
          $executeRawUnsafe: vi.fn().mockResolvedValue(1),
          $queryRawUnsafe: vi.fn().mockResolvedValue([])
        })
      }
    }

    const executor = new PrismaQueryExecutor(prisma)
    await expect(executor.executeReadOnly('UPDATE users SET email = \'x\'', [])).rejects.toThrow(
      /Disallowed SQL keyword/i
    )
  })
})
