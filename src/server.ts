import 'dotenv/config'
import express from 'express'
import pinoHttp from 'pino-http'
import Redis from 'ioredis'
import { Pool } from 'pg'
import type { QueryExecutor } from './db/types'
import { PgQueryExecutor } from './db/pg-executor'
import { PrismaQueryExecutor } from './db/prisma-executor'
import { env } from './config/env'
import { logger } from './utils/logger'
import { SchemaRegistry } from './schema/cache'
import { FastRouterClient } from './llm/fastrouter-client'
import { createAuthMiddleware } from './middleware/auth'
import { createHttpMethodGuard } from './middleware/http-method-guard'
import { createQueryRouter } from './routes/query'
import { createOrganizationsRouter } from './routes/organizations'
import { RedisClarifyStore } from './session/redis-store'

async function loadPrismaExecutor(): Promise<QueryExecutor> {
  const dynamicImport = new Function(
    'modulePath',
    'return import(modulePath)'
  ) as (modulePath: string) => Promise<{ PrismaClient: new (...args: unknown[]) => any }>

  let prismaModule: { PrismaClient: new (...args: unknown[]) => any }

  try {
    prismaModule = await dynamicImport('@prisma/client')
  } catch (error) {
    throw new Error(
      `Prisma adapter is enabled but @prisma/client is not available: ${(error as Error).message}`
    )
  }

  const prisma = new prismaModule.PrismaClient({
    datasources: {
      db: {
        url: env.DATABASE_URL
      }
    }
  })

  return new PrismaQueryExecutor(prisma)
}

async function buildExecutor(pool: Pool): Promise<QueryExecutor> {
  if (env.DB_EXECUTOR === 'prisma') {
    if (!env.ENABLE_PRISMA_ADAPTER) {
      throw new Error('DB_EXECUTOR=prisma requires ENABLE_PRISMA_ADAPTER=true')
    }

    return loadPrismaExecutor()
  }

  return new PgQueryExecutor(pool, env.QUERY_TIMEOUT_MS)
}

async function bootstrap(): Promise<void> {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.PG_POOL_MAX,
    idleTimeoutMillis: env.PG_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.PG_POOL_CONNECTION_TIMEOUT_MS,
    maxUses: env.PG_POOL_MAX_USES
  })

  const schemaRegistry = new SchemaRegistry(pool, env.SCHEMA_REFRESH_SEC, logger)
  await schemaRegistry.init()

  const llmClient = new FastRouterClient(
    env.FASTROUTER_BASE_URL,
    env.FASTROUTER_API_KEY,
    env.OPENAI_MODEL,
    logger,
    {
      timeoutMs: env.LLM_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
      retryBaseMs: env.LLM_RETRY_BASE_MS
    }
  )

  const queryExecutor = await buildExecutor(pool)

  let redis: Redis | null = null
  let clarifyStore: RedisClarifyStore | undefined

  if (env.REDIS_URL) {
    redis = new Redis(env.REDIS_URL)
    clarifyStore = new RedisClarifyStore(redis)
  }

  const app = express()

  app.use(express.json({ limit: '1mb' }))
  app.use(pinoHttp({ logger }))
  app.use(express.static('public'))
  app.use(
    createHttpMethodGuard({
      allowedMutations: [
        {
          method: 'POST',
          path: '/v1/query'
        }
      ]
    })
  )

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      refreshedAt: schemaRegistry.getSnapshot().refreshedAtIso
    })
  })

  const authMiddleware = createAuthMiddleware({
    jwksUrl: env.JWT_JWKS_URL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    orgClaim: env.JWT_ORG_CLAIM,
    devAuthBypass: env.DEV_AUTH_BYPASS,
    logger
  })

  if (env.DEV_AUTH_BYPASS) {
    app.use(
      '/v1/organizations',
      createOrganizationsRouter({
        queryExecutor,
        schemaRegistry,
        publicAccess: true
      })
    )
  }

  app.use(authMiddleware)

  if (!env.DEV_AUTH_BYPASS) {
    app.use(
      '/v1/organizations',
      createOrganizationsRouter({
        queryExecutor,
        schemaRegistry,
        publicAccess: false
      })
    )
  }

  app.use(
    '/v1/query',
    createQueryRouter({
      llmClient,
      schemaRegistry,
      queryExecutor,
      logger,
      hardRowCap: env.SQL_HARD_ROW_CAP,
      enableStatefulClarify: env.ENABLE_STATEFUL_CLARIFY,
      sessionTtlSec: env.SESSION_TTL_SEC,
      clarifyStore
    })
  )

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'service started')
  })

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down')
    schemaRegistry.stop()

    server.close(async () => {
      await pool.end()
      if (redis) {
        await redis.quit()
      }
      logger.info('shutdown complete')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

bootstrap().catch((error) => {
  logger.error({ error }, 'failed to start service')
  process.exit(1)
})
