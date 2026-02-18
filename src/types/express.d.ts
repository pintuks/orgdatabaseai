import 'express-serve-static-core'

declare module 'express-serve-static-core' {
  interface Request {
    auth?: {
      orgId: string
      subject: string
      tokenPayload: Record<string, unknown>
    }
  }
}
