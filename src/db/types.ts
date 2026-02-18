export type QueryResultRows = {
  rows: Record<string, unknown>[]
}

export interface QueryExecutor {
  executeReadOnly(sql: string, params: unknown[]): Promise<QueryResultRows>
}
