# Bliss Fox Studio — site

Static, no build step. Drop the whole folder at your web root and it works.

## Structure
- `index.html` — home / hub
- `books.html` — full catalog with client-side theme filter
- `books/*.html` — one page per title (generated, identical structure)
- `privacy.html` — privacy + Amazon Associates + children's-privacy template
- `404.html` — on-brand not-found
- `assets/site.css` — single design system (change styling here once, applies everywhere)
- `assets/site.js` — mobile nav, newsletter handler, catalog filter, footer year
- `robots.txt`, `sitemap.xml`

## Assets you still provide (same paths as before)
- `/assets/bliss-fox-studio-logo.png`
- `/assets/generated/hero-fox-studio.webp`
- `/assets/generated/about-creative-pages.webp`
- `/assets/generated/icon-physical-books.webp`
- `/assets/generated/icon-printable-pdfs.webp`
- `/assets/generated/icon-gift-themes.webp`
Book covers load from Amazon's CDN with an automatic fallback to the logo if a URL breaks.

## Before you publish (find/replace)
1. `https://blissfoxstudio.com` — set to your real domain across all files (canonical, OG, JSON-LD, sitemap, robots).
2. `privacy.html` — fill `[ADD DATE]`, `[NAME YOUR PROVIDER]`, `[NAME ANALYTICS TOOL IF USED]`, `[ADD CONTACT EMAIL]`.
3. Book pages — the Etsy/Amazon buttons currently use search URLs. Swap each for the direct listing / ASIN product URL (marked with a comment in each book file).

## Wire the newsletter
In `assets/site.js`, the signup handler shows an inline confirmation and has a `// TODO`. POST `input.value` to your n8n webhook or paste a MailerLite/ConvertKit/Beehiiv embed.

## Add a new book
Copy any file in `books/`, or regenerate: the source generator builds all book pages from one data block so they never drift. Add a matching `.book-card` (with `data-themes`) to `books.html` and a `<url>` to `sitemap.xml`.
