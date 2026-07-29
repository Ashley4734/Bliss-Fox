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

You can sanity-check the credentials from any terminal:

```bash
curl -s -H "x-api-key: KEYSTRING:SHARED_SECRET" \
  https://openapi.etsy.com/v3/application/openapi-ping
# → {"application_id": ...}  means the credentials work
```

Once both secrets are set, open the Actions tab and run the workflow once to populate
the catalog immediately. Until then the site shows a friendly "shop on Etsy" prompt
instead of product cards.

### Run the sync locally (optional)

```bash
ETSY_API_KEY=your_keystring ETSY_SHARED_SECRET=your_shared_secret \
  node scripts/sync-etsy.mjs
```

Requires Node 18+ (uses built-in `fetch`; no dependencies).

## Runtime routes

- `/` or `/index.html` — homepage / brand hub (featured downloads from Etsy)
- `/books.html` — full catalog, generated from `data/products.json`
- `/about.html` — about the studio
- `/privacy.html` — privacy policy
- `/data/products.json` — the catalog data file (served static)
- `/404.html` — branded not-found page
- `/robots.txt` — crawler rules
- `/sitemap.xml` — sitemap
- `/healthz` — Docker/Coolify health check, returns `ok`

## Local verification

```bash
docker build -t blissfoxstudio-website .
docker rm -f blissfoxstudio-website-test 2>/dev/null || true
docker run -d --name blissfoxstudio-website-test -p 8095:80 blissfoxstudio-website
curl -fsS http://127.0.0.1:8095/healthz
curl -I http://127.0.0.1:8095/books.html
curl -fsS http://127.0.0.1:8095/data/products.json | head
docker rm -f blissfoxstudio-website-test
```

## Structure

- `Dockerfile` — Nginx static-site container for Coolify
- `nginx.conf` — static routing, `/healthz`, asset caching, security headers, branded 404
- `docker-compose.yml` — optional local runner
- `.dockerignore` — keeps build context clean
- `index.html` — home / hub
- `books.html` — full catalog (renders from `data/products.json`)
- `about.html` — about page
- `privacy.html` — privacy + Etsy marketplace disclosure page
- `404.html` — on-brand not-found page
- `data/products.json` — Etsy catalog data (auto-generated)
- `scripts/sync-etsy.mjs` — Etsy → `products.json` sync script
- `.github/workflows/sync-etsy.yml` — scheduled catalog sync
- `assets/site.css` — shared design system
- `assets/site.js` — mobile nav, catalog rendering + theme filter, footer year
- `robots.txt`, `sitemap.xml`

## Marketplace note

All sales run through the Bliss Fox Studio Etsy shop as instant digital downloads.
Product images and links in the catalog come from the live Etsy listings via the
Etsy Open API. Do not add product images, prices, or listing content by hand — the
sync keeps everything in step with Etsy.
