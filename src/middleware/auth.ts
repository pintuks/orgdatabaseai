import type { NextFunction, Request, Response } from 'express'
import type { Logger } from 'pino'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

type AuthOptions = {
  jwksUrl?: string
  issuer?: string
  audience?: string
  orgClaim: string
  devAuthBypass: boolean
  logger: Logger
}

function extractBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null
  }

  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

export function createAuthMiddleware(options: AuthOptions) {
  const jwks =
    options.devAuthBypass || !options.jwksUrl ? null : createRemoteJWKSet(new URL(options.jwksUrl))

  return async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (options.devAuthBypass) {
        const orgHeader = req.headers['x-org-id']
        const orgId = typeof orgHeader === 'string' ? orgHeader.trim() : ''

        if (!orgId) {
          res.status(401).json({ error: 'missing x-org-id header in DEV_AUTH_BYPASS mode' })
          return
        }

        req.auth = {
          orgId,
          subject: 'dev-bypass',
          tokenPayload: {}
        }

        next()
        return
      }

      const token = extractBearerToken(req.headers.authorization)
      if (!token) {
        res.status(401).json({ error: 'missing bearer token' })
        return
      }

      if (!jwks || !options.issuer || !options.audience) {
        res.status(500).json({ error: 'server auth configuration is incomplete' })
        return
      }

      const verified = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience
      })

      const payload = verified.payload as JWTPayload & Record<string, unknown>
      const orgValue = payload[options.orgClaim]

      if (typeof orgValue !== 'string' || orgValue.trim().length === 0) {
        res.status(403).json({ error: `missing org claim: ${options.orgClaim}` })
        return
      }

      req.auth = {
        orgId: orgValue,
        subject: payload.sub ?? 'unknown',
        tokenPayload: payload
      }

      next()
    } catch (error) {
      options.logger.warn({ error }, 'token verification failed')
      res.status(401).json({ error: 'invalid token' })
    }
  }
}
