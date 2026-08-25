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

Separate from the catalog feed above (which powers *shopping* Pins), the site
publishes **organic Pins** for the shop's products to themed boards. This is a
first-party tool for the Bliss Fox Studio account only, requiring Pinterest
**Standard** API access.

- `scripts/pinterest-publish.mjs` — refreshes the Pinterest access token, reads
  the Etsy catalog (`data/products.json`), and publishes Pins.
- `data/pinterest-queue.json` — a **self-maintaining** queue/ledger. With
  `auto_enqueue` on (default) every catalogue product is added automatically, so
  new Etsy listings get pinned with no manual work; with `recycle_after_days` > 0
  a product becomes eligible to re-pin that many days after it was last posted, so
  the daily drip keeps running. You normally never edit this file.
- `.github/workflows/pinterest-publish.yml` — runs daily (15:00 UTC) and on demand.

It stores **no** data retrieved from the Pinterest API: board ids are resolved
from board **names** at run time, and only your own `listing_id` + a `posted`
flag/date are persisted.

### One-time setup

1. **Secrets** (repo → Settings → Secrets and variables → Actions):
   `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_REFRESH_TOKEN`
   (a long-lived refresh token from the OAuth flow, scopes
   `boards:read boards:write pins:read pins:write`).
2. **Create the boards** in the Pinterest UI. The publisher matches them by name
   (case-insensitive): *Cozy Coloring Pages*, *Spooky Coloring Pages*,
   *Fantasy Coloring Pages*, *Animal Coloring Pages*,
   *Seasonal & Holiday Coloring Pages*, *Community Helpers Coloring Pages*,
   *Kids Coloring Pages*, *Patriotic Coloring Pages*, plus a default
   *Printable Coloring Books*.
3. **Verify**: run the workflow with mode `verify` — it confirms the token,
   flags any missing theme board, and prints the product menu.
4. That's it — with `auto_enqueue` on, the daily schedule publishes the catalogue
   over time and picks up new products automatically. To hand-pick instead, set
   `auto_enqueue: false` in `data/pinterest-queue.json` and add entries yourself.

### Tuning

In `data/pinterest-queue.json`:

- `auto_enqueue` (default `true`) — add every catalogue product automatically.
- `recycle_after_days` (default `45`) — re-pin a product this many days after its
  last post; set `0` to pin each product once and stop.
- Per-entry `board` / `title` / `description` override the defaults for that product.

`MAX_PER_RUN` (default 5) controls how many Pins post per run (workflow env).

### Run the publisher locally (optional)

```bash
PINTEREST_APP_ID=... PINTEREST_APP_SECRET=... PINTEREST_REFRESH_TOKEN=... \
  MODE=verify node scripts/pinterest-publish.mjs
```

`MODE=publish` posts up to `MAX_PER_RUN` (default 5) eligible Pins; `DRY_RUN=1`
logs what would post without calling the API.

## Free coloring pages (lead magnet)

Every coloring book gives away **one real page from the book** at
`/free/<slug>`, and `/free` is the gallery of all of them. The pages are free
with no email gate: the funnel is Pinterest → free page → Etsy, and an email
wall at the top of it costs more traffic than it earns.

The assets are **not** generated in this repo. `pipeline/free_pages.py` in the
`etsy-coloring-studio` repo (which is where the actual page art lives) renders
them and writes them here:

```bash
# from ~/etsy-coloring-studio, against a checkout of this repo
./venv/bin/python pipeline/free_pages.py --site-dir /path/to/Bliss-Fox
```

It emits, per book:

