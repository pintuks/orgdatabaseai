# Safe NL->SQL API

TypeScript/Node service that converts natural-language database questions into safe PostgreSQL `SELECT` queries, enforces tenant filtering (`organizationId`), executes read-only SQL, and returns both explanation text and table-ready rows.

It also serves a built-in UI at `/` with an organization dropdown.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment template and fill values:
```bash
cp .env.example .env
```

3. Start development server:
```bash
npm run dev
```

4. Open the UI:
- `http://localhost:3000/`

## Deploy on Railway

This repo now includes:
- `railway.toml` (healthcheck + restart policy)
- `Dockerfile` (production runtime)
- `.dockerignore`

### Steps

1. Create a new Railway project and link this GitHub repo.
2. In service variables, set all required env vars from `.env.example`:
   - `DATABASE_URL`
   - `FASTROUTER_API_KEY`
   - `FASTROUTER_BASE_URL`
   - `FASTROUTER_MODEL` (or `OPENAI_MODEL`)
   - Auth vars (`JWT_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_ORG_CLAIM`) unless using `DEV_AUTH_BYPASS=true`
   - `REDIS_URL` if using stateful clarify mode
3. Deploy. Railway will build using the provided `Dockerfile`.
4. Verify healthcheck at `/health`.

## API

### `POST /v1/query`

Requires `Authorization: Bearer <JWT>` in production mode.  
In `DEV_AUTH_BYPASS=true`, send `x-org-id: <organization_id>` instead.

Request body:
```json
{
  "question": "list active users",
  "page": 1,
  "pageSize": 25,
  "mode": "stateless"
}
```

Responses:
- `status: "clarify"` with one clarifying question
- `status: "answered"` with SQL, explanation, and paginated row data
- In `answered`, `answer` is markdown text.
- The built-in UI renders `answer` using latest `marked` and sanitizes with `DOMPurify` before injecting HTML.

### `GET /v1/organizations`
- Used by the UI dropdown.
- In `DEV_AUTH_BYPASS=true`, returns all organizations (public for local/dev use).
- In normal auth mode, returns only the authenticated organization.

## Safety guarantees

- Single `SELECT` only
- No comments, semicolons, or mutating SQL keywords
- Table/column allowlist from live `information_schema`
- Sensitive column denylist (`password`, `token`, `secret`, etc.)
- Automatic tenant filter injection for tables with `organizationId`
- Hard row cap and application-level pagination
- Read-only DB transaction + statement timeout

## Auth modes
- **Production mode** (`DEV_AUTH_BYPASS=false`): requires JWT verification via JWKS/issuer/audience.
- **Local/dev mode** (`DEV_AUTH_BYPASS=true`): skips JWT and expects `x-org-id` header for protected routes.

## Scripts

- `npm run dev`
- `npm run build`
- `npm run test`
- `npm run lint`
