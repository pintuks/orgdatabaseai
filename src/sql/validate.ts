import SqlParser from 'node-sql-parser'
import type { SchemaSnapshot, SchemaTable } from '../schema/introspect'
import { canonicalColumnName, resolveTable } from '../schema/introspect'
import { SqlValidationError } from './errors'
import { applyTenantFilter } from './tenant-enforce'
import { applyPagination } from './paginate'
import { assertReadOnlySqlTokens } from './read-only-safety'
import { toAstIdentifier } from './identifiers'

const parser = new SqlParser.Parser()

const sensitiveColumnPattern =
  /(password|token|secret|apikey|api_key|refresh|salt|hash|credential|ssn|aadhaar|pan)/i

const normalize = (value: string) => value.replace(/"/g, '').trim().toLowerCase()

type RewriteInput = {
  sql: string
  schemaSnapshot: SchemaSnapshot
  orgId: string
  page: number
  pageSize: number
  hardCap: number
}

export type RewriteOutput = {
  sql: string
  params: unknown[]
  displayLimit: number
  fetchLimit: number
  referencedTables: string[]
}

type SelectAst = Record<string, unknown>

function walk(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') {
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor)
    }
    return
  }

  const node = value as Record<string, unknown>
  visitor(node)

  for (const nested of Object.values(node)) {
    walk(nested, visitor)
  }
}

function extractColumnName(columnNode: unknown): string | null {
  if (typeof columnNode === 'string') {
    return columnNode
  }

  if (!columnNode || typeof columnNode !== 'object') {
    return null
  }

  const maybeExpr = (columnNode as Record<string, unknown>).expr
  if (maybeExpr && typeof maybeExpr === 'object') {
    const value = (maybeExpr as Record<string, unknown>).value
    if (typeof value === 'string') {
      return value
    }
  }

  return null
}

function setColumnName(node: Record<string, unknown>, columnName: string): void {
  node.column = {
    expr: {
      type: 'default',
      value: toAstIdentifier(columnName)
    }
  }
}

function ensureNoUnsafeTokens(sql: string): void {
  assertReadOnlySqlTokens(sql)
}

function parseSelectAst(sql: string): SelectAst {
  let ast: unknown

  try {
    ast = parser.astify(sql, {
      database: 'Postgresql'
    })
  } catch (error) {
    throw new SqlValidationError(`Failed to parse SQL: ${(error as Error).message}`, 'SQL_PARSE_ERROR')
  }

  if (Array.isArray(ast)) {
    throw new SqlValidationError('Multiple SQL statements are not allowed', 'SQL_MULTI_STATEMENT')
  }

  if (!ast || typeof ast !== 'object' || (ast as Record<string, unknown>).type !== 'select') {
    throw new SqlValidationError('Only SELECT statements are allowed', 'SQL_NOT_SELECT')
  }

  const selectAst = ast as SelectAst

  if (selectAst.with) {
    throw new SqlValidationError('CTEs are not supported in safe mode', 'SQL_CTE_NOT_SUPPORTED')
  }

  const into = selectAst.into as Record<string, unknown> | null | undefined
  if (into && typeof into === 'object' && into.position) {
    throw new SqlValidationError('SELECT INTO is not allowed', 'SQL_SELECT_INTO_NOT_ALLOWED')
  }

  return selectAst
}

type ReferencedTable = {
  alias: string
  meta: SchemaTable
  joinType: string | null
}

function ensureSupportedJoinType(joinType: string): void {
  const normalizedJoin = joinType.trim().toUpperCase()
  if (
    normalizedJoin.includes('RIGHT') ||
    normalizedJoin.includes('FULL') ||
    normalizedJoin.includes('CROSS') ||
    normalizedJoin.includes('NATURAL')
  ) {
    throw new SqlValidationError(`Join type is not supported in safe mode: ${joinType}`, 'SQL_JOIN_UNSUPPORTED')
  }
}

function resolveReferencedTables(ast: SelectAst, snapshot: SchemaSnapshot): ReferencedTable[] {
  const from = ast.from
  if (!from) {
    return []
  }

  if (!Array.isArray(from)) {
    throw new SqlValidationError('Unsupported FROM clause shape', 'SQL_FROM_UNSUPPORTED')
  }

  const referenced: ReferencedTable[] = []

  for (const item of from) {
    if (!item || typeof item !== 'object') {
      throw new SqlValidationError('Unsupported FROM clause item', 'SQL_FROM_UNSUPPORTED')
    }

    const node = item as Record<string, unknown>

    if (node.expr) {
      throw new SqlValidationError('Subqueries in FROM are not supported in safe mode', 'SQL_SUBQUERY_NOT_SUPPORTED')
    }

    const tableName = typeof node.table === 'string' ? node.table : null
    const schemaName = typeof node.db === 'string' ? node.db : undefined
    const joinType = typeof node.join === 'string' ? node.join : null

    if (!tableName) {
      throw new SqlValidationError('Missing table name in FROM clause', 'SQL_TABLE_MISSING')
    }

    if (joinType) {
      ensureSupportedJoinType(joinType)
    }

    const tableMeta = resolveTable(snapshot, tableName, schemaName)
    if (!tableMeta) {
      const fq = schemaName ? `${schemaName}.${tableName}` : tableName
      throw new SqlValidationError(`Unknown table reference: ${fq}`, 'SQL_TABLE_UNKNOWN')
    }

    const alias = typeof node.as === 'string' && node.as.trim().length > 0 ? node.as : tableName
    referenced.push({ alias, meta: tableMeta, joinType })
  }

  return referenced
}

