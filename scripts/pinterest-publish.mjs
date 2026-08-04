#!/usr/bin/env node
/**
 * Bliss Fox Studio — Pinterest organic Pin publisher.
 *
 * Publishes Pins for the shop's own coloring-book products to the shop's own
 * themed boards. The account owner configures the tool to publish the shop's
 * catalogue; it only ever pins OUR OWN products, a few per run.
 *
 * Modes (set MODE, default "publish"):
 *   verify   — refresh the token, list boards, print a product menu. No Pins.
 *   publish  — publish up to MAX_PER_RUN eligible Pins. Auto-enqueues the whole
 *              catalogue, recycles posted products after a cooldown, prioritises
 *              seasonal themes, writes keyword-rich copy, and (by default)
 *              generates original Pin art with OpenAI gpt-image from the hero image.
 *   demo     — create a board, create a Pin, read it back (sandbox; review video).
 *
 * Queue (data/pinterest-queue.json) config:
 *   auto_enqueue        add every catalogue product automatically (default true)
 *   recycle_after_days  days before a posted product may re-pin (default 45; 0 = once)
 *   image_source        "openai" (generate art from the hero image) or "etsy"
 *                       (use the cover as-is); default openai
 *   default_board       board for products with no theme match
 *   pins[]              per-product state {listing_id, posted, posted_at, optional
 *                       board/title/description overrides}
 *
 * Environment:
 *   PINTEREST_ENV        "production" (default) or "sandbox"
 *   MODE, MAX_PER_RUN (default 5), DRY_RUN ("1"), IMAGE_SOURCE
 *   PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REFRESH_TOKEN
 *   PINTEREST_SANDBOX_REFRESH_TOKEN (demo only)
 *   OPENAI_API_KEY       required for image_source=openai (else falls back to Etsy)
 *   OPENAI_IMAGE_MODEL   default "gpt-image-2"
 *   OPENAI_IMAGE_SIZE    default "1024x1536" (portrait, ~2:3)
 *   OPENAI_IMAGE_QUALITY default "medium" (low | medium | high | auto) — cost control
 *
 * Data handling: the queue stores only OUR OWN data (Etsy listing_id + a posted
 * flag/date). Board ids are resolved from board NAMES at run time and never
 * persisted, so no data retrieved from the Pinterest API is stored.
 *
 * Node 18+ (global fetch/FormData/Blob). No dependencies.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = (process.env.PINTEREST_ENV || 'production').trim().toLowerCase();
const IS_SANDBOX = ENV === 'sandbox';
const API_HOST = IS_SANDBOX ? 'https://api-sandbox.pinterest.com' : 'https://api.pinterest.com';
const API = `${API_HOST}/v5`;
const TOKEN_URL = `${API}/oauth/token`;
const SITE_HOST = 'https://blissfoxstudio.com';

const APP_ID = (process.env.PINTEREST_APP_ID || '').trim();
const APP_SECRET = (process.env.PINTEREST_APP_SECRET || '').trim();
const REFRESH_TOKEN_VAR = IS_SANDBOX ? 'PINTEREST_SANDBOX_REFRESH_TOKEN' : 'PINTEREST_REFRESH_TOKEN';
const REFRESH_TOKEN = (process.env[REFRESH_TOKEN_VAR] || '').trim();
const MODE = (process.env.MODE || 'publish').trim().toLowerCase();
const MAX_PER_RUN = Math.max(1, Number.parseInt(process.env.MAX_PER_RUN || '5', 10) || 5);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_IMAGE_MODEL = (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2').trim();
const OPENAI_IMAGE_SIZE = (process.env.OPENAI_IMAGE_SIZE || '1024x1536').trim();
const OPENAI_IMAGE_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || 'medium').trim();

const DAY_MS = 86400000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = join(__dirname, '..', 'data', 'products.json');
const QUEUE_FILE = join(__dirname, '..', 'data', 'pinterest-queue.json');

// Map each product theme (from the Etsy sync) to the board it should be pinned
// to. Create boards with THESE EXACT names in the Pinterest UI; matching is
// case-insensitive. Products with no theme go to the queue's default_board.
const THEME_BOARDS = {
  cozy: 'Cozy Coloring Pages',
  spooky: 'Spooky Coloring Pages',
  fantasy: 'Fantasy Coloring Pages',
  animals: 'Animal Coloring Pages',
  seasonal: 'Seasonal & Holiday Coloring Pages',
  professions: 'Community Helpers Coloring Pages',
  kids: 'Kids Coloring Pages',
  patriotic: 'Patriotic Coloring Pages',
};

// SEO hashtags added to every Pin, plus per-theme extras.
const BASE_HASHTAGS = ['#coloringpages', '#printable', '#coloringbook', '#adultcoloring', '#instantdownload'];
const THEME_HASHTAGS = {
  cozy: ['#cottagecore', '#cozyvibes'],
  spooky: ['#halloween', '#spookyseason'],
  fantasy: ['#fantasyart', '#mythical'],
  animals: ['#cuteanimals', '#kawaii'],
  seasonal: ['#seasonal', '#holidayfun'],
  professions: ['#communityhelpers', '#kidsactivities'],
  kids: ['#kidsactivities', '#coloringforkids'],
  patriotic: ['#usa', '#redwhiteblue'],
};

// Month (0=Jan) -> themes to prioritise so timely products go out in season.
const SEASONAL_BOOST = {
  5: ['patriotic'], // June
  6: ['patriotic'], // July
  8: ['spooky'], // September
  9: ['spooky'], // October
  10: ['seasonal'], // November
  11: ['seasonal'], // December
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireAuth() {
  const missing = [];
  if (!APP_ID) missing.push('PINTEREST_APP_ID');
  if (!APP_SECRET) missing.push('PINTEREST_APP_SECRET');
  if (!REFRESH_TOKEN) missing.push(REFRESH_TOKEN_VAR);
  if (missing.length) {
    console.error(`ERROR: missing required secret(s): ${missing.join(', ')}.`);
    process.exit(1);
  }
}

async function getAccessToken() {
  const basic = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token refresh failed: HTTP ${res.status} (${ENV}). ` +
        `Check PINTEREST_APP_ID / PINTEREST_APP_SECRET / ${REFRESH_TOKEN_VAR}. Body: ${text.slice(0, 300)}`
    );
  }
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('Token refresh returned no access_token.');
  return data.access_token;
}

async function api(token, path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const msg = json && json.message ? json.message : text.slice(0, 300);
      const err = new Error(`Pinterest API ${res.status} for ${method} ${path}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
}

async function listBoards(token) {
  const boards = [];
  let bookmark = '';
  do {
    const q = new URLSearchParams({ page_size: '100' });
    if (bookmark) q.set('bookmark', bookmark);
    const data = await api(token, `/boards?${q.toString()}`);
    for (const b of data.items || []) boards.push({ id: b.id, name: b.name });
    bookmark = data.bookmark || '';
  } while (bookmark);
  return boards;
}

function boardIdByName(boards, name) {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  const hit = boards.find((b) => (b.name || '').trim().toLowerCase() === target);
  return hit ? hit.id : null;
}

function onDomainLink(url) {
  try {
    return SITE_HOST + new URL(url).pathname;
  } catch {
    return SITE_HOST + '/';
  }
}

function clamp(text, max) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

function boardNameFor(entry, product, defaultBoard) {
  if (entry.board) return entry.board;
  const theme = (product.themes || []).find((t) => THEME_BOARDS[t]);
  return (theme && THEME_BOARDS[theme]) || defaultBoard;
}

// ---- Phase 2: SEO copy ----------------------------------------------------

function buildHashtags(product) {
  const tags = new Set(BASE_HASHTAGS);
  for (const t of product.themes || []) for (const h of THEME_HASHTAGS[t] || []) tags.add(h);
  return [...tags].slice(0, 10).join(' ');
}

function buildTitle(product) {
  return product.title || 'Printable Coloring Book';
}

function buildDescription(product) {
  const base = (product.description || product.title || '').replace(/\s+/g, ' ').trim();
  const cta = 'Instant-download printable coloring pages by Bliss Fox Studio — print at home and unwind.';
  const hashtags = buildHashtags(product);
  const tail = ` ${cta} ${hashtags}`;
  const room = Math.max(0, 500 - tail.length - 1);
  const head = base.length > room ? base.slice(0, room - 1).replace(/\s+\S*$/, '') + '…' : base;
  return `${head}${tail}`.trim();
}

// ---- Phase 2: OpenAI image generation (gpt-image, image-to-image) ----------

function pinImagePrompt(product) {
  const title = clamp(product.title, 90);
  return (
    `Create a Pinterest pin based on the attached image that will help sell the ` +
    `digital coloring book "${title}". Vertical 2:3 layout, eye-catching and ` +
    `clickable for Pinterest shoppers, preserve the coloring-page line-art style ` +
    `from the reference. Tasteful, no watermark.`
  );
}

// Generate an original Pin image with OpenAI using the product's hero image as a
// reference. Returns { b64, contentType } or null (caller falls back to Etsy).
async function generateOpenAIImage(product) {
  if (!OPENAI_API_KEY || !product.image) return null;
  try {
    const refRes = await fetch(product.image);
    if (!refRes.ok) {
      console.warn(`  reference image fetch failed (${refRes.status}).`);
      return null;
    }
    const refType = refRes.headers.get('content-type') || 'image/jpeg';
    const refBuf = Buffer.from(await refRes.arrayBuffer());
    const ext = refType.includes('png') ? 'png' : 'jpg';

    const form = new FormData();
    form.append('model', OPENAI_IMAGE_MODEL);
    form.append('prompt', pinImagePrompt(product));
    form.append('size', OPENAI_IMAGE_SIZE);
    form.append('quality', OPENAI_IMAGE_QUALITY);
    form.append('output_format', 'jpeg');
    form.append('image', new Blob([refBuf], { type: refType }), `reference.${ext}`);

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`  OpenAI image error ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      console.warn('  OpenAI returned no image data.');
      return null;
    }
    return { b64, contentType: 'image/jpeg' };
  } catch (err) {
    console.warn(`  OpenAI generation failed: ${err.message}`);
    return null;
  }
}

// Choose the Pin media: generated art (image_source=openai) or the Etsy cover.
async function resolvePinMedia(product, imageSource) {
  if (imageSource === 'openai') {
    const gen = await generateOpenAIImage(product);
    if (gen) {
      return {
        mediaSource: { source_type: 'image_base64', content_type: gen.contentType, data: gen.b64 },
        source: 'openai',
      };
    }
    console.warn(`  falling back to Etsy image for "${product.title}" (OpenAI unavailable).`);
  }
  if (product.image) {
    return { mediaSource: { source_type: 'image_url', url: product.image }, source: 'etsy' };
  }
  return null;
}

async function loadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadQueue() {
  try {
    return await loadJson(QUEUE_FILE);
  } catch {
    return { default_board: 'Printable Coloring Books', pins: [] };
  }
}

async function runVerify(token) {
  console.log(`Verifying Pinterest access (${ENV})…`);
  const boards = await listBoards(token);
  console.log(`\nToken OK. Found ${boards.length} board(s) on the account:`);
  for (const b of boards) console.log(`  • ${b.name}`);

  console.log('\nExpected board names (create these, case-insensitive match):');
  for (const name of new Set(Object.values(THEME_BOARDS))) console.log(`  • ${name}`);
  const missing = [...new Set(Object.values(THEME_BOARDS))].filter((n) => !boardIdByName(boards, n));
  if (missing.length) console.log(`\n⚠ Not found yet (create in the Pinterest UI): ${missing.join(', ')}`);
  else console.log('\n✓ All theme boards exist.');

  console.log(
    `\nImage source: ${(process.env.IMAGE_SOURCE || 'openai')} ` +
      `(OpenAI key ${OPENAI_API_KEY ? 'present' : 'MISSING → would fall back to Etsy'}, ` +
      `model ${OPENAI_IMAGE_MODEL}, ${OPENAI_IMAGE_SIZE}, quality ${OPENAI_IMAGE_QUALITY}).`
  );

  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  console.log(`\nProduct menu (${products.length}) — copy listing_id into the queue:`);
  for (const p of products) {
    const theme = (p.themes || []).find((t) => THEME_BOARDS[t]) || '-';
    console.log(`  ${p.listing_id}\t[${theme}]\t${p.title}`);
  }
  console.log('\nVerify complete. No Pins were created.');
}

async function runDemo(token) {
  console.log(`Pinterest API demo (${ENV}).`);
  if (!IS_SANDBOX) console.log('Note: demo is intended for PINTEREST_ENV=sandbox.');

  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  const product = products.find((p) => p.image) || products[0];
  if (!product) throw new Error('No products available to build a demo Pin.');

  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const boardName = `Bliss Fox Studio Demo ${stamp} UTC`;
  console.log(`\n[1/3] POST /boards — creating board "${boardName}"…`);
  const board = await api(token, '/boards', {
    method: 'POST',
    body: { name: boardName, description: 'Demo board created via the Pinterest API for standard-access review.' },
  });
  console.log(`      ✓ board created: id=${board.id}`);

  console.log(`\n[2/3] POST /pins — creating a Pin for "${product.title}"…`);
  const pin = await api(token, '/pins', {
    method: 'POST',
    body: {
      board_id: board.id,
      title: clamp(product.title, 100),
      description: clamp(product.description || product.title, 500),
      link: onDomainLink(product.url),
      media_source: { source_type: 'image_url', url: product.image },
    },
  });
  console.log(`      ✓ pin created: id=${pin.id}`);

  console.log(`\n[3/3] GET /pins/${pin.id} — reading the created Pin back…`);
  const fetched = await api(token, `/pins/${pin.id}`);
  console.log('      ✓ retrieved Pin:');
  console.log(JSON.stringify({ id: fetched.id, title: fetched.title, board_id: fetched.board_id, link: fetched.link, created_at: fetched.created_at }, null, 2));
  console.log('\nDemo complete: board + Pin created via the API and read back.');
}

function eligibleToPost(entry, recycleDays, now) {
  if (!entry.posted) return true;
  if (recycleDays > 0 && entry.posted_at) return now - Date.parse(entry.posted_at) >= recycleDays * DAY_MS;
  return false;
}

async function runPublish(token) {
  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  const byId = new Map(products.map((p) => [String(p.listing_id), p]));
  const queue = await loadQueue();
  const defaultBoard = queue.default_board || 'Printable Coloring Books';
  const autoEnqueue = queue.auto_enqueue !== false; // default ON
  const recycleDays = Number.isFinite(queue.recycle_after_days) ? queue.recycle_after_days : 45;
  const imageSource = (process.env.IMAGE_SOURCE || queue.image_source || 'openai').trim().toLowerCase();
  queue.pins = Array.isArray(queue.pins) ? queue.pins : [];

  let dirty = false;

  if (autoEnqueue) {
    const known = new Set(queue.pins.map((e) => String(e.listing_id)));
    let added = 0;
    for (const p of products) {
      if (!known.has(String(p.listing_id))) {
        queue.pins.push({ listing_id: p.listing_id, posted: false });
        known.add(String(p.listing_id));
        added++;
      }
    }
    if (added) {
      dirty = true;
      console.log(`Auto-enqueued ${added} new product(s) from the catalogue.`);
    }
  }

  const now = Date.now();
  const neverPosted = queue.pins.filter((e) => !e.posted);
  const recyclable = queue.pins
    .filter((e) => e.posted && eligibleToPost(e, recycleDays, now))
    .sort((a, b) => Date.parse(a.posted_at || 0) - Date.parse(b.posted_at || 0));
  let candidates = [...neverPosted, ...recyclable];

  const boostThemes = SEASONAL_BOOST[new Date().getMonth()] || [];
  const isBoosted = (e) => {
    const p = byId.get(String(e.listing_id));
    return !!p && (p.themes || []).some((t) => boostThemes.includes(t));
  };
  if (boostThemes.length) {
    candidates = [...candidates.filter(isBoosted), ...candidates.filter((e) => !isBoosted(e))];
    console.log(`Seasonal boost this month: ${boostThemes.join(', ')}.`);
  }

  console.log(
    `Queue: ${queue.pins.length} product(s); ${neverPosted.length} never-posted, ` +
      `${recyclable.length} recycle-eligible. Image source: ${imageSource}. ` +
      `Publishing up to ${MAX_PER_RUN}` + (DRY_RUN ? ' (DRY RUN)…' : '…')
  );

  const boards = candidates.length ? await listBoards(token) : [];
  let published = 0;
  for (const entry of candidates) {
    if (published >= MAX_PER_RUN) break;
    const product = byId.get(String(entry.listing_id));
    if (!product) {
      console.warn(`  skip listing ${entry.listing_id}: not in products.json (removed on Etsy?)`);
      continue;
    }
    const boardName = boardNameFor(entry, product, defaultBoard);
    const boardId = boardIdByName(boards, boardName);
    if (!boardId) {
      console.warn(`  skip "${product.title}": board "${boardName}" not found — create it first.`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry] would pin "${buildTitle(product)}" → ${boardName} (image: ${imageSource})`);
      published++;
      continue;
    }

    const media = await resolvePinMedia(product, imageSource);
    if (!media) {
      console.warn(`  skip "${product.title}": no image available.`);
      continue;
    }
    const body = {
      board_id: boardId,
      title: clamp(entry.title || buildTitle(product), 100),
      description: clamp(entry.description || buildDescription(product), 500),
      link: onDomainLink(product.url),
      media_source: media.mediaSource,
    };
    try {
      await api(token, '/pins', { method: 'POST', body });
      entry.posted = true;
      entry.posted_at = new Date().toISOString();
      dirty = true;
      published++;
      console.log(`  ✓ pinned "${body.title}" → ${boardName} [${media.source}]`);
      await sleep(1500);
    } catch (err) {
      console.error(`  ✗ failed "${body.title}": ${err.message}`);
    }
  }

  if (dirty) {
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
    console.log(`\nUpdated data/pinterest-queue.json (${published} newly posted this run).`);
  } else {
    console.log(`\nNo changes (${published} posted).`);
  }
}

async function main() {
  requireAuth();
  const token = await getAccessToken();
  if (MODE === 'verify') await runVerify(token);
  else if (MODE === 'demo') await runDemo(token);
  else await runPublish(token);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
