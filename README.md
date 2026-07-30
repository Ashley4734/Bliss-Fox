# Bliss Fox Studio — Coolify Static Site

Static HTML/CSS/JS brand hub for Bliss Fox Studio **printable coloring books**.
The product catalog is generated from the Bliss Fox Studio **Etsy shop** and stays
in sync automatically: add a listing on Etsy and it appears on the site on the next
scheduled sync. This repo is packaged for direct GitHub-to-Coolify deployment with
Docker + Nginx.

## Coolify deployment settings

Use these settings in Coolify:

- Resource type: Git repository / GitHub repository
- Repository: `Ashley4734/Bliss-Fox`
- Branch: `main`
- Build pack / build type: Dockerfile
- Dockerfile path: `/Dockerfile`
- Exposed port: `80`
- Health check path: `/healthz`
- Environment variables: none required
- Database: none required

After the app is created, attach your domain in Coolify and enable HTTPS. Enable
Coolify's GitHub auto-deploy (webhook) so pushes to `main` — including the automated
catalog syncs — redeploy the site.

## How the Etsy catalog stays up to date

The catalog is a single data file, `data/products.json`, that the site reads in the
browser to render the book cards on the homepage and the All Books page.

A scheduled GitHub Action (`.github/workflows/sync-etsy.yml`) refreshes it:

1. `scripts/sync-etsy.mjs` calls the Etsy Open API v3 for the shop's **active** listings.
2. It writes title, description, image, price, tags, and a listing link into `data/products.json`.
3. If anything changed, the Action commits the file to `main`, which triggers a Coolify redeploy.

It runs every 6 hours and can also be run on demand from the Actions tab
("Sync Etsy catalog" → "Run workflow").

### One-time setup: Etsy app credentials

The sync authenticates at the app level using **both** the app's Keystring and its
Shared Secret (Etsy sends them together in the `x-api-key` header as
`keystring:shared_secret`). No shopper OAuth is required for reading public listings.

1. Go to https://www.etsy.com/developers/your-apps and open (or create) your app.
2. Copy the two values shown for the app — the **Keystring** and the **Shared Secret**
   (click the eye icon to reveal the secret). Don't include surrounding quotes,
   spaces, or a trailing newline.
3. In this GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**,
   add **two** secrets:
   - `ETSY_API_KEY` = the Keystring
   - `ETSY_SHARED_SECRET` = the Shared Secret
4. (Optional) If the shop name ever changes, set a repository **variable** `ETSY_SHOP_NAME`
   (defaults to `BlissFoxStudio`).
5. (Optional) To show a sale price, set a repository **variable** `ETSY_SALE_PERCENT`
   to your current Etsy shop-wide sale percentage (e.g. `30` for 30% off). See
   "Showing sale prices" below.

You can sanity-check the credentials from any terminal:

```bash
curl -s -H "x-api-key: KEYSTRING:SHARED_SECRET" \
  https://openapi.etsy.com/v3/application/openapi-ping
# → {"application_id": ...}  means the credentials work
```

Once both secrets are set, open the Actions tab and run the workflow once to populate
the catalog immediately. Until then the site shows a friendly "shop on Etsy" prompt
instead of product cards.

### Showing sale prices

Etsy's public API only returns each listing's **list price** — a shop-wide "Sale"
percentage is applied by Etsy at display/checkout time and is not exposed to the
API. To mirror a sale on the site, set the current percentage yourself:

- Repo **Settings → Secrets and variables → Actions → Variables → New repository variable**
  - Name: `ETSY_SALE_PERCENT`
  - Value: the whole-number percentage, e.g. `30` for 30% off

When set, the sync shows the discounted price with the list price struck through
and a `−30%` badge (e.g. **$4.19** ~~$5.99~~). Change the number when your sale
changes, or delete the variable when the sale ends and prices revert to the list
price. Re-run the workflow after changing it so the catalog updates. The discounted
amount is computed from the list price, so it can differ from Etsy by a cent on
odd roundings.

### Pinterest product catalog feed

Each sync also writes `pinterest-catalog.xml` (RSS 2.0 with Google Shopping
`g:` fields), served at:

```
https://blissfoxstudio.com/pinterest-catalog.xml
```

It stays in step with the Etsy shop automatically (same 6-hour schedule). Each
item includes id, title, description, link, image_link, price, sale_price (when
a sale is configured), availability, brand, google_product_category, and
product_type.

Pinterest requires the item `link` domain to match your verified domain, so feed
links use `https://blissfoxstudio.com/listing/<id>/<slug>`; nginx 301-redirects
those `/listing/...` URLs to the matching Etsy listing. (The website's own
product cards still link straight to Etsy.)

To connect it in Pinterest (one-time):

1. Use a Pinterest **business** account and **claim the `blissfoxstudio.com` domain**
   (Settings → Claimed accounts).
2. Go to **Catalogs** and add a **data source** pointing at the feed URL above.
3. Set the currency to match the listings (USD) and let Pinterest schedule
   automatic fetches (daily). Pinterest re-reads the URL on that schedule, so new
   Etsy products flow through without further work.

### Run the sync locally (optional)

