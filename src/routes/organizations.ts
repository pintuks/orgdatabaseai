import { Router, type Request, type Response } from 'express'
import type { QueryExecutor } from '../db/types'
import type { SchemaSnapshot, SchemaTable } from '../schema/introspect'

type OrganizationsRouterOptions = {
  queryExecutor: QueryExecutor
  schemaRegistry: {
    getSnapshot: () => SchemaSnapshot
  }
  publicAccess: boolean
}

type OrganizationDto = {
  id: string
  name: string
  code?: string
  isActive?: boolean
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function pickOrganizationsTable(snapshot: SchemaSnapshot): SchemaTable | null {
  const candidates = [
    ...(snapshot.byName.get('organizations') ?? []),
    ...(snapshot.byName.get('organization') ?? [])
  ]

  if (candidates.length === 0) {
    return null
  }

  const preferredPublic = candidates.find((table) => table.schema.toLowerCase() === 'public')
  return preferredPublic ?? candidates[0]
}

function hasColumn(table: SchemaTable, column: string): boolean {
  return table.columnsLower.has(column.toLowerCase())
}

function mapOrganizationRow(row: Record<string, unknown>): OrganizationDto {
  const id = typeof row.id === 'string' ? row.id : String(row.id ?? '')
  const name = typeof row.name === 'string' ? row.name : id

  return {
    id,
    name,
    code: typeof row.code === 'string' ? row.code : undefined,
    isActive: typeof row.isActive === 'boolean' ? row.isActive : undefined
  }
}

export function createOrganizationsRouter(options: OrganizationsRouterOptions): Router {
  const router = Router()

  router.get('/', async (req: Request, res: Response) => {
    const snapshot = options.schemaRegistry.getSnapshot()
    const organizationsTable = pickOrganizationsTable(snapshot)

    if (!organizationsTable) {
      res.status(404).json({ error: 'organizations table not found in schema' })
      return
    }

    if (!hasColumn(organizationsTable, 'id')) {
      res.status(500).json({ error: 'organizations table missing id column' })
      return
    }

    const supportsName = hasColumn(organizationsTable, 'name')
    const supportsCode = hasColumn(organizationsTable, 'code')
    const supportsIsActive = hasColumn(organizationsTable, 'isActive')

    const selectColumns = [
      `${quoteIdentifier('id')} AS ${quoteIdentifier('id')}`,
      supportsName
        ? `${quoteIdentifier('name')} AS ${quoteIdentifier('name')}`
        : `${quoteIdentifier('id')} AS ${quoteIdentifier('name')}`,
      supportsCode ? `${quoteIdentifier('code')} AS ${quoteIdentifier('code')}` : null,
      supportsIsActive ? `${quoteIdentifier('isActive')} AS ${quoteIdentifier('isActive')}` : null
    ].filter(Boolean) as string[]

    const tableRef = `${quoteIdentifier(organizationsTable.schema)}.${quoteIdentifier(organizationsTable.name)}`

    const params: unknown[] = []
    const where: string[] = []

    const search = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (search.length > 0 && (supportsName || supportsCode)) {
      params.push(`%${search}%`)
      const token = `$${params.length}`
      const terms: string[] = []
      if (supportsName) {
        terms.push(`${quoteIdentifier('name')} ILIKE ${token}`)
      }
      if (supportsCode) {
        terms.push(`${quoteIdentifier('code')} ILIKE ${token}`)
      }
      where.push(`(${terms.join(' OR ')})`)
    }

    if (!options.publicAccess) {
      if (!req.auth?.orgId) {
        res.status(401).json({ error: 'missing auth context' })
        return
      }
      params.push(req.auth.orgId)
      where.push(`${quoteIdentifier('id')} = $${params.length}`)
    }

    const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200
    const safeLimit = Number.isFinite(limitParam)
      ? Math.max(1, Math.min(500, Math.trunc(limitParam)))
      : 200

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const orderClause = supportsName
      ? `ORDER BY ${quoteIdentifier('name')} ASC`
      : `ORDER BY ${quoteIdentifier('id')} ASC`

    const sql = `
      SELECT ${selectColumns.join(', ')}
      FROM ${tableRef}
      ${whereClause}
      ${orderClause}
      LIMIT ${safeLimit}
    `.trim()

    try {
      const result = await options.queryExecutor.executeReadOnly(sql, params)
      const organizations = result.rows.map(mapOrganizationRow)
      res.json({ organizations })
    } catch (error) {
      res.status(500).json({
        error: 'failed to load organizations',
        detail: error instanceof Error ? error.message : 'unknown error'
      })
    }
  })

  return router
}
