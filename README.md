# Bliss Fox Studio Website

A static landing page for Bliss Fox Studio — physical coloring books on Amazon KDP and digital copies on Etsy.

This repo is ready to run on a VPS through **Coolify** using Dockerfile deployment.

## Files

- `index.html` — complete one-page website with inline CSS
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

- Etsy: https://www.etsy.com/shop/BlissFoxStudio
- Amazon search placeholder: https://www.amazon.com/s?k=Bliss+Fox+Studio+coloring+book

## Recommended next edits

1. Replace the Amazon search URL with your real Amazon Author Central page or KDP book links.
2. Replace the placeholder collection cards with real cover images.
3. Connect the newsletter form to MailerLite, ConvertKit, Beehiiv, or another email tool.
4. Point `blissfoxstudio.com` to the Coolify VPS and enable HTTPS in Coolify.
