import type { SchemaSnapshot, SchemaTable } from '../../src/schema/introspect'

function makeTable(schema: string, name: string, isView: boolean, columns: string[]): SchemaTable {
  const columnsByLower = new Map<string, string>()
  for (const column of columns) {
    columnsByLower.set(column.toLowerCase(), column)
  }

  return {
    schema,
    name,
    key: `${schema.toLowerCase()}.${name.toLowerCase()}`,
    isView,
    columns,
    columnsLower: new Set(columns.map((column) => column.toLowerCase())),
    columnsByLower,
    hasOrganizationId: columns.map((column) => column.toLowerCase()).includes('organizationid')
  }
}

export function buildTestSchemaSnapshot(): SchemaSnapshot {
  const tables = [
    makeTable('public', 'users', false, ['id', 'name', 'organizationId', 'password']),
    makeTable('public', 'payments', false, ['id', 'userId', 'amount', 'organizationId'])
  ]

  const byKey = new Map<string, SchemaTable>()
  const byName = new Map<string, SchemaTable[]>()

  for (const table of tables) {
    byKey.set(table.key, table)

    const key = table.name.toLowerCase()
    if (!byName.has(key)) {
      byName.set(key, [])
    }
    byName.get(key)?.push(table)
  }

  return {
    dialect: 'PostgreSQL',
    refreshedAtIso: new Date().toISOString(),
    tables,
    byKey,
    byName
  }
}
