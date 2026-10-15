# Longbox agent notes

Longbox is a single-user Next.js app for a physical comic shelf. Cody runs it on a ZimaOS box with Docker.

## Layout

- `src/app` — App Router pages and route handlers.
- `src/lib/clz` — CLZ CSV parsing and the Postgres upsert. Parsing is pure and is what the unit tests cover.
- `src/lib/barcode.ts` — UPC-A plus add-on parsing. Strings only. Never coerce a barcode through `Number`.
- `src/lib/catalog` — local lookup, then Metron, then the Grand Comics Database.
- `src/lib/pricing` — eBay price stub. Do not add PriceCharting.
- `src/lib/covers` — Metron cover backfill: match, rate limit, and files on `COVERS_DIR`. `matcher.ts` is still the unimplemented photo matcher. Do not hotlink covers.
- `fixtures/clz-synthetic.csv` — synthetic shelf used by tests and the empty-database seed. Do not commit a real CLZ export.
- `prisma/schema.prisma` — comics, wishlist items, import history, app settings, `ApiWindow` rate-limit rows, and `price_snapshots`.

## Conventions

- TypeScript strict. Path alias `@/` points at `src/`.
- Tailwind tokens live in `tailwind.config.ts`: background `#0d0e12`, panels `#16181e` and `#22262f`, accent `#FFCC1A`. Bebas Neue for display, Inter for body.
- Identity is `viewerFromHeaders`. Trust `Cf-Access-Authenticated-User-Email` when it is present. Otherwise use `LONGBOX_USER_EMAIL`. v1 does not authorize requests.
- CLZ imports dedupe on a positive integer `Core ComicID` plus variant and index. `0`, blank, and non-numeric ids fall back to series + issue + variant + barcode + index. The original 66-column row is stored on `rawRow`. A re-import retires leftover rows whose key is still `core:0|...` or `core:0.0|...` from before that rule, moving the row onto the new key or deleting it when the new row already exists.
- Cover backfill is `npm run covers:backfill`. It uses Metron basic auth, routes every outbound call through the shared limiter (see External API rate limits), and skips issues that already have a local file. Unmatched rows are listed at `/covers`.
- Integration credentials and shelf preferences go through `src/lib/settings`. Database values override env vars. Passwords, API keys, and client secrets are AES-GCM encrypted with `LONGBOX_SECRET_KEY` and are never returned to the browser. Usernames and client ids are stored in plain text and shown in the form. Preferences (sort, accent, pricing cadence, scan behavior, cover pause) are plain JSON on `AppSetting`.
- CLZ imports record an `ImportRun`. CSV export prefers the stored 66-column `rawRow`. Database backups include ciphertext, not decrypted secrets.
- Demo data is core comic ids 900001–900030 plus the two seed wishlist rows whose notes are `Gap in the run`.
- Dates from CLZ are stored at 12:00 UTC so America/Chicago does not shift the calendar day.
- No secrets in git. `.env.example` documents every variable.

## External API rate limits

Every new integration that calls an external host goes through the shared limiter in `src/lib/catalog/rate-limit.ts` (the plan) and `src/lib/catalog/rate-store.ts` (the `ApiWindow` rows). Reserve a window before `fetch`. Same-origin `/api` routes stay outside it.

- Cite the published limits in a comment next to the constants. Hardcoded numbers are the fallback before the first response.
- Read the response rate-limit headers. Metron's burst and sustained limits come from `X-RateLimit-*`, so a donor cap replaces 20 per minute and 5,000 per day.
- Honor `Retry-After` in full, including a long delay.
- Persist the window and the resume time in the database. A restart continues the same counters. Do not keep the only copy in memory.

`tests/external-fetch.test.ts` fails when `src` calls `fetch()` or `loggedFetch()` to an external host without a gate. Add the new reserve function to `RATE_GATES` in `tests/external-fetch-scan.ts` in the same change. Current gates: `acquire`, `gcdPause`, `reserveGcdRequest`, `reserveComicVineRequest`, `reserveCoverDownload`, `reserveEbayRequest`.

A manual Match search, re-match, or backfill shows a notice instead of an empty result. Name the source, the limit, and the America/Chicago reset time, for example `Metron limit reached (20/min). Resets at 11:42 AM.` When another source was still searched, say so. A Metron connect pause uses `Metron unreachable, retrying at 11:42 AM.` `tests/limit-notice.test.ts` covers the wording. Queue it on a search or re-link stores that request until the window resets, runs it ahead of background jobs, and lists it on Logs until it finishes or is cancelled. `tests/search-queue.test.ts` covers the queue.

## Validation

Run this before considering a change done:

```bash
npm run validate
```

That is `next lint`, `tsc --noEmit`, `vitest run`, and `next build`.

`docker compose up` from a clean checkout must boot Postgres 16 and the app on port 3210. The app image runs `prisma migrate deploy` before `next start`.
