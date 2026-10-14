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
- `prisma/schema.prisma` — comics, wishlist items, import history, app settings, and `price_snapshots`.

## Conventions

- TypeScript strict. Path alias `@/` points at `src/`.
- Tailwind tokens live in `tailwind.config.ts`: background `#0d0e12`, panels `#16181e` and `#22262f`, accent `#FFCC1A`. Bebas Neue for display, Inter for body.
- Identity is `viewerFromHeaders`. Trust `Cf-Access-Authenticated-User-Email` when it is present. Otherwise use `LONGBOX_USER_EMAIL`. v1 does not authorize requests.
- CLZ imports dedupe on a positive integer `Core ComicID` plus variant and index. `0`, blank, and non-numeric ids fall back to series + issue + variant + barcode + index. The original 66-column row is stored on `rawRow`.
- Cover backfill is `npm run covers:backfill`. It uses Metron basic auth, keeps about 20 requests per minute and 5000 per day, and skips issues that already have a local file. Unmatched rows are listed at `/covers`.
- Integration credentials and shelf preferences go through `src/lib/settings`. Database values override env vars. Secrets are AES-GCM encrypted with `LONGBOX_SECRET_KEY` and are never returned to the browser. Preferences (sort, accent, pricing cadence, scan behavior, cover pause) are plain JSON on `AppSetting`.
- CLZ imports record an `ImportRun`. CSV export prefers the stored 66-column `rawRow`. Database backups include ciphertext, not decrypted secrets.
- Demo data is core comic ids 900001–900030 plus the two seed wishlist rows whose notes are `Gap in the run`.
- Dates from CLZ are stored at 12:00 UTC so America/Chicago does not shift the calendar day.
- No secrets in git. `.env.example` documents every variable.

## Validation

Run this before considering a change done:

```bash
npm run validate
```

That is `next lint`, `tsc --noEmit`, and `vitest run`.

`docker compose up` from a clean checkout must boot Postgres 16 and the app on port 3210. The app image runs `prisma migrate deploy` before `next start`.
