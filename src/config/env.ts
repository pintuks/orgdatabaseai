import { z } from 'zod'

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false
    }
  }

  return value
}, z.boolean())

const numberFromEnv = (defaultValue: number, min = 1, max?: number) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') {
      return defaultValue
    }

    if (typeof value === 'string') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : value
    }

    return value
  },
  max === undefined
    ? z.number().int().min(min)
    : z.number().int().min(min).max(max))

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: numberFromEnv(3000, 1, 65535),

  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1).optional(),

  FASTROUTER_API_KEY: z.string().min(1),
  FASTROUTER_BASE_URL: z.string().url(),
  OPENAI_MODEL: z.string().min(1).optional(),
  FASTROUTER_MODEL: z.string().min(1).optional(),

  JWT_JWKS_URL: z.string().url().optional(),
  JWT_ISSUER: z.string().min(1).optional(),
  JWT_AUDIENCE: z.string().min(1).optional(),
  JWT_ORG_CLAIM: z.string().min(1).default('organizationId'),
  DEV_AUTH_BYPASS: booleanFromEnv.default(false),

  REDIS_URL: z.string().url().optional(),
  ENABLE_STATEFUL_CLARIFY: booleanFromEnv.default(true),
  SESSION_TTL_SEC: numberFromEnv(900, 60),

  QUERY_TIMEOUT_MS: numberFromEnv(5000, 100, 60000),
  SCHEMA_REFRESH_SEC: numberFromEnv(900, 60),
  SQL_HARD_ROW_CAP: numberFromEnv(100, 1, 100),
  LLM_TIMEOUT_MS: numberFromEnv(20000, 1000, 120000),
  LLM_MAX_RETRIES: numberFromEnv(2, 0, 5),
  LLM_RETRY_BASE_MS: numberFromEnv(250, 50, 5000),
  PG_POOL_MAX: numberFromEnv(20, 1, 200),
  PG_POOL_IDLE_TIMEOUT_MS: numberFromEnv(30000, 1000, 600000),
  PG_POOL_CONNECTION_TIMEOUT_MS: numberFromEnv(5000, 100, 60000),
  PG_POOL_MAX_USES: numberFromEnv(5000, 0, 1000000),

  ENABLE_PRISMA_ADAPTER: booleanFromEnv.default(false),
  DB_EXECUTOR: z.enum(['pg', 'prisma']).default('pg'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  throw new Error(`Invalid environment configuration: ${issues}`)
}

export const env = {
  ...parsed.data,
  OPENAI_MODEL: parsed.data.OPENAI_MODEL ?? parsed.data.FASTROUTER_MODEL ?? 'gpt-4o-mini'
}

if (!env.DEV_AUTH_BYPASS) {
  const missing: string[] = []
  if (!env.JWT_JWKS_URL) missing.push('JWT_JWKS_URL')
  if (!env.JWT_ISSUER) missing.push('JWT_ISSUER')
  if (!env.JWT_AUDIENCE) missing.push('JWT_AUDIENCE')

  if (missing.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${missing.join(', ')} required when DEV_AUTH_BYPASS=false`
    )
  }
}

export type Env = typeof env
