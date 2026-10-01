---
name: cloak-shield
description: A lightweight backend built with Bun, Elysia and TypeScript, deployed on Vercel.
---

# Cloak Shield

Authentication backend on **Bun + Elysia + TypeScript**, deployed to **Vercel** (no Docker).

## Quick start

```bash
bun install          # also installs the Husky git hooks (needs `git init` first)
cp .env.example .env
bun run dev          # http://localhost:7164
```

Check it: `curl http://localhost:7164/health`

## Scripts

| Command                          | What it does                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `bun run dev`                    | Local server with auto-reload (`src/app/server.ts`)                 |
| `bun run verify`                 | Typecheck, lint, type-coverage, architecture, knip, spelling, tests |
| `bun run lint:fix`               | Auto-fix formatting and lint problems                               |
| `bun run test` / `test:coverage` | Run the tests                                                       |
| `bun run build:check`            | Proves the Vercel entry bundles correctly                           |
| `bun run secrets`                | Scan for committed secrets                                          |
| `bun run deps:upgrade`           | Interactive dependency upgrades                                     |

## Project layout

```
src/
├── index.ts          # Vercel entrypoint (default export). No app.listen here.
├── app/
│   ├── main.ts        # createApp(): wires every middleware and route, in order
│   ├── router.ts       # versioned API routes, under appConfig.api.base (e.g. /api/v1)
│   └── server.ts       # local dev server only
└── packages/
    ├── env/            # Zod-validated environment (leaf layer)
    ├── configs/        # app config built from env
    ├── middlewares/     # error handler, security headers, cors, compression, request
    │                    # logging, body limit, rate limiter, CSRF protection, openapi
    │                    # docs, not-found catch-all
    ├── bootstrap/       # unversioned base routes (/ and /health)
    └── utils/           # errors, logger
tests/                  # bun:test suites
```

Rules: no untyped escape hatches, explicit or implicit (use `unknown` and narrow), relative imports (no `@/` alias — Vercel doesn't rewrite alias specifiers inside a dynamic `import()`, see `src/index.ts`), Conventional Commits.
`bun run arch` enforces the layering above.

## Request pipeline

`src/app/main.ts` wires everything in this order — each step only affects what's registered after it:

1. **Error handler** (`middlewares/error-handler.ts`) — every thrown `AppError` and every
   framework error code (`NOT_FOUND`, `PARSE`, `VALIDATION`, ...) becomes the same
   `{ success: false, message }` JSON shape.
2. **Security headers** (`middlewares/security-headers.ts`, via `elysiajs-helmet`) — CSP,
   `X-Frame-Options`, HSTS (production only), `Referrer-Policy`, and friends, on every
   response. Toggle with `ENABLE_SECURITY_HEADERS`.
3. **CORS** (`middlewares/cors.ts`, via `@elysiajs/cors`) — allowlists `CLIENT_ORIGINS`
   (comma-separated, already parsed and URL-validated), with `credentials: true` so the
   CSRF cookie works cross-origin. Toggle with `ENABLE_CORS`.
4. **Compression** (`middlewares/compression.ts`) — gzips responses over 1 KB when the
   client sends `Accept-Encoding: gzip`. Hand-written using Elysia's own `mapResponse`
   hook and Bun's native `Bun.gzipSync` — see the comment at the top of that file for why
   (both published npm packages for this are broken against this Elysia version). Toggle
   with `ENABLE_COMPRESSION`. On Vercel this is usually redundant (their edge network
   already compresses) — leave it off there unless measured otherwise.
5. **Request logging** (`middlewares/request-logging.ts`) — one JSON line per request
   (method, path, status, duration) through the same logger as errors. Toggle with
   `ENABLE_REQUEST_LOGGING`.
6. **Body limit** (`middlewares/body-limit.ts`) — rejects a request whose `Content-Length`
   exceeds `BODY_LIMIT_BYTES` before anything parses it. Elysia parses JSON/form/multipart
   bodies natively based on `Content-Type`; there's no separate parser to configure.
7. **Rate limiter** (`middlewares/rate-limiter.ts`) — hand-written, fixed-window, keyed by
   client IP. `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`, toggle with
   `ENABLE_RATE_LIMIT`. No dependency — see the comment at the top of that file; the
   published `elysia-rate-limit` package ran different code than what's actually
   published under its pinned version on at least one real machine (an old
   `.beforeHandle(scope, handler)` two-argument call that no longer exists), causing a
   crash that a clean reinstall didn't fix. A ~40-line `Map`-based counter removes that
   risk entirely. Not distributed — fine for a single instance; swap in Redis-backed
   counting (`ENABLE_REDIS` already exists as a flag) before running multiple instances.
8. **CSRF protection** (`middlewares/csrf.ts`) — double-submit cookie pattern. Off by
   default (`ENABLE_CSRF_PROTECTION=false`); turn it on only if a browser frontend will
   rely on cookies for auth. Requests carrying an `Authorization` header are never checked
   — a Bearer token isn't sent automatically by the browser, so it isn't a CSRF target.
9. **OpenAPI docs** (`middlewares/openapi.ts`, via `@elysiajs/openapi`) — auto-generated
   docs from route schemas, served at `/openapi` (spec JSON at `/openapi/json`). Must be
   registered before the routes it documents. Toggle with `ENABLE_SWAGGER`.
10. **Routes** — unversioned first (`/`, `/health` from `bootstrap/`), then the versioned
    group from `app/router.ts` (`appConfig.api.base`, e.g. `/api/v1`).
11. **Not-found** (`middlewares/not-found.ts`) — a `.all("*", ...)` catch-all. Must stay
    last; anything registered after a wildcard route would be shadowed by it.

## API versioning

Every versioned route lives under one `.group()` in `src/app/router.ts`:

```ts
app.group(appConfig.api.base, (group) =>
	group.get("/", ...).use(someFeatureRoutes),
);
```

`appConfig.api.base` is built from `API_PREFIX` + `API_VERSION` (default `/api` + `v1` →
`/api/v1`). To add a v2 without breaking v1 clients, add a second `.group()` with its own
prefix in the same file — the two are independent.

## Deploy on Vercel

1. Push the repo to GitHub and import it at vercel.com/new. Vercel detects Elysia from `src/index.ts`.
2. `vercel.json` already sets `bunVersion`, so the Bun runtime is used.
3. In Project Settings → Environment Variables, set at least:
    - `APP_SECRET`: unique, 32+ characters (`openssl rand -base64 48`). Production refuses to start without it.
    - Optional: `SITE_ORIGIN`, `CLIENT_ORIGIN`, `CLIENT_ORIGINS`, `API_PREFIX`, `API_VERSION`,
      `RATE_LIMIT_*`, `BODY_LIMIT_BYTES`, `ENABLE_SECURITY_HEADERS`, `ENABLE_CSRF_PROTECTION`.
      See `.env.example` for the full list and defaults.
4. Deploy, then open `/health` on your deployment URL.

Notes: `app.listen` is not supported on Vercel, which is why the deployed entry is `src/index.ts`.
Keep `bun.lock` committed. Run `vercel dev` if you want to test the exact Vercel behavior locally.
