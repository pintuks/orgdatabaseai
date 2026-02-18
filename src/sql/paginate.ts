import { SqlValidationError } from './errors'

type AstLimit = {
  seperator?: string
  value?: Array<{ type?: string; value?: number | string }>
} | null

export type PaginationRewriteResult = {
  displayLimit: number
  fetchLimit: number
}

function toInteger(value: unknown): number | null {
  const numberValue = typeof value === 'string' ? Number(value) : value
  if (typeof numberValue !== 'number' || !Number.isFinite(numberValue)) {
    return null
  }

  const int = Math.trunc(numberValue)
  return int
}

export function applyPagination(
  ast: Record<string, unknown>,
  page: number,
  pageSize: number,
  hardCap: number
): PaginationRewriteResult {
  const limitNode = (ast.limit as AstLimit) ?? null

  if (limitNode?.seperator === 'offset' && (limitNode.value?.length ?? 0) > 1) {
    throw new SqlValidationError('Model-generated OFFSET is not allowed', 'SQL_OFFSET_NOT_ALLOWED')
  }

  let modelLimit: number | null = null

  if (limitNode?.value?.[0]) {
    if (limitNode.value[0].type !== 'number') {
      throw new SqlValidationError('LIMIT must be a numeric literal', 'SQL_LIMIT_NOT_NUMERIC')
    }

    modelLimit = toInteger(limitNode.value[0].value)
    if (!modelLimit || modelLimit <= 0) {
      throw new SqlValidationError('LIMIT must be greater than zero', 'SQL_LIMIT_INVALID')
    }
  }

  const displayLimit = Math.min(modelLimit ?? pageSize, pageSize, hardCap)
  if (displayLimit <= 0) {
    throw new SqlValidationError('Effective LIMIT must be greater than zero', 'SQL_LIMIT_INVALID')
  }

  const offset = (page - 1) * displayLimit
  const fetchLimit = displayLimit + 1

  ast.limit = {
    seperator: 'offset',
    value: [
      { type: 'number', value: fetchLimit },
      { type: 'number', value: offset }
    ]
  }

  return {
    displayLimit,
    fetchLimit
  }
}
