# Bliss Fox Studio Website

A static landing page for Bliss Fox Studio — physical coloring books on Amazon KDP and digital copies on Etsy.

This repo is ready to run on a VPS through **Coolify** using Dockerfile deployment.

## Files

- `index.html` — complete one-page website with inline CSS
- `privacy.html` — standalone privacy policy page linked from the nav/footer
- `Dockerfile` — production container using Nginx Alpine
- `nginx.conf` — static-site Nginx config with `/healthz`
- `docker-compose.yml` — optional local/VPS compose runner
- `.dockerignore` — keeps build context clean

## Preview locally without Docker

```bash
cd /home/ashley-harris/blissfoxstudio-website
python3 -m http.server 8765
```

Then open: <http://127.0.0.1:8765>

## Run locally with Docker

```bash
cd /home/ashley-harris/blissfoxstudio-website
docker build -t blissfoxstudio-website .
docker run --rm -p 8080:80 blissfoxstudio-website
```

Then open: <http://127.0.0.1:8080>

Health check:

```bash
curl http://127.0.0.1:8080/healthz
```

Expected output:

```text
ok
```

## Run locally with Docker Compose

```bash
docker compose up -d --build
```

Then open: <http://127.0.0.1:8080>

Stop it:

```bash
docker compose down
```

## Deploy on Coolify

1. In Coolify, create a new **Resource**.
2. Choose **Public Repository** or connect your GitHub account.
3. Repository: `https://github.com/Ashley4734/Bliss-Fox.git`
4. Branch: `main`
5. Build pack / deployment type: **Dockerfile**
6. Dockerfile location: `/Dockerfile`
7. Exposed port: `80`
8. Health check path: `/healthz`
9. Add your domain, for example: `blissfoxstudio.com`
10. Deploy.

No database or environment variables are required.

## Current shop links

- Etsy shop: https://www.etsy.com/shop/BlissFoxStudio
- Amazon KDP author page: https://www.amazon.com/Bliss-Fox-Studio/e/B0GZFBTS87/

## Content notes

- The homepage now uses the official Etsy shop link.
- The homepage now routes physical paperback CTAs to the Bliss Fox Studio Amazon KDP author page.
- Featured book cards use externally loaded Amazon media URLs for live cover previews rather than storing Amazon images in this repository.
- The site uses the official Bliss Fox Studio Etsy-hosted logo/banner URL in the navbar, hero section, about section, and social preview metadata.
- `/privacy.html` provides a basic privacy policy covering marketplace links, server logs, cookies/analytics status, and the current placeholder newsletter form.

## Recommended next edits

1. Add direct links for each individual Amazon book once you want product-specific landing cards.
2. Add direct Etsy listing links for matching digital downloads.
3. Connect the newsletter form to MailerLite, ConvertKit, Beehiiv, or another email tool.
4. Point `blissfoxstudio.com` to the Coolify VPS and enable HTTPS in Coolify.
