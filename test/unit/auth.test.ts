import express from 'express'
import request from 'supertest'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../../src/middleware/auth'

describe('auth middleware (DEV_AUTH_BYPASS)', () => {
  it('requires x-org-id header', async () => {
    const app = express()
    app.use(
      createAuthMiddleware({
        jwksUrl: 'https://example.com/.well-known/jwks.json',
        issuer: 'https://example.com/',
        audience: 'example-aud',
        orgClaim: 'organizationId',
        devAuthBypass: true,
        logger: pino({ enabled: false })
      })
    )
    app.get('/check', (req, res) => {
      res.json({ orgId: req.auth?.orgId ?? null })
    })

    const missing = await request(app).get('/check')
    expect(missing.status).toBe(401)

    const ok = await request(app).get('/check').set('x-org-id', 'org_demo')
    expect(ok.status).toBe(200)
    expect(ok.body.orgId).toBe('org_demo')
  })
})