```bash
ETSY_API_KEY=your_keystring ETSY_SHARED_SECRET=your_shared_secret \
  node scripts/sync-etsy.mjs
```

Requires Node 18+ (uses built-in `fetch`; no dependencies).

## Pinterest organic Pin publishing

Separate from the catalog feed above (which powers *shopping* Pins), the site can
publish **organic Pins** for products you choose, to your themed boards. This is a
first-party tool for the Bliss Fox Studio account only.

- `scripts/pinterest-publish.mjs` — refreshes the Pinterest access token, reads
  the Etsy catalog (`data/products.json`), and publishes Pins.
- `data/pinterest-queue.json` — **you** list which products to pin (by Etsy
  `listing_id`). The publisher only ever posts entries here, a few per run, and
  marks them `posted` afterward. Nothing is posted that you did not queue —
  Pinterest's Developer Guidelines require the owner to choose each Pin.
- `.github/workflows/pinterest-publish.yml` — runs daily and on demand.

It stores **no** data retrieved from the Pinterest API: board ids are resolved
from board **names** at run time, and only your own `listing_id` + a `posted`
flag are persisted.

### One-time setup

1. **Secrets** (repo → Settings → Secrets and variables → Actions):
   `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REFRESH_TOKEN`
   (a long-lived refresh token from the OAuth flow, scopes
   `boards:read pins:read pins:write`).
2. **Create the boards** in the Pinterest UI (the token has no `boards:write`,
   so boards are made by hand). Names must match (case-insensitive):
   *Cozy Coloring Pages*, *Spooky Coloring Pages*, *Fantasy Coloring Pages*,
   *Animal Coloring Pages*, *Seasonal & Holiday Coloring Pages*,
   *Community Helpers Coloring Pages*, *Kids Coloring Pages*,
   *Patriotic Coloring Pages*, plus a default *Printable Coloring Books*.
3. **Verify**: run the workflow with mode `verify` — it lists your boards, flags
   any missing theme board, and prints a product menu to build the queue from.
4. **Queue** the products you want in `data/pinterest-queue.json`, then run mode
   `publish` (or let the daily schedule do it).

### Run the publisher locally (optional)

```bash
PINTEREST_APP_ID=... PINTEREST_APP_SECRET=... PINTEREST_REFRESH_TOKEN=... \
  MODE=verify node scripts/pinterest-publish.mjs
```

`MODE=publish` posts up to `MAX_PER_RUN` (default 5) queued Pins; `DRY_RUN=1`
logs what would post without calling the API.

## Runtime routes

URLs are extensionless — nginx serves each page from its `.html` file and 301-redirects
the old `.html` URLs to the clean form (e.g. `/books.html` → `/books`).

- `/` — homepage / brand hub (featured downloads from Etsy)
- `/books` — full catalog, generated from `data/products.json`
- `/about` — about the studio
- `/privacy` — privacy policy
- `/data/products.json` — the catalog data file (served static)
- `/pinterest-catalog.xml` — Pinterest product catalog feed (auto-generated)
- branded 404 page for unknown routes
- `/robots.txt` — crawler rules
- `/sitemap.xml` — sitemap
- `/healthz` — Docker/Coolify health check, returns `ok`

## Local verification

```bash
docker build -t blissfoxstudio-website .
docker rm -f blissfoxstudio-website-test 2>/dev/null || true
docker run -d --name blissfoxstudio-website-test -p 8095:80 blissfoxstudio-website
curl -fsS http://127.0.0.1:8095/healthz
curl -I http://127.0.0.1:8095/books           # 200, serves books.html
curl -I http://127.0.0.1:8095/books.html      # 301 -> /books
curl -fsS http://127.0.0.1:8095/data/products.json | head
docker rm -f blissfoxstudio-website-test
```

## Structure

- `Dockerfile` — Nginx static-site container for Coolify
- `nginx.conf` — clean-URL routing, `/healthz`, asset caching, security headers, branded 404
- `docker-compose.yml` — optional local runner
- `.dockerignore` — keeps build context clean
- `index.html` — home / hub
- `books.html` — full catalog (renders from `data/products.json`)
- `about.html` — about page
- `privacy.html` — privacy + Etsy marketplace disclosure page
- `404.html` — on-brand not-found page
- `data/products.json` — Etsy catalog data (auto-generated)
- `pinterest-catalog.xml` — Pinterest product feed (auto-generated by the sync)
- `scripts/sync-etsy.mjs` — Etsy → `products.json` + Pinterest feed sync script
- `.github/workflows/sync-etsy.yml` — scheduled catalog sync
- `scripts/pinterest-publish.mjs` — organic Pin publisher (owner-selected)
- `data/pinterest-queue.json` — the Pins you selected to publish
- `.github/workflows/pinterest-publish.yml` — scheduled/manual Pin publishing
- `assets/site.css` — shared design system
- `assets/site.js` — mobile nav, catalog rendering + theme filter, footer year
- `robots.txt`, `sitemap.xml`

## Marketplace note

All sales run through the Bliss Fox Studio Etsy shop as instant digital downloads.
Product images and links in the catalog come from the live Etsy listings via the
Etsy Open API. Do not add product images, prices, or listing content by hand — the
sync keeps everything in step with Etsy.