function validateColumns(ast: SelectAst, referencedTables: ReferencedTable[]): void {
  const selectAliases = new Set<string>()
  const columns = ast.columns

  if (Array.isArray(columns)) {
    for (const col of columns) {
      if (col && typeof col === 'object') {
        const alias = (col as Record<string, unknown>).as
        if (typeof alias === 'string') {
          selectAliases.add(normalize(alias))
        }
      }
    }
  }

  const aliasToTable = new Map<string, SchemaTable>()
  const tableNameToAliases = new Map<string, string[]>()

  for (const table of referencedTables) {
    aliasToTable.set(normalize(table.alias), table.meta)

    const normalizedTableName = normalize(table.meta.name)
    if (!tableNameToAliases.has(normalizedTableName)) {
      tableNameToAliases.set(normalizedTableName, [])
    }

    tableNameToAliases.get(normalizedTableName)?.push(table.alias)
  }

  walk(ast, (node) => {
    if (node.type === 'var') {
      throw new SqlValidationError('Pre-existing query parameters are not allowed', 'SQL_PARAMETER_NOT_ALLOWED')
    }

    if (node.type !== 'column_ref') {
      return
    }

    const rawColumnName = extractColumnName(node.column)
    if (!rawColumnName) {
      throw new SqlValidationError('Unsupported column reference shape', 'SQL_COLUMN_UNSUPPORTED')
    }

    if (rawColumnName === '*') {
      throw new SqlValidationError('SELECT * is not allowed; select explicit columns', 'SQL_WILDCARD_NOT_ALLOWED')
    }

    const columnName = normalize(rawColumnName)

    if (sensitiveColumnPattern.test(columnName)) {
      throw new SqlValidationError(`Sensitive column usage is not allowed: ${rawColumnName}`, 'SQL_SENSITIVE_COLUMN')
    }

    const tableToken = typeof node.table === 'string' ? normalize(node.table) : null

    if (tableToken) {
      let tableMeta = aliasToTable.get(tableToken)
      if (!tableMeta) {
        const aliases = tableNameToAliases.get(tableToken) ?? []
        if (aliases.length === 1) {
          tableMeta = aliasToTable.get(normalize(aliases[0]))
        }
      }

      if (!tableMeta) {
        throw new SqlValidationError(`Unknown table or alias reference: ${String(node.table)}`, 'SQL_TABLE_ALIAS_UNKNOWN')
      }

      if (!tableMeta.columnsLower.has(columnName)) {
        throw new SqlValidationError(
          `Unknown column ${rawColumnName} on table ${tableMeta.schema}.${tableMeta.name}`,
          'SQL_COLUMN_UNKNOWN'
        )
      }

      const canonical = canonicalColumnName(tableMeta, columnName)
      if (canonical) {
        setColumnName(node, canonical)
      }

      return
    }

    if (selectAliases.has(columnName)) {
      return
    }

    if (referencedTables.length === 0) {
      throw new SqlValidationError(`Column ${rawColumnName} has no source table`, 'SQL_COLUMN_NO_SOURCE')
    }

    const candidateTables = referencedTables.filter((table) => table.meta.columnsLower.has(columnName))

    if (candidateTables.length === 0) {
      throw new SqlValidationError(`Unknown column reference: ${rawColumnName}`, 'SQL_COLUMN_UNKNOWN')
    }

    if (candidateTables.length > 1) {
      throw new SqlValidationError(
        `Ambiguous column reference: ${rawColumnName}; use table alias`,
        'SQL_COLUMN_AMBIGUOUS'
      )
    }

    const canonical = canonicalColumnName(candidateTables[0].meta, columnName)
    if (canonical) {
      setColumnName(node, canonical)
    }
  })
}

function toReferencedTableNames(tables: ReferencedTable[]): string[] {
  return Array.from(new Set(tables.map((table) => `${table.meta.schema}.${table.meta.name}`)))
}

export function validateAndRewriteSql(input: RewriteInput): RewriteOutput {
  const rawSql = input.sql.trim()

  ensureNoUnsafeTokens(rawSql)

  const ast = parseSelectAst(rawSql)
  const referencedTables = resolveReferencedTables(ast, input.schemaSnapshot)

  validateColumns(ast, referencedTables)

  const tenantTargets = referencedTables
    .filter((table) => table.meta.hasOrganizationId)
    .map((table) => ({
      alias: table.alias,
      columnName: canonicalColumnName(table.meta, 'organizationid') ?? 'organizationId',
      joinType: table.joinType
    }))

  const params: unknown[] = []
  if (tenantTargets.length > 0) {
    applyTenantFilter(ast, tenantTargets, 1)
    params.push(input.orgId)
  }

  const pagination = applyPagination(ast, input.page, input.pageSize, input.hardCap)

  const rewrittenSql = parser.sqlify(ast as any, {
    database: 'Postgresql'
  })

  ensureNoUnsafeTokens(rewrittenSql)

  return {
    sql: rewrittenSql,
    params,
    displayLimit: pagination.displayLimit,
    fetchLimit: pagination.fetchLimit,
    referencedTables: toReferencedTableNames(referencedTables)
  }
}
