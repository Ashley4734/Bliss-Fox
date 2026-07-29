#!/usr/bin/env node
/**
 * Bliss Fox Studio — Etsy digital-download catalog sync.
 *
 * Pulls the shop's ACTIVE Etsy listings via the Etsy Open API v3 and writes
 * them to data/products.json, which the website renders. Run on a schedule by
 * .github/workflows/sync-etsy.yml so the catalog stays in step with the shop:
 * add a listing on Etsy, and it shows up on the site on the next sync.
 *
 * Auth: read-only public listing data only needs an app API key (keystring),
 * passed as the ETSY_API_KEY environment variable. No per-user OAuth required.
 *
 * Env:
 *   ETSY_API_KEY   (required) Etsy app keystring — create at
 *                  https://www.etsy.com/developers/your-apps
 *   ETSY_SHOP_NAME (optional) defaults to "BlissFoxStudio"
 *
 * Node 18+ (uses global fetch). No dependencies.
 *
 * Auth: this app authenticates at the app level with BOTH credentials in the
 * x-api-key header, formatted as "<keystring>:<shared_secret>". Etsy rejects the
 * keystring alone with "Shared secret is required in x-api-key header." So both
 * ETSY_API_KEY (keystring) and ETSY_SHARED_SECRET must be provided.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://openapi.etsy.com/v3/application';
const SHOP_NAME = (process.env.ETSY_SHOP_NAME || 'BlissFoxStudio').trim();
// Trim to strip any stray whitespace/newline pasted into the secrets — a value
// with a trailing newline makes an invalid header.
const API_KEY = (process.env.ETSY_API_KEY || '').trim();
const SHARED_SECRET = (process.env.ETSY_SHARED_SECRET || '').trim();
// Etsy expects the shared secret alongside the keystring in the x-api-key header.
const X_API_KEY = SHARED_SECRET ? `${API_KEY}:${SHARED_SECRET}` : API_KEY;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'data', 'products.json');

/* Map Etsy tags / title keywords onto the site's theme filter vocabulary.
   Keep the theme keys in sync with the filter chips the site renders. */
const THEME_KEYWORDS = {
  cozy: ['cozy', 'cosy', 'cottagecore', 'comfort', 'relax', 'calm', 'coffee', 'cafe', 'tea'],
  spooky: ['spooky', 'halloween', 'goth', 'witch', 'ghost', 'skeleton', 'creepy', 'pumpkin'],
  fantasy: ['fantasy', 'dragon', 'magic', 'magical', 'fairy', 'mermaid', 'unicorn', 'wizard'],
  animals: ['animal', 'animals', 'cat', 'kitten', 'dog', 'fox', 'critter', 'kawaii', 'chibi', 'shark', 'puppy'],
  seasonal: ['seasonal', 'holiday', 'christmas', 'winter', 'valentine', 'easter', 'thanksgiving', 'diwali', 'juneteenth', 'wedding', 'birthday', 'father', 'mother', 'summer', 'spring', 'autumn', 'fall'],
  professions: ['firefighter', 'police', 'teacher', 'doctor', 'nurse', 'mechanic', 'construction', 'electrician', 'emt', 'helper', 'job', 'career', 'trade'],
  kids: ['kid', 'kids', 'children', 'child', 'toddler', 'preschool', 'boys', 'girls'],
  patriotic: ['patriotic', 'america', 'usa', 'independence', 'july', 'flag', 'freedom'],
};

function deriveThemes(title, tags) {
  const haystack = (title + ' ' + tags.join(' ')).toLowerCase();
  const themes = [];
  for (const [theme, words] of Object.entries(THEME_KEYWORDS)) {
    if (words.some((w) => haystack.includes(w))) themes.push(theme);
  }
  return themes;
}

function shorten(text, max = 180) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/[\s,.;:!-]+\S*$/, '') + '…';
}

async function etsyGet(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      headers: {
        'x-api-key': X_API_KEY,
        Accept: 'application/json',
        'User-Agent': 'BlissFoxStudio-catalog-sync',
      },
      redirect: 'follow',
    });
    // Back off and retry on rate limiting (Etsy allows ~5 requests/second).
    if (res.status === 429 && attempt < 4) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Etsy API ${res.status} for ${path}: ${body.slice(0, 300)}\n` +
          'This is an authentication failure. Check the ETSY_API_KEY (keystring) and\n' +
          'ETSY_SHARED_SECRET repository secrets — both are required, with no extra\n' +
          'spaces or newlines. Find them at https://www.etsy.com/developers/your-apps'
      );
    }
    throw new Error(`Etsy API ${res.status} ${res.statusText} for ${path}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

/* Verify the API key works before doing real work, so failures are obvious. */
async function pingApiKey() {
  const data = await etsyGet('/openapi-ping');
  return data;
}

async function resolveShopId(name) {
  const data = await etsyGet('/shops', { shop_name: name });
  const results = data.results || [];
  // Prefer an exact (case-insensitive) shop-name match, else the first result.
  const exact = results.find((s) => (s.shop_name || '').toLowerCase() === name.toLowerCase());
  const shop = exact || results[0];
  if (!shop) throw new Error(`No Etsy shop found for name "${name}".`);
  return shop.shop_id;
}

