# Longbox roadmap

v1 is a local shelf: CLZ import, barcode scan, collection browsing, and a dashboard. These are the next slices, in the order they should land.

## eBay pricing

`PriceProvider` in `src/lib/pricing/types.ts` is the contract. `EbayPriceProvider` reads `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` and returns an empty quote. The implementation should:

- Search sold and active listings by series, issue, and grade.
- Write each quote to `price_snapshots` (comic, source, amount, currency, fetched time, raw payload).
- Replace the issue-page placeholder that says "Pricing coming soon (eBay)".

Do not add PriceCharting.

## Cover recognition

`CoverMatcher` in `src/lib/covers/matcher.ts` is the contract. A later matcher should:

- Embed the photo and compare it with Metron cover hashes and any covers already on the shelf.
- OCR the title, issue number, and barcode box.
- Optionally ask a vision model when the shortlist is ambiguous.

No model calls ship in v1.

## Cloudflare tunnel

The app is LAN-only on port 3210. When it should be reachable off the LAN:

- Run `cloudflared` in front of the Compose service. Do not publish the app to the open internet without Access.
- Cloudflare Access already has a hook: `viewerFromHeaders` trusts `Cf-Access-Authenticated-User-Email`.
- v1 does not reject anonymous LAN requests. Turning that into a real gate is a follow-up, after Access is the only public path.

## Trading cards

Out of scope for the comic schema. A later collection type (sport or TCG) should get its own tables rather than overloading `Comic`. Shared pieces worth reusing: the scan sheet, the storage-box view, and the price-snapshot history.
