export class SqlValidationError extends Error {
  readonly code: string

  constructor(message: string, code = 'SQL_VALIDATION_ERROR') {
    super(message)
    this.name = 'SqlValidationError'
    this.code = code
  }
}
