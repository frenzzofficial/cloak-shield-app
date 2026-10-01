---
name: cloak-shield-audit
description: Bugs found in the cloak-shield repo, why the app did not run, and what was changed.
---

# Audit report

## Why the app did not run
`appConfig.app.host` was set to `SITE_ORIGIN`, a full URL such as `http://localhost:7164`.
It was passed to `listen()` as the bind hostname, so startup failed with
`getaddrinfo ENOTFOUND http://localhost:7164`. It now uses `HOST`.

## Bugs fixed
| # | Problem | Fix |
|---|---|---|
| 1 | Server bound to a URL instead of a hostname (crash on start) | Use `envAppConfig.HOST` |
| 2 | Unknown routes returned 500 instead of 404 | Handle `NOT_FOUND`, `PARSE`, `VALIDATION` codes |
| 3 | Error handler was registered after the routes, so Elysia never applied it to them | Register it first in `createApp` |
| 4 | `z.coerce.boolean()` turns the string "false" into true (every `ENABLE_*=false` was ignored) | `z.stringbool()` |
| 5 | Unexpected errors were never logged | Added a JSON logger; handler logs them |
| 6 | Env failures threw a generic message with no detail | `parseEnv` prints every invalid variable |
| 7 | Hardcoded default `APP_SECRET` could reach production | Production requires a unique secret of 32+ characters |
| 8 | `site.url` used `SITE_URL` with a `localhost:3000` fallback (wrong port, logged wrong URL) | Uses `SITE_ORIGIN`, which defaults from the Vercel domain |
| 9 | lint-staged ran `biome verify`, which is not a Biome command (pre-commit always failed) | `biome check --write` |
| 10 | `test`, `test:coverage`, `build` scripts missing but used by the pre-push hook and CI | Added; added real tests |
| 11 | Files had CRLF endings and mixed tabs/spaces while Biome wants LF and tabs (16 lint errors) | Reformatted; `.editorconfig` matches Biome |
| 12 | `as never` casts broke the 100% type-coverage rule | Use `set.status` instead |
| 13 | `typescript` only in `peerDependencies`; `@types/bun` set to `latest` | Moved to devDependencies; pinned range |
| 14 | `client.env.ts` was never imported (dead code) | Wired into `appConfig.client` |
| 15 | dependency-cruiser rules pointed at `src/shared` and `src/modules`, which do not exist | Rules rewritten for `src/packages` |
| 16 | `.gitignore` missed `.vercel` and most `.env.*` files; `.env.example` was incomplete | Fixed |
| 17 | `bash -c` in lint-staged fails on plain Windows shells | Function-based `lint-staged.config.mjs` |

## Left as is (your call)
- `API_PREFIX` defaults to `/app`, which looks like a typo for `/api`. Nothing uses it yet.
- `SITE_DOCUMENTATION` points to `/documentation`, but no Swagger plugin is installed.
- Many `ENABLE_*` flags (Redis, SMTP, CSRF, ...) are parsed but not used yet.
- `jose` and `@faker-js/faker` are installed but unused (kept for upcoming auth and tests).
- `src/types/globals.d.ts` is empty.
