import { SqlValidationError } from './errors'

const disallowedKeywordPattern =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|exec|execute|copy|call|do|merge|replace|upsert|vacuum|analyze|reindex|cluster|discard|checkpoint)\b/i
const rowLockPattern = /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i
const sideEffectFunctionPattern = /\b(nextval|setval|pg_advisory_lock|pg_advisory_xact_lock|pg_sleep)\s*\(/i
const sqlCommentPattern = /--|\/\*/

export function assertReadOnlySqlTokens(sql: string): void {
  if (sql.includes(';')) {
    throw new SqlValidationError('Semicolons are not allowed', 'SQL_SEMICOLON_NOT_ALLOWED')
  }

  if (sqlCommentPattern.test(sql)) {
    throw new SqlValidationError('SQL comments are not allowed', 'SQL_COMMENTS_NOT_ALLOWED')
  }

  if (disallowedKeywordPattern.test(sql)) {
    throw new SqlValidationError('Disallowed SQL keyword found', 'SQL_DISALLOWED_KEYWORD')
  }

  if (rowLockPattern.test(sql)) {
    throw new SqlValidationError('Row-level locking clauses are not allowed', 'SQL_ROW_LOCK_NOT_ALLOWED')
  }

  if (sideEffectFunctionPattern.test(sql)) {
    throw new SqlValidationError('Side-effect SQL functions are not allowed', 'SQL_SIDE_EFFECT_FUNCTION')
  }
}
