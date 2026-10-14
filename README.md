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
| `SEED_ON_EMPTY` | Import the synthetic shelf when `comics` is empty. A saved Settings toggle overrides this. |
| `LONGBOX_SECRET_KEY` | 32-byte key (base64 or hex) for credentials saved in Settings. Unset, the first boot writes `longbox-secret.key` on the data volume. |
| `COMICVINE_API_KEY` | Comic Vine. Blank skips it. Settings can override it. |
| `METRON_API_TOKEN` or `METRON_USERNAME` + `METRON_PASSWORD` | Metron catalog. Blank skips Metron. |
| `METRON_API_BASE` | Default `https://metron.cloud/api`. |
| `COVERS_DIR` | Where downloaded covers are stored. Compose uses `/data/covers` on the `longbox_covers` volume. Unset on the host, the app uses `./data/covers`. |
| `GCD_API_BASE` | Default `https://www.comics.org`. |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | Reserved for the eBay price stub. Unused in v1. |
| `LONGBOX_LOG` | Set to `off` to stop writing Logs. Unset, logging stays on. |
| `LONGBOX_COMMIT` | Shown on Settings → About. Compose passes the git commit when it is set. |

If the request has `Cf-Access-Authenticated-User-Email`, that address is the viewer. Otherwise Longbox stays single-user. v1 does not block anonymous LAN requests.

## Import a CLZ export

CLZ Comics can export the collection as CSV. The header must be the 66-column row documented in `src/lib/clz/headers.ts`, in that order. Barcodes stay strings (a 17-digit UPC is not a number). `0000-00-00` bag/board dates become null. Prices like `$ 4.99` and whole numbers like `2020.0` are parsed into typed columns. Purchase price is per copy, so recorded spend and cost basis are that price times quantity. The original row is stored as JSON so nothing is dropped.

Re-importing is safe. A real Core ComicID matches on that id plus variant and index. `0`, a blank, or a non-numeric id is treated as missing, and those rows match on series, issue, variant, barcode, and index instead.

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

## Cover backfill

Issues start without cover art. The backfill asks Metron for each one that does not already have a local file, using `METRON_USERNAME` and `METRON_PASSWORD` (basic auth). A barcode match wins only when the scored candidate is the same edition and the release years are close. A facsimile, reprint, later printing, anniversary, True Believers, or omnibus copy is detected from the series name, title, variant, format, release year against the cover year, and cover price. Those copies search the edition series first (for example `Amazing Spider-Man Facsimile Edition`) and are not auto-linked to the original issue when the years are decades apart. Each candidate is scored on series, issue number, variant, release date, UPC, and publisher. Only a score of 75 or higher is linked. Anything lower stays unmatched for the Match panel.

When Metron has no confident match, the Grand Comics Database (`GCD_API_BASE`, default `https://www.comics.org`) is the fallback. GCD calls stay at least two seconds apart and stop after 30 in an hour. Issue data is CC BY-SA: enriched fields show “Data from GCD”. Cover scans are not downloaded or hotlinked. The issue page links to “View on GCD” and the GCD cover page. The Match panel has a GCD tab.

A linked copy whose release year and cover year differ by more than two years, or that looks like a facsimile or other reprint edition, shows up under **Review suspect matches** on Cover backfill (also linked from Settings). Unlink and Re-match are explicit. A hand-picked Metron, Comic Vine, or GCD link is left in place until you unlink it.

A confident Metron image is downloaded onto the `longbox_covers` volume and served by the app at `/covers/files/…`. The grid and the issue page use that file, and fall back to the gradient placeholder when it is missing.

Requests stay under Metron's burst (about 20 per minute) and daily cap (5000). A `429` waits for `Retry-After` and then resumes. The run is safe to start again: matched files are skipped, and unmatched issues stay on **Cover backfill** until you queue them again or paste a Metron issue id.

```bash
npm run covers:backfill
```

Inside Compose:

```bash
docker compose exec app npm run covers:backfill
```

The same job is the **Backfill covers** button on the Cover backfill page.

## Settings

**Settings** is in the desktop sidebar and on the mobile More tab. The page is grouped into cards:

- Import / Export uploads a CLZ CSV, lists past imports, and downloads CSV, JSON, or a database backup. The backup stores settings still encrypted.
- Covers runs or pauses backfill, shows progress, links to the unmatched report, and can re-fetch one cover.
- Pricing sets the eBay cadence (keys weekly, everything else monthly), currency, and an on/off switch. Quotes stay empty until the provider ships.
- Collection sets the default sort, grid density, sold items, default storage box, grading companies, and key categories.
- Display sets the accent, 12-hour or 24-hour clock, date format, and timezone. The default timezone is `America/Chicago`.
- Scanning sets the camera, confirm versus auto-add, and beep or vibrate.
- Data maintenance lists possible duplicates, rebuilds the search sort fields, and can clear the synthetic demo shelf (core ids 900001–900030).
- About shows the version, commit, and database counts.
- Metron, Comic Vine, and eBay credentials, plus the `SEED_ON_EMPTY` toggle, stay on the same page.

A value saved in the database overrides the environment variable. Clear removes the database value and the environment is the fallback again.

Passwords, API keys, and client secrets are encrypted with AES-GCM. The key is `LONGBOX_SECRET_KEY`, or a key file written on the data volume the first time that variable is empty. Those fields show a mask, plus Replace and Clear. Usernames and client ids stay visible, including the saved value. Test connection checks Metron, Comic Vine, and eBay without returning a saved secret.

## ZimaOS

1. Copy this repo onto the ZimaOS machine.
2. `cp .env.example .env` and set a Postgres password. Keep the box on the LAN; do not port-forward 3210.
3. `docker compose up -d --build`
4. Browse to `http://192.168.220.5:3210`.

The stack is the `app` service plus `postgres:16`, with the named volumes `longbox_postgres` and `longbox_covers`. Both services set `TZ=America/Chicago`. The app listens on 3210. A phone can install it as a PWA. On the public hostname that install goes through Cloudflare Access.

## Cloudflare Access

The public shelf is [https://longbox.codyscasa.com](https://longbox.codyscasa.com), with Cloudflare Access in front of the app. The LAN address `http://192.168.220.5:3210` still works on the home network and does not require Access. Do not port-forward 3210.

Access sends `Cf-Access-Authenticated-User-Email` after login. Longbox uses that address as the viewer. Without the header, the shelf stays the single user in `LONGBOX_USER_EMAIL`.

The manifest `<link>` sets `crossorigin="use-credentials"` so the browser sends the Access cookie when it fetches `/manifest.webmanifest`. Without that, install fails because Access answers the manifest request with a login redirect. The service worker stores a response only when it is a same-origin 200 for `/` (HTML) or the manifest (JSON). Redirects, `cloudflareaccess.com`, and `/cdn-cgi/access` login pages are left out of the cache.

`LONGBOX_LOG=off` stops new log rows. Leave it unset to keep logging on.

## Checks

```bash
npm run validate
```

Lint, the TypeScript check, and unit tests. Tests cover the synthetic CLZ fixture, barcode parsing, and the Metron cover backfill with a mocked client. They do not need Postgres.

## Project map

- Collection, series runs, key issues, storage boxes, wishlist, dashboard.
- Scan page: camera via the Barcode Detector API, with ZXing as the fallback, reading UPC-A and a 5-digit add-on. Local shelf first ("You own this"), then Metron, then GCD. Top three matches, add one, or queue a stack.
- Cover backfill stores Metron issue ids and local cover files. `CoverMatcher` is still the stub for photo recognition. `PriceProvider` is the eBay stub. `price_snapshots` is ready for history. No PriceCharting.
