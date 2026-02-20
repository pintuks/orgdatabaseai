import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createHttpMethodGuard } from '../../src/middleware/http-method-guard'

function buildApp() {
  const app = express()

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

  app.post('/v1/query', (_req, res) => {
    res.status(200).json({ ok: true })
  })

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true })
  })

  return app
}

describe('http method guard', () => {
  it('allows configured POST route', async () => {
    const response = await request(buildApp()).post('/v1/query').send({})
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
  })

  it('blocks POST on non-allowlisted route', async () => {
    const response = await request(buildApp()).post('/v1/organizations').send({})
    expect(response.status).toBe(405)
    expect(response.body.error).toMatch(/POST is not allowed/i)
  })

  it('blocks PUT/PATCH/DELETE globally', async () => {
    const app = buildApp()

    const putResponse = await request(app).put('/v1/query').send({})
    expect(putResponse.status).toBe(405)

    const patchResponse = await request(app).patch('/v1/query').send({})
    expect(patchResponse.status).toBe(405)

    const deleteResponse = await request(app).delete('/v1/query')
    expect(deleteResponse.status).toBe(405)
  })

  it('does not block read methods', async () => {
    const response = await request(buildApp()).get('/health')
    expect(response.status).toBe(200)
  })
})
