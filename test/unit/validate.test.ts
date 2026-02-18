import { describe, expect, it } from 'vitest'
import { validateAndRewriteSql } from '../../src/sql/validate'
import { SqlValidationError } from '../../src/sql/errors'
import { buildTestSchemaSnapshot } from '../helpers/schema'

const schemaSnapshot = buildTestSchemaSnapshot()

describe('validateAndRewriteSql', () => {
  it('injects tenant filter and pagination', () => {
    const result = validateAndRewriteSql({
      sql: 'SELECT u.id, u.name FROM users u ORDER BY u.id',
      schemaSnapshot,
      orgId: 'org_1',
      page: 1,
      pageSize: 2,
      hardCap: 100
    })

    expect(result.params).toEqual(['org_1'])
    expect(result.displayLimit).toBe(2)
    expect(result.fetchLimit).toBe(3)
    expect(result.sql).toMatch(/"organizationId"\s*=\s*\$1/i)
    expect(result.sql).toMatch(/LIMIT\s+3/i)
    expect(result.sql).toMatch(/OFFSET\s+0/i)
  })

  it('canonicalizes column casing to schema names', () => {
    const result = validateAndRewriteSql({
      sql: 'SELECT u.organizationid FROM users u ORDER BY u.organizationid',
      schemaSnapshot,
      orgId: 'org_1',
      page: 1,
      pageSize: 5,
      hardCap: 100
    })

    expect(result.sql).toMatch(/"organizationId"/)
    expect(result.sql).not.toMatch(/organizationid/)
  })

  it('keeps left join optional rows by applying joined tenant filter in ON', () => {
    const result = validateAndRewriteSql({
      sql: 'SELECT u.id, p.amount FROM users u LEFT JOIN payments p ON p.userId = u.id ORDER BY u.id',
      schemaSnapshot,
      orgId: 'org_1',
      page: 1,
      pageSize: 10,
      hardCap: 100
    })

    expect(result.sql).toMatch(/LEFT JOIN\s+"payments"\s+AS\s+"p"\s+ON[\s\S]*"p"\."organizationId"\s*=\s*\$1/i)
    expect(result.sql).toMatch(/WHERE[\s\S]*"u"\."organizationId"\s*=\s*\$1/i)

    const [, wherePart = ''] = result.sql.split(/\bWHERE\b/i)
    expect(wherePart).not.toMatch(/"p"\."organizationId"\s*=\s*\$1/i)
  })

  it('rejects SELECT *', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT * FROM users',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(SqlValidationError)
  })

  it('rejects sensitive columns', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT u.password FROM users u',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/Sensitive column usage/i)
  })

  it('rejects semicolons', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT id FROM users;',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/Semicolons are not allowed/i)
  })

  it('rejects unknown table', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT x.id FROM x_table x',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/Unknown table reference/i)
  })

  it('rejects unsupported join types', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT p.id FROM users u RIGHT JOIN payments p ON p.userId = u.id',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/Join type is not supported in safe mode/i)
  })

  it('rejects model-generated offset', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT u.id FROM users u LIMIT 10 OFFSET 20',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/OFFSET is not allowed/i)
  })

  it('rejects select into', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: 'SELECT u.id INTO tmp_users FROM users u',
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/SELECT INTO is not allowed/i)
  })

  it('rejects side-effect functions', () => {
    expect(() =>
      validateAndRewriteSql({
        sql: "SELECT nextval('public.seq_users') FROM users",
        schemaSnapshot,
        orgId: 'org_1',
        page: 1,
        pageSize: 25,
        hardCap: 100
      })
    ).toThrow(/Side-effect SQL functions are not allowed/i)
  })
})