| Path | What |
|---|---|
| `free/pages/<slug>.pdf` | the download — US Letter, 300 DPI, bilevel (~100 KB) |
| `assets/free/<slug>.jpg` | web preview shown on the site |
| `assets/pins/<slug>.jpg` | the Pinterest pin — the page art alone, filling the frame |
| `free/<slug>.html` | landing page (the Pin's destination) |
| `data/free-pages.json` | manifest — the Pin publisher reads this |

**Which page gets given away** is chosen automatically: the page closest to that
book's *own median* ink density. An absolute threshold doesn't work here — ink
coverage varies ~50× between a fine mandala book and a bold kawaii one, and
counting dark pixels on a downscale erases hairline art entirely (a dense
mermaid page scores near zero and looks blank). Vision-QA-flagged pages,
near-duplicates and blank pages are excluded, and `page_001` is deprioritised
because it is the style-lock reference and usually already the listing hero.

Re-running the script is idempotent — the same page is picked each time unless
the book's art changes.

**Pin dimensions follow the page, not the other way round.** 77 books render portrait
pages (0.690 w:h), which cover Pinterest's preferred 2:3 frame losing ~17px a side —
the drawn page border sits further in than that, so it survives. The other 26 render
square pages; cropping those to 2:3 would cut a third of their width off, so they get a
square 1000×1000 pin instead, which Pinterest accepts. Either way the art is never
letterboxed and fills 100% of the pin. `--pin-style` still offers the captioned layouts
(`tall`, `card`, `bleed`) if the wording is ever wanted back.

### Free-page Pins

`scripts/pinterest-free-publish.mjs` + `.github/workflows/pinterest-free-publish.yml`
post these to Pinterest, **separately** from the product Pin job so the campaign
can be paused or retimed on its own:

- 2 Pins/day (14:41 and 21:19 UTC), 1 per run.
- Links go to `blissfoxstudio.com/free/<slug>`, not Etsy — an on-domain link on
  a claimed domain, which Pinterest distributes better than an outbound one.
- Images are the pre-rendered pins; **no Replicate credit is used**. The pin is the
  page art and nothing else — no caption, no logo, no badge. The "free" hook lives in
  the Pin title and description, which Pinterest renders beside the image.
- Copy rotates through 4 title/description angles, so a recycled Pin for the same
  page reads differently (`recycle_after_days`, default 30).
- Ledger: `data/pinterest-free-queue.json` (self-maintaining, don't hand-edit).

**One-time setup:** create a board named **Free Printable Coloring Pages** in the
Pinterest UI — "free printable coloring pages" is a high-volume search term and
keeps the giveaway's analytics separate from the product pins. Until it exists
the publisher falls back to the matching theme board, so nothing breaks. Then run
the workflow once with mode `verify` to confirm the token, board and eligible pages.

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
- `/free` — gallery of every free coloring page
- `/free/<slug>` — a single free page's landing page (the Pinterest destination)
- `/free/pages/<slug>.pdf` — the free page itself
- `/download` and `/download/` — return the branded 404 on purpose (no index)
- `/download/<kit-slug>` — a private, passcode-gated per-kit download page

## Passcode-gated download pages

Post-purchase downloads are **per-kit** pages under `/download/<unguessable-slug>`.
Each page is **passcode-gated**: the kit's R2 base URL is encrypted (PBKDF2 +
AES-GCM) with the buyer passcode, so the page source shows only ciphertext until
someone enters the right code. The bare `/download` path 404s — there's no menu
of products to browse. Pages are `noindex` and kept out of `sitemap.xml`.

**Add / update a kit:**

1. Upload the kit's PDFs to R2 under a fresh, unguessable path,
   e.g. `https://files.blissfoxstudio.com/<new-secret-path>/kit/<size>/…`.
2. Create `scripts/kits/<kit>.json` describing the **structure only** (product
   name, `urlSlug`, `filePrefix`, `sizes`, `sections`, `bonus`, `splitSizes`).
   See `scripts/kits/book-of-shadows.json` for the shape. This file is safe to
   commit — it contains no secrets.
3. Generate the page, passing the secret base URL and passcode via env (they are
   **never written to disk** — only the encrypted page is emitted):

   ```bash
   BASE_URL='https://files.blissfoxstudio.com/<new-secret-path>/kit' \
   PASSCODE='the-code-you-give-buyers' \
   node scripts/make-download-page.mjs <kit>
   ```

4. Commit the generated `download/<urlSlug>.html`, push, and share the URL +
   passcode with buyers (e.g. in the Etsy delivery message).

**Security notes:** the R2 files themselves are public URLs, so the passcode
protects *discovery* of the link set, not a file whose direct URL a buyer
reshares. For stronger protection, put the R2 bucket behind Cloudflare Access or
signed URLs. Never commit a kit's plaintext base URL or passcode; rotate the R2
path if a base URL is ever exposed.

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
- `scripts/pinterest-publish.mjs` — organic Pin publisher (self-maintaining queue)
- `data/pinterest-queue.json` — auto-maintained publish queue/ledger
- `.github/workflows/pinterest-publish.yml` — scheduled/manual Pin publishing
- `docs/pinterest-standard-access.md` — Pinterest Standard-access application guide
- `assets/site.css` — shared design system
- `assets/site.js` — mobile nav, catalog rendering + theme filter, footer year
- `assets/download-gate.js` — passcode unlock + link rendering for download pages
- `scripts/make-download-page.mjs` — generator for passcode-gated per-kit pages
- `scripts/kits/*.json` — non-secret kit definitions (structure only)
- `download/<slug>.html` — generated, passcode-gated download pages
- `free.html`, `free/<slug>.html` — free-page gallery + landing pages (generated)
- `free/pages/*.pdf`, `assets/free/*.jpg`, `assets/pins/*.jpg` — free-page assets (generated)
- `data/free-pages.json` — free-page manifest (generated)
- `scripts/pinterest-free-publish.mjs` — free-page Pin publisher
- `data/pinterest-free-queue.json` — free-page Pin ledger (auto-maintained)
- `.github/workflows/pinterest-free-publish.yml` — scheduled free-page Pin publishing
- `robots.txt`, `sitemap.xml`

## Marketplace note

All sales run through the Bliss Fox Studio Etsy shop as instant digital downloads.
Product images and links in the catalog come from the live Etsy listings via the
Etsy Open API. Do not add product images, prices, or listing content by hand — the
sync keeps everything in step with Etsy.