async function fetchActiveListings(shopId) {
  const listings = [];
  const limit = 100;
  let offset = 0;
  for (;;) {
    const data = await etsyGet(`/shops/${shopId}/listings/active`, {
      limit,
      offset,
      includes: 'Images',
    });
    const batch = data.results || [];
    listings.push(...batch);
    const total = typeof data.count === 'number' ? data.count : batch.length;
    offset += limit;
    if (batch.length < limit || offset >= total) break;
  }
  return listings;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickImageUrl(imgObj) {
  const img = imgObj || {};
  return (
    img.url_570xN ||
    img.url_680x540 ||
    img.url_fullxfull ||
    img.url_300x300 ||
    ''
  );
}

function pickImage(listing) {
  const imgs = listing.images || [];
  return pickImageUrl(imgs[0]);
}

// The active-listings endpoint does not reliably honor includes=Images, so
// fetch a listing's primary image from the dedicated images endpoint.
async function fetchListingImage(listingId) {
  try {
    const data = await etsyGet(`/listings/${listingId}/images`, { limit: 1 });
    return pickImageUrl((data.results || [])[0]);
  } catch (err) {
    console.warn(`  image fetch failed for listing ${listingId}: ${String(err.message).split('\n')[0]}`);
    return '';
  }
}

// Run async work over items with a bounded number of workers (keeps request
// rate under Etsy's ~5/sec limit).
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function formatPrice(price) {
  if (!price || typeof price.amount !== 'number' || !price.divisor) return null;
  const value = price.amount / price.divisor;
  return {
    amount: Number(value.toFixed(2)),
    currency: price.currency_code || 'USD',
    display: new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency_code || 'USD',
    }).format(value),
  };
}

function toProduct(listing) {
  const tags = (listing.tags || []).map((t) => String(t).toLowerCase());
  const title = listing.title || 'Untitled listing';
  return {
    listing_id: listing.listing_id,
    title,
    description: shorten(listing.description),
    url: listing.url || `https://www.etsy.com/listing/${listing.listing_id}/`,
    image: pickImage(listing),
    price: formatPrice(listing.price),
    tags,
    themes: deriveThemes(title, tags),
    created: listing.created_timestamp || listing.original_creation_timestamp || 0,
  };
}

async function main() {
  if (!API_KEY) {
    console.error(
      'ERROR: ETSY_API_KEY is not set (or is empty after trimming).\n' +
        'Create an Etsy app at https://www.etsy.com/developers/your-apps to get a\n' +
        'keystring, then add it as the ETSY_API_KEY repository secret.'
    );
    process.exit(1);
  }
  if (!SHARED_SECRET) {
    console.error(
      'ERROR: ETSY_SHARED_SECRET is not set (or is empty after trimming).\n' +
        "This app authenticates with the keystring AND the app's Shared Secret.\n" +
        'Copy the Shared Secret from https://www.etsy.com/developers/your-apps and\n' +
        'add it as the ETSY_SHARED_SECRET repository secret.'
    );
    process.exit(1);
  }
  console.log(
    `Using API key (length ${API_KEY.length}) + shared secret (length ${SHARED_SECRET.length}).`
  );

  console.log('Verifying API key with Etsy ping…');
  await pingApiKey();
  console.log('API key OK.');

  console.log(`Resolving Etsy shop "${SHOP_NAME}"…`);
  const shopId = await resolveShopId(SHOP_NAME);
  console.log(`Shop id: ${shopId}`);

  console.log('Fetching active listings…');
  const listings = await fetchActiveListings(shopId);
  console.log(`Fetched ${listings.length} active listing(s).`);

  const products = listings
    .map(toProduct)
    .sort((a, b) => (b.created || 0) - (a.created || 0));

  // Backfill cover images for any listing that didn't include one inline.
  const missing = products.filter((p) => !p.image);
  if (missing.length) {
    console.log(`Fetching cover images for ${missing.length} listing(s)…`);
    await mapPool(missing, 4, async (p) => {
      p.image = await fetchListingImage(p.listing_id);
    });
    const stillMissing = products.filter((p) => !p.image).length;
    console.log(
      `Cover images resolved for ${missing.length - stillMissing}/${missing.length} listing(s).`
    );
  }

  const payload = {
    shop: SHOP_NAME,
    shop_url: `https://www.etsy.com/shop/${SHOP_NAME}`,
    updated: new Date().toISOString(),
    count: products.length,
    products,
  };

  // Preserve the previous good catalog if Etsy returns an empty set unexpectedly
  // (e.g. transient API hiccup) so the live site never blanks out.
  if (products.length === 0) {
    try {
      const prev = JSON.parse(await readFile(OUT_FILE, 'utf8'));
      if (prev.products && prev.products.length > 0) {
        console.warn(
          `Etsy returned 0 listings but ${prev.products.length} existed before. ` +
            'Keeping the previous catalog to avoid emptying the site.'
        );
        process.exit(0);
      }
    } catch {
      /* no previous file — fall through and write the empty catalog */
    }
  }

  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${products.length} product(s) to data/products.json`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
