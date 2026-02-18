import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createOrganizationsRouter } from '../../src/routes/organizations'
import type { QueryExecutor } from '../../src/db/types'
import type { SchemaSnapshot } from '../../src/schema/introspect'

class SpyExecutor implements QueryExecutor {
  public lastSql = ''
  public lastParams: unknown[] = []

  constructor(private readonly rows: Record<string, unknown>[]) {}

  async executeReadOnly(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.lastSql = sql
    this.lastParams = params
    return { rows: this.rows }
  }
}

function buildSchema(): SchemaSnapshot {
  const columns = ['id', 'name', 'code', 'isActive']
  const table = {
    schema: 'public',
    name: 'organizations',
    key: 'public.organizations',
    isView: false,
    columns,
    columnsLower: new Set(columns.map((c) => c.toLowerCase())),
    columnsByLower: new Map(columns.map((c) => [c.toLowerCase(), c])),
    hasOrganizationId: false
  }

  return {
    dialect: 'PostgreSQL',
    refreshedAtIso: new Date().toISOString(),
    tables: [table],
    byKey: new Map([[table.key, table]]),
    byName: new Map([['organizations', [table]]])
  }
}

describe('GET /v1/organizations', () => {
  it('returns all organizations in public mode', async () => {
    const executor = new SpyExecutor([
      { id: 'o1', name: 'Org A', code: 'A', isActive: true },
      { id: 'o2', name: 'Org B', code: 'B', isActive: false }
    ])

    const app = express()
    app.use(
      '/v1/organizations',
      createOrganizationsRouter({
        queryExecutor: executor,
        schemaRegistry: { getSnapshot: buildSchema },
        publicAccess: true
      })
    )

    const response = await request(app).get('/v1/organizations')

    expect(response.status).toBe(200)
    expect(response.body.organizations).toHaveLength(2)
    expect(executor.lastSql).not.toMatch(/WHERE\s+"id"\s*=\s*\$1/i)
    expect(executor.lastParams).toEqual([])
  })

  it('filters to auth org in private mode', async () => {
    const executor = new SpyExecutor([{ id: 'o1', name: 'Org A', code: 'A', isActive: true }])

    const app = express()
    app.use((req, _res, next) => {
      req.auth = {
        orgId: 'o1',
        subject: 'user_1',
        tokenPayload: {}
      }
      next()
    })

    app.use(
      '/v1/organizations',
      createOrganizationsRouter({
        queryExecutor: executor,
        schemaRegistry: { getSnapshot: buildSchema },
        publicAccess: false
      })
    )

    const response = await request(app).get('/v1/organizations')

    expect(response.status).toBe(200)
    expect(response.body.organizations).toHaveLength(1)
    expect(executor.lastSql).toMatch(/WHERE\s+"id"\s*=\s*\$1/i)
    expect(executor.lastParams).toEqual(['o1'])
  })
})
