import { toAstIdentifier } from './identifiers'

export type TenantTarget = {
  alias: string
  columnName: string
  joinType: string | null
}

type SqlExpression = Record<string, unknown>
type FromNode = Record<string, unknown>

const normalize = (value: string) => value.replace(/"/g, '').trim().toLowerCase()

function columnRef(tableAlias: string, columnName: string): SqlExpression {
  return {
    type: 'column_ref',
    table: tableAlias,
    column: {
      expr: {
        type: 'default',
        value: toAstIdentifier(columnName)
      }
    },
    collate: null
  }
}

function orgParamExpression(paramIndex: number): SqlExpression {
  return {
    type: 'var',
    name: paramIndex,
    members: [],
    quoted: null,
    prefix: '$'
  }
}

function eq(left: SqlExpression, right: SqlExpression): SqlExpression {
  return {
    type: 'binary_expr',
    operator: '=',
    left,
    right
  }
}

function and(left: SqlExpression, right: SqlExpression): SqlExpression {
  return {
    type: 'binary_expr',
    operator: 'AND',
    left,
    right
  }
}

function resolveAlias(fromNode: FromNode): string | null {
  const alias = typeof fromNode.as === 'string' && fromNode.as.trim().length > 0 ? fromNode.as : fromNode.table
  return typeof alias === 'string' ? alias : null
}

function attachToJoinOn(fromNode: FromNode, condition: SqlExpression): void {
  const existingOn = (fromNode.on as SqlExpression | null | undefined) ?? null
  fromNode.on = existingOn ? and(existingOn, condition) : condition
}

export function applyTenantFilter(ast: Record<string, unknown>, tenantTargets: TenantTarget[], paramIndex: number): boolean {
  if (tenantTargets.length === 0) {
    return false
  }

  const fromNodes = Array.isArray(ast.from) ? (ast.from as FromNode[]) : []
  const fromByAlias = new Map<string, FromNode>()
  for (const fromNode of fromNodes) {
    if (!fromNode || typeof fromNode !== 'object') {
      continue
    }

    const alias = resolveAlias(fromNode)
    if (!alias) {
      continue
    }

    fromByAlias.set(normalize(alias), fromNode)
  }

  const dedupedTargets = Array.from(
    new Map(tenantTargets.map((target) => [target.alias.toLowerCase(), target])).values()
  )
  const whereConditions: SqlExpression[] = []

  for (const target of dedupedTargets) {
    const condition = eq(columnRef(target.alias, target.columnName), orgParamExpression(paramIndex))
    if (target.joinType) {
      const fromNode = fromByAlias.get(normalize(target.alias))
      if (fromNode) {
        attachToJoinOn(fromNode, condition)
        continue
      }
    }

    whereConditions.push(condition)
  }

  if (whereConditions.length === 0) {
    return true
  }

  let combined = whereConditions[0]
  for (let i = 1; i < whereConditions.length; i += 1) {
    combined = and(combined, whereConditions[i])
  }

  const existingWhere = (ast.where as SqlExpression | null | undefined) ?? null
  ast.where = existingWhere ? and(existingWhere, combined) : combined

  return true
}
