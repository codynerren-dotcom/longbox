# Longbox

Self-hosted tracker for one physical comic collection. It replaces CLZ Comics for a single shelf: import the CLZ CSV, scan barcodes, and browse series, keys, boxes, and a wishlist.

The app is a Next.js (App Router) service with Postgres 16. It is meant to run on a ZimaOS box at `192.168.220.5`, LAN-only, with no login in v1.

## Setup

Node.js 22+ and Docker.

```bash
cp .env.example .env
docker compose up --build
```

Open `http://192.168.220.5:3210` on the LAN, or `http://localhost:3210` when you are on the box. The host port is `APP_PORT` (default `3210`). Postgres is not published; only the app port is.

On an empty database, `SEED_ON_EMPTY=true` (the Compose default) loads the synthetic 30-issue shelf in `fixtures/clz-synthetic.csv`. That file is fake. Set `SEED_ON_EMPTY=false` before the first boot if you want to start from your own export. To wipe the sample shelf later, remove the `longbox_postgres` volume and start again.

For host-side development, run only Postgres (or point `DATABASE_URL` at a local instance) and:

```bash
npm install
npx prisma migrate deploy
npm run db:seed
npm run dev
```

## Environment

See `.env.example`. Nothing secret is committed.

| Variable | Purpose |
| --- | --- |
| `APP_PORT` | Host port. Default `3210`. |
| `DATABASE_URL` | Postgres connection string. |
| `TZ` | `America/Chicago` in Compose. |
| `LONGBOX_USER_EMAIL` | Identity when Cloudflare Access is not in front. |
| `SEED_ON_EMPTY` | Import the synthetic shelf when `comics` is empty. |
| `METRON_API_TOKEN` or `METRON_USERNAME` + `METRON_PASSWORD` | Metron catalog. Blank skips Metron. |
| `METRON_API_BASE` | Default `https://metron.cloud/api`. |
| `GCD_API_BASE` | Default `https://www.comics.org`. |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | Reserved for the eBay price stub. Unused in v1. |

If the request has `Cf-Access-Authenticated-User-Email`, that address is the viewer. Otherwise Longbox stays single-user. v1 does not block anonymous LAN requests.

## Import a CLZ export

CLZ Comics can export the collection as CSV. The header must be the 66-column row documented in `src/lib/clz/headers.ts`, in that order. Barcodes stay strings (a 17-digit UPC is not a number). `0000-00-00` bag/board dates become null. Prices like `$ 4.99` and whole numbers like `2020.0` are parsed into typed columns. Purchase price is per copy, so recorded spend and cost basis are that price times quantity. The original row is stored as JSON so nothing is dropped.

Re-importing is safe. A row matches an existing comic on `Core ComicID` + variant + index and updates it.

In the app, open **Import CLZ CSV** and upload the file.

From the shell, against the same database the app uses:

```bash
npm run import:clz -- /path/to/clz.csv
```

Inside Compose:

```bash
docker compose exec app npm run import:clz -- /path/to/clz.csv
```

Copy the file into the container first, or mount it. Do not commit a real export.

## ZimaOS

1. Copy this repo onto the ZimaOS machine.
2. `cp .env.example .env` and set a Postgres password. Keep the box on the LAN; do not port-forward 3210.
3. `docker compose up -d --build`
4. Browse to `http://192.168.220.5:3210`.

The stack is the `app` service plus `postgres:16`, with the named volume `longbox_postgres`. Both services set `TZ=America/Chicago`. The app listens on 3210. A phone can install it as a PWA (manifest, icons, service worker). Chrome on Android expects HTTPS for a durable install, which is a Cloudflare tunnel follow-up. See `docs/PLAN.md`.

## Checks

```bash
npm run validate
```

Lint, the TypeScript check, and unit tests. Tests cover the synthetic CLZ fixture and barcode parsing. They do not need Postgres.

## Project map

- Collection, series runs, key issues, storage boxes, wishlist, dashboard.
- Scan page: camera via the Barcode Detector API, with ZXing as the fallback, reading UPC-A and a 5-digit add-on. Local shelf first ("You own this"), then Metron, then GCD. Top three matches, add one, or queue a stack.
- `PriceProvider` and `CoverMatcher` are stubs. `price_snapshots` is ready for history. No PriceCharting.
