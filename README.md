# Bliss Fox Studio — Coolify Static Site

Static HTML/CSS/JS brand hub for Bliss Fox Studio coloring books. This repo is packaged for direct GitHub-to-Coolify deployment with Docker + Nginx.

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

After the app is created, attach your domain in Coolify and enable HTTPS.

## Runtime routes

- `/` or `/index.html` — homepage / brand hub
- `/books.html` — full coloring book catalog
- `/books/brave-little-firehouse-cuties.html` — book detail page
- `/books/spellbound-dragon-sanctuary.html` — book detail page
- `/books/spooky-sweet-halloween-cutie-pals.html` — book detail page
- `/books/cozy-coffee-shop-critters.html` — book detail page
- `/privacy.html` — privacy policy
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
docker rm -f blissfoxstudio-website-test
```

## Structure

- `Dockerfile` — Nginx static-site container for Coolify
- `nginx.conf` — static routing, `/healthz`, asset caching, security headers, branded 404
- `docker-compose.yml` — optional local runner
- `.dockerignore` — keeps build context clean
- `index.html` — home / hub
- `books.html` — full catalog with client-side theme filter
- `books/*.html` — one page per title
- `privacy.html` — privacy + marketplace disclosure page
- `404.html` — on-brand not-found page
- `assets/site.css` — shared design system
- `assets/site.js` — mobile nav, catalog filter, footer year
- `robots.txt`, `sitemap.xml`

## Marketplace note

Book covers currently load from Amazon's CDN with a fallback to the Bliss Fox Studio logo. The Etsy/Amazon buttons use shop/search URLs where exact listing URLs are not known yet. Replace those with direct Etsy listing URLs and direct Amazon product/ASIN URLs when available for better conversion.

Do not add locally stored Amazon product images, prices, ratings, review counts, or availability unless the content is licensed/API-served and compliant with Amazon rules.
