import type { NextFunction, Request, Response } from 'express'

type GuardedMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type AllowedMutationRoute = {
  method: GuardedMethod
  path: string
}

type HttpMethodGuardOptions = {
  allowedMutations: AllowedMutationRoute[]
}

const mutatingMethods = new Set<GuardedMethod>(['POST', 'PUT', 'PATCH', 'DELETE'])

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) {
    return '/'
  }

  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    return trimmed.slice(0, -1)
  }

  return trimmed
}

function toRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`
}

export function createHttpMethodGuard(options: HttpMethodGuardOptions) {
  const allowed = new Set<string>(
    options.allowedMutations.map((route) => toRouteKey(route.method, route.path))
  )

  return function httpMethodGuard(req: Request, res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase()

    if (!mutatingMethods.has(method as GuardedMethod)) {
      next()
      return
    }

    const routeKey = toRouteKey(method, req.path)
    if (allowed.has(routeKey)) {
      next()
      return
    }

    res.status(405).json({
      error: `${method} is not allowed on this service`
    })
  }
}
