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
| `bun run test` / `test:coverage` | Run the tests (the Postgres suite is skipped without `TEST_DATABASE_URL`) |
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
8. **CSRF protection** (`middlewares/csrf.ts`) — double-submit cookie pattern. On by
   default (`ENABLE_CSRF_PROTECTION=true`) because auth uses cookies. Requests carrying an
   `Authorization` header are never checked — a Bearer token isn't sent automatically by
   the browser, so it isn't a CSRF target. Cross-origin frontends read the token from
   `GET /api/v1/csrf` and send it back in the `x-csrf-token` header.
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

## Email authentication

Mounted under the versioned API base (`ENABLE_EMAIL_AUTH`, default on), e.g. `/api/v1/auth/email/signin`.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/signup` | Creates the account. Signs the user in, unless `AUTH_REQUIRE_EMAIL_VERIFICATION=true` |
| POST | `/signin` | `{ email, password, remember? }`. Sets `access_token` + `refresh_token` httpOnly cookies |
| POST | `/refresh` | Rotates the refresh token (cookie, or `{ "refreshToken" }` in the body) |
| POST | `/signout` | Revokes the session. Always succeeds, even with an expired token |
| GET | `/me`, `/sessions` | Need a valid access cookie or `Authorization: Bearer` |
| DELETE | `/sessions/:id` | Sign one device out (own sessions only; anyone else's id is a 404) |
| POST | `/sessions/revoke-others` | Keep this device, end every other session |
| POST | `/change-password` | Needs the current password; ends other sessions, emails a notice |
| POST | `/change-email`, `/confirm-email-change` | Needs the password; link goes to the NEW address, warning to the old one |
| GET | `/activity?limit=&before=` | The signed-in user's own security history, newest first |
| POST | `/verify-email`, `/resend-verification` | Single-use links; resend answers the same for every address |
| POST | `/forgot-password`, `/reset-password` | Reset signs out every device and clears any lockout |

**How sessions work**

- Every authenticated request checks that its session still exists and the user is active, so
  sign-out, suspension and password reset take effect immediately, not when the JWT expires.
- Refresh tokens are single-use. Presenting one that was rotated moments ago (two tabs) is
  refused harmlessly; replaying an older one revokes the whole session.
- Wrong passwords are counted in one atomic SQL statement; after `AUTH_MAX_FAILED_LOGINS` the
  account locks for `AUTH_LOCKOUT_DURATION`. Unknown email, wrong password and a locked account
  all return the same 401 message, and response time is equalized.
- Cookies: access cookie is sent everywhere, refresh cookie only to `/api/v1/auth/email`.
  `AUTH_COOKIE_SAMESITE` / `AUTH_COOKIE_DOMAIN` control cross-origin use.
- Non-browser clients send `x-auth-mode: token` on sign-in/refresh to receive tokens in the
  JSON body, then use `Authorization: Bearer`. Browsers never get tokens in the body.

**Rate limiting behind a proxy.** Set `TRUST_PROXY` to match your hosting (`vercel` is chosen
automatically on Vercel). The default `none` ignores `X-Forwarded-For`, because a client can
send any value and would otherwise get a fresh rate-limit bucket on every request.

### Account (profile, preferences, deletion)

Mounted at `/api/v1/account`, all need a signed-in user:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/profile` | The account, its profile and its preferences |
| PATCH | `/profile` | Send only the fields to change; `null` clears one. https-only URLs, validated time zone and locale |
| PATCH | `/preferences` | Partial update |
| POST | `/delete` | Needs the password. Permanent: removes the account and everything attached |

The email address is not editable here; it changes only through `/auth/email/change-email`.
Re-authenticated actions (change password, change email, delete) feed the **same** failed-attempt
counter as sign-in, so a stolen session cannot guess the password through them.

### Audit trail and security emails

Every security-relevant event is written to `audit_logs`: sign-up, sign-in (success, failure and
why), account locks, sign-out, refresh-token reuse, password and email changes, session
revocation, profile/preference updates, deletion. It holds no passwords, tokens or raw email
addresses: a failed sign-in for an unknown account stores only a keyed hash, profile updates
record field *names* but never values, and deleting an account detaches its history
(`user_id` becomes NULL) rather than keeping personal data. Users read their own history at
`GET /api/v1/auth/email/activity`. Writing the trail is best effort: if it fails, the request
still succeeds and the failure is logged. There is no retention job yet; delete old rows with a
scheduled `DELETE FROM audit_logs WHERE created_at < now() - interval '1 year'` if you need one.

Emails sent without the user asking: a **new-device sign-in** alert (only to confirmed addresses,
only when the account already has sign-in history, and only for a browser/OS not seen within
`AUTH_NEW_DEVICE_WINDOW`), **password changed**, **email change requested** and **email changed**
(both to the OLD address, with the new one masked), and **account deleted**. These are security
notices, so the `emailNotifications` preference does not switch them off.

### Email

Verification, reset, change-email and the security notices above are delivered through a `Mailer`
(`packages/mailer`). Resend is built in, over plain HTTPS with no extra dependency:

```bash
MAIL_TRANSPORT=auto            # picks Resend as soon as a key is present
RESEND_API_KEY=re_...
MAIL_FROM="Cloak Shield <no-reply@yourdomain.com>"   # the domain must be verified in Resend
```

Without a key, development prints messages (links included) to the log; production sends nothing
and logs a warning, and never logs the body (it contains live links). `MAIL_TRANSPORT=log` is
refused in production for the same reason. For SMTP, SES or anything else, set
`MAIL_TRANSPORT=custom` and register your transport once at startup:

```ts
import { setMailer } from "@/packages/mailer/mailer";

setMailer({
	send: async ({ to, subject, text }) => {
		// call your provider here; throw on failure (it is logged, never shown to the caller)
	},
});
```

Links point at `CLIENT_ORIGIN`, so the frontend needs three pages that read `?token=`:
`/verify-email`, `/reset-password` and `/confirm-email-change`. Only a SHA-256 hash of each token
is stored. Mail failures never change an endpoint's response.

### Database

After pulling this change run `bun run db:push`. It adds `refresh_token_id`,
`previous_refresh_token_id` and `refresh_rotated_at` to `user_sessions`, creates `auth_tokens`
(with `new_email` and the `EMAIL_CHANGE` type) and `audit_logs`.
Sessions created before the change have an empty `refresh_token_id`, so those users sign in once more.

> Postgres note: the audit metadata column is written with an explicit `::text::jsonb` cast.
> Drizzle and Bun's SQL driver each JSON-encode the value, so a plain object is stored as a
> jsonb *string* and `metadata->>'deviceName'` returns NULL. `tests/auth.postgres.test.ts` has a
> regression test for it.

### Testing against Postgres

`bun test` needs no database: the auth flow suite runs on an in-memory repository. The same
suite also runs against a real Postgres, which is what validates the SQL:

```bash
# DATABASE_URL must point at a THROWAWAY database
DATABASE_SSL=false bun run db:push
TEST_DATABASE_URL=$DATABASE_URL bun test
```

CI does exactly this against a Postgres service container.

### Known limitations

- **Sign-up answers 409 for an existing email**, so it can be used to test whether an address is
  registered (rate limited, but not hidden). Hiding it needs email-first sign-up.
- **Rate-limit counters live in process memory.** On a serverless host each instance counts
  separately, so they are a per-instance speed bump. The real brute-force defense is the
  per-account lockout, which is stored in the database and shared by every instance.
- **Account deletion is immediate.** There is no grace period or export step yet.
- **No audit-log retention job** (see above), and no admin view of other users' audit trails.

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
