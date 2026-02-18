import type { Pool } from 'pg'

export type SchemaTable = {
  schema: string
  name: string
  key: string
  isView: boolean
  columns: string[]
  columnsLower: Set<string>
  columnsByLower: Map<string, string>
  hasOrganizationId: boolean
}

export type SchemaSnapshot = {
  dialect: 'PostgreSQL'
  refreshedAtIso: string
  tables: SchemaTable[]
  byKey: Map<string, SchemaTable>
  byName: Map<string, SchemaTable[]>
}

const normalize = (value: string) => value.replace(/"/g, '').trim().toLowerCase()

export function formatSchemaForPrompt(snapshot: SchemaSnapshot): string {
  const viewLines: string[] = []
  const tableLines: string[] = []

  for (const table of snapshot.tables) {
    const line = `${table.schema}.${table.name} (${table.columns.join(', ')})`
    if (table.isView) {
      viewLines.push(line)
    } else {
      tableLines.push(line)
    }
  }

  const ordered = [...viewLines, ...tableLines]
  return ordered.join('\n')
}

export function resolveTable(snapshot: SchemaSnapshot, tableName: string, schemaName?: string): SchemaTable | null {
  const normalizedTable = normalize(tableName)

  if (schemaName) {
    const key = `${normalize(schemaName)}.${normalizedTable}`
    return snapshot.byKey.get(key) ?? null
  }

  const candidates = snapshot.byName.get(normalizedTable) ?? []
  if (candidates.length === 0) {
    return null
  }

  if (candidates.length === 1) {
    return candidates[0]
  }

  const preferredPublic = candidates.find((candidate) => normalize(candidate.schema) === 'public')
  return preferredPublic ?? null
}

export function canonicalColumnName(table: SchemaTable, normalizedColumnName: string): string | null {
  return table.columnsByLower.get(normalizedColumnName) ?? null
}

export async function introspectSchema(pool: Pool): Promise<SchemaSnapshot> {
  const tableResult = await pool.query<{
    table_schema: string
    table_name: string
    table_type: string
  }>(`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name
  `)

  const columnResult = await pool.query<{
    table_schema: string
    table_name: string
    column_name: string
    ordinal_position: number
  }>(`
    SELECT table_schema, table_name, column_name, ordinal_position
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `)

  const columnsByTable = new Map<string, string[]>()

  for (const row of columnResult.rows) {
    const key = `${normalize(row.table_schema)}.${normalize(row.table_name)}`
    if (!columnsByTable.has(key)) {
      columnsByTable.set(key, [])
    }
    columnsByTable.get(key)?.push(row.column_name)
  }

  const tables: SchemaTable[] = tableResult.rows.map((row) => {
    const key = `${normalize(row.table_schema)}.${normalize(row.table_name)}`
    const columns = columnsByTable.get(key) ?? []
    const columnsLower = new Set(columns.map((column) => normalize(column)))
    const columnsByLower = new Map<string, string>()
    for (const column of columns) {
      columnsByLower.set(normalize(column), column)
    }

    return {
      schema: row.table_schema,
      name: row.table_name,
      key,
      isView: row.table_type.toUpperCase() === 'VIEW',
      columns,
      columnsLower,
      columnsByLower,
      hasOrganizationId: columnsLower.has('organizationid')
    }
  })

  const byKey = new Map<string, SchemaTable>()
  const byName = new Map<string, SchemaTable[]>()

  for (const table of tables) {
    byKey.set(table.key, table)
    const bare = normalize(table.name)
    if (!byName.has(bare)) {
      byName.set(bare, [])
    }
    byName.get(bare)?.push(table)
  }

  return {
    dialect: 'PostgreSQL',
    refreshedAtIso: new Date().toISOString(),
    tables,
    byKey,
    byName
  }
}
