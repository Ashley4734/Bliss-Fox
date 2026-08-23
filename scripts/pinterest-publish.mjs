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
 *              seasonal themes, writes Pin copy (LLM or template), and (by
 *              default) generates original Pin art via openai/gpt-image-2 on
 *              Replicate using the product's hero image as a reference. Each
 *              product rotates through creative VARIANTS (a storefront "cover"
 *              plus softer, Pinterest-native "lifestyle" scenes) across posts.
 *   preview  — generate a sample image for every variant of a few products into
 *              data/pin-previews/<timestamp>/ with an index.html contact sheet,
 *              WITHOUT posting anything. Needs only REPLICATE_API_TOKEN (no
 *              Pinterest auth). Use it to eyeball styles before going live.
 *   demo     — create a board, create a Pin, read it back (sandbox; review video).
 *
 * Queue (data/pinterest-queue.json) config:
 *   auto_enqueue        add every catalogue product automatically (default true)
 *   recycle_after_days  days before a posted product may re-pin (default 45; 0 = once)
 *   image_source        "replicate" (generate art from the hero image) or "etsy"
 *                       (use the cover as-is); default replicate
 *   copy_source         "llm" (generate varied copy) or "template"; default llm
 *   pin_variants        which creative variants to rotate through and in what
 *                       order (default: all — cover, hands, flatlay, finished,
 *                       scene). New products lead with the cover.
 *   default_board       board for products with no theme match
 *   pins[]              per-product state {listing_id, posted, posted_at,
 *                       variant_i (rotation counter), optional
 *                       board/title/description overrides}
 *
 * Environment:
 *   PINTEREST_ENV        "production" (default) or "sandbox"
 *   MODE, MAX_PER_RUN (default 2; small daily drip), DRY_RUN ("1"), IMAGE_SOURCE, COPY_SOURCE
 *   PIN_VARIANT          force one variant id (e.g. "flatlay") instead of rotating
 *   PREVIEW_PRODUCTS     preview mode: how many products to sample (default 2)
 *   PREVIEW_LISTING_ID   preview mode: sample only this listing_id
 *   PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REFRESH_TOKEN
 *   PINTEREST_SANDBOX_REFRESH_TOKEN (demo only)
 *   REPLICATE_API_TOKEN  required for image_source=replicate and copy_source=llm
 *   REPLICATE_MODEL      image model, default "openai/gpt-image-2"
 *   REPLICATE_TEXT_MODEL text model, default "meta/meta-llama-3-70b-instruct"
 *   IMAGE_QUALITY        default "medium" (low | medium | high | auto)
 *   IMAGE_ASPECT_RATIO   default "2:3" (portrait)
 *
 * Data handling: the queue stores only OUR OWN data (Etsy listing_id + a posted
 * flag/date). Board ids are resolved from board NAMES at run time and never
 * persisted, so no data retrieved from the Pinterest API is stored.
 *
 * Node 18+ (global fetch). No dependencies.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
// Default to a small, steady daily drip. A new/low-authority account earns more
// per-pin distribution from consistent posting than from large bursts, so keep
// this low and run the publisher often (e.g. once or twice a day).
const MAX_PER_RUN = Math.max(1, Number.parseInt(process.env.MAX_PER_RUN || '2', 10) || 2);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const REPLICATE_TOKEN = (process.env.REPLICATE_API_TOKEN || '').trim();
const REPLICATE_MODEL = (process.env.REPLICATE_MODEL || 'openai/gpt-image-2').trim();
const REPLICATE_TEXT_MODEL = (process.env.REPLICATE_TEXT_MODEL || 'meta/meta-llama-3-70b-instruct').trim();
const IMAGE_QUALITY = (process.env.IMAGE_QUALITY || 'medium').trim();
const IMAGE_ASPECT_RATIO = (process.env.IMAGE_ASPECT_RATIO || '2:3').trim();
const FORCED_VARIANT = (process.env.PIN_VARIANT || '').trim().toLowerCase();
const PREVIEW_PRODUCTS = Math.max(1, Number.parseInt(process.env.PREVIEW_PRODUCTS || '2', 10) || 2);
const PREVIEW_LISTING_ID = (process.env.PREVIEW_LISTING_ID || '').trim();

const DAY_MS = 86400000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = join(__dirname, '..', 'data', 'products.json');
const QUEUE_FILE = join(__dirname, '..', 'data', 'pinterest-queue.json');
const PREVIEW_ROOT = join(__dirname, '..', 'data', 'pin-previews');

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

// SEO hashtags added to every template Pin, plus per-theme extras.
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

// Rotating copy angles so the same product reads differently across pins.
const COPY_ANGLES = [
  'relaxation and self-care',
  'a thoughtful, budget-friendly gift',
  'the specific theme and characters',
  'instant printable at-home convenience',
  'a seasonal or holiday tie-in',
];

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

// ---- Replicate (shared) ----------------------------------------------------

// Create a Replicate prediction and wait for the result, retrying on 429
// throttling (new/low-spend accounts are limited to ~6 req/min, burst 1).
// Honors the Retry-After header. Returns the succeeded prediction or null.
async function replicateRun(model, input, { maxRetries = 6 } = {}) {
  if (!REPLICATE_TOKEN) return null;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REPLICATE_TOKEN}`,
          'Content-Type': 'application/json',
          Prefer: 'wait',
        },
        body: JSON.stringify({ input }),
      });
    } catch (err) {
      console.warn(`  Replicate request failed: ${err.message}`);
      return null;
    }
    if (res.status === 429 && attempt < maxRetries) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = (Number.isFinite(ra) && ra > 0 ? ra : 12) * 1000;
      console.warn(`  Replicate throttled (429); waiting ${Math.round(waitMs / 1000)}s then retrying…`);
      await sleep(waitMs);
      continue;
    }
    let pred = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`  Replicate error ${res.status} (${model}): ${JSON.stringify(pred).slice(0, 160)}`);
      return null;
    }
    let tries = 0;
    while (pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status) && tries < 60) {
      await sleep(2000);
      try {
        const g = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
        pred = await g.json();
      } catch {
        break;
      }
      tries++;
    }
    if (pred.status !== 'succeeded') {
      console.warn(`  Replicate ${model} did not succeed (status: ${pred.status}).`);
      return null;
    }
    return pred;
  }
}

// ---- Template copy (fallback) ---------------------------------------------

// Keep hashtags few and targeted: theme-specific tags first, then a couple of
// base tags, capped at 3. Long hashtag stacks read as spam and don't aid reach.
function buildHashtags(product) {
  const themeTags = [];
  for (const t of product.themes || []) for (const h of THEME_HASHTAGS[t] || []) themeTags.push(h);
  const tags = [...new Set([...themeTags, ...BASE_HASHTAGS])];
  return tags.slice(0, 3).join(' ');
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

// ---- LLM copy via Replicate -----------------------------------------------

// Strip surrounding quotes/asterisks/space a small model sometimes adds.
function cleanField(s) {
  return String(s || '').replace(/^["'*\s]+/, '').replace(/["'*\s]+$/, '').trim();
}

// Parse the TITLE:/DESCRIPTION:/HASHTAGS:/ALT: delimited response.
function parseCopyFields(text) {
  if (!text) return null;
  const grab = (label) => {
    const m = text.match(new RegExp('^\\s*' + label + '\\s*:\\s*(.+)$', 'im'));
    return m ? cleanField(m[1]) : '';
  };
  const title = grab('TITLE');
  const description = grab('DESCRIPTION');
  if (!title || !description) return null;
  return { title, description, hashtags: grab('HASHTAGS'), alt: grab('ALT') };
}

// Generate unique Pin copy (title/description/alt_text) or null on failure.
async function generateCopy(product, boardName) {
  const angle = COPY_ANGLES[Math.floor(Math.random() * COPY_ANGLES.length)];
  const month = new Date().toLocaleString('en-US', { month: 'long' });
  const themes = (product.themes || []).join(', ') || 'general';
  const keywords = (product.tags || []).slice(0, 8).join(', ');
  const system =
    'You are a Pinterest SEO copywriter for Bliss Fox Studio, a shop that sells ' +
    'printable, instant-download digital coloring books. Pinterest is a search engine: ' +
    'lead with the words a shopper would actually type, keep it natural and human, and ' +
    'never invent product features that are not provided.';
  const user = [
    `Product: "${product.title}"`,
    product.description ? `Details: ${clamp(product.description, 300)}` : '',
    `Themes: ${themes}`,
    keywords ? `Target keywords (weave the best ones in naturally; do not just list them): ${keywords}` : '',
    `Board: ${boardName}`,
    `Current month: ${month}`,
    `Angle to emphasize this time: ${angle}`,
    '',
    'Reply in EXACTLY this format and nothing else (no preamble, no markdown, one line each):',
    'TITLE: <pin title, max 60 characters, LEAD with the main search keyword/theme, no hashtags, no "PDF" or "instant download">',
    'DESCRIPTION: <1-2 natural sentences, max 300 characters. Put the most important search keywords in the FIRST sentence, then a soft call to action. No hashtags.>',
    'HASHTAGS: <2-3 space-separated lowercase hashtags, each starting with #>',
    'ALT: <plain description of the image for accessibility, max 200 characters>',
  ]
    .filter(Boolean)
    .join('\n');

  const pred = await replicateRun(REPLICATE_TEXT_MODEL, {
    prompt: user,
    system_prompt: system,
    max_tokens: 400,
    temperature: 0.9,
  });
  if (!pred) return null;
  const raw = Array.isArray(pred.output) ? pred.output.join('') : pred.output || '';
  const parsed = parseCopyFields(raw);
  if (!parsed) {
    if (raw) console.warn(`  copy parse failed; raw output: ${clamp(raw, 200)}`);
    return null;
  }
  const tags = (parsed.hashtags.match(/#[\w]+/g) || []).slice(0, 3);
  const description = clamp(`${parsed.description} ${tags.join(' ')}`.trim(), 500);
  return {
    title: clamp(parsed.title, 70),
    description,
    alt_text: parsed.alt ? clamp(parsed.alt, 500) : undefined,
  };
}

// Resolve final copy: manual overrides win, then LLM (if enabled), then template.
async function resolveCopy(entry, product, boardName, copySource) {
  if (copySource === 'llm') {
    const gen = await generateCopy(product, boardName);
    if (gen) {
      return {
        title: clamp(entry.title || gen.title, 100),
        description: clamp(entry.description || gen.description, 500),
        alt_text: gen.alt_text,
        source: 'llm',
      };
    }
    console.warn(`  copy: LLM unavailable for "${product.title}", using template.`);
  }
  return {
    title: clamp(entry.title || buildTitle(product), 100),
    description: clamp(entry.description || buildDescription(product), 500),
    alt_text: undefined,
    source: 'template',
  };
}

// ---- Image generation via openai/gpt-image-2 on Replicate ------------------

// Lifestyle staging by theme, so the props match the book's mood instead of
// always defaulting to cottagecore (which clashes on spooky/goth books).
const LIFESTYLE_MOODS = {
  spooky: {
    surface: 'a dark wood or black cloth surface',
    props: 'lit candles, dried dark roses, a few small crystals, and a black mug',
    light: 'moody low light with warm candle glow',
    vibe: 'witchy and atmospheric',
  },
  fantasy: {
    surface: 'a rustic wood surface',
    props: 'candles, small crystals, dried flowers, and an open old book',
    light: 'soft warm light',
    vibe: 'whimsical and enchanted',
  },
  patriotic: {
    surface: 'a clean white or light wood surface',
    props: 'red, white, and blue colored pencils, a small flag, and a few star accents',
    light: 'bright daylight',
    vibe: 'cheerful and celebratory',
  },
  seasonal: {
    surface: 'a rustic wood surface',
    props: 'seasonal touches like pinecones, evergreen sprigs, string lights, and a warm mug of cocoa',
    light: 'warm cozy glow',
    vibe: 'festive and cozy',
  },
  professions: {
    surface: 'a tidy bright desk',
    props: 'crayons and markers in primary colors and a small toy',
    light: 'bright cheerful daylight',
    vibe: 'playful and wholesome',
  },
  kids: {
    surface: 'a bright wooden desk or light play table',
    props: 'chunky crayons and markers in bright colors and a couple of small toys',
    light: 'bright cheerful daylight',
    vibe: 'playful and colorful',
  },
  animals: {
    surface: 'a light wood or linen surface',
    props: 'colored pencils, a leafy green plant, and a ceramic mug',
    light: 'bright natural light',
    vibe: 'fresh and cheerful',
  },
  cozy: {
    surface: 'a wooden or linen surface',
    props: 'a warm mug and a small plant',
    light: 'soft natural light',
    vibe: 'cozy cottagecore',
  },
};
// Products often carry several themes; pick the mood by this fixed priority
// (most distinctive first) rather than the order themes happen to be listed in.
const MOOD_PRIORITY = ['spooky', 'patriotic', 'seasonal', 'fantasy', 'professions', 'kids', 'animals', 'cozy'];
const DEFAULT_MOOD = LIFESTYLE_MOODS.cozy;
function lifestyleMood(product) {
  const themes = new Set(product.themes || []);
  for (const t of MOOD_PRIORITY) if (themes.has(t)) return LIFESTYLE_MOODS[t];
  return DEFAULT_MOOD;
}

// Pin creative variants. The product's hero image is always passed as the
// reference so gpt-image-2 keeps the actual line-art subjects. "cover"
// reproduces the storefront cover (strong intro, reads as a listing); the rest
// are softer "lifestyle" scenes that read as inspiration and tend to earn more
// saves. Lifestyle staging is theme-aware (see lifestyleMood); variants
// deliberately carry NO sales text or badges.
const PIN_VARIANTS = [
  {
    id: 'cover',
    label: 'Product cover',
    prompt: (product) =>
      `Create a Pinterest pin based on the attached image that will help sell the ` +
      `digital coloring book "${clamp(product.title, 90)}". Vertical 2:3 layout, ` +
      `eye-catching and clickable for Pinterest shoppers, preserve the coloring-page ` +
      `line-art style from the reference. Only include a page count, rating, price, or ` +
      `other numeric claim if it clearly appears in the reference image; otherwise do ` +
      `not add any numbers or invented claims. Tasteful, no watermark.`,
  },
  {
    id: 'hands',
    label: 'Hands coloring',
    prompt: (product) => {
      const m = lifestyleMood(product);
      return (
        `Create a lifestyle Pinterest pin for the printable coloring book ` +
        `"${clamp(product.title, 90)}". Show a person's hand holding a colored pencil, ` +
        `partway through coloring one of the book's actual pages — use the same line-art ` +
        `style and subjects as the attached reference. Staged with ${m.props} to match the ` +
        `book's mood; ${m.vibe}, ${m.light}, vertical 2:3, the coloring page as the hero. ` +
        `Realistic hand and pencil. No text, no badges, no watermark, no invented claims.`
      );
    },
  },
  {
    id: 'flatlay',
    label: 'Styled flat-lay',
    prompt: (product) => {
      const m = lifestyleMood(product);
      return (
        `Create a top-down flat-lay Pinterest pin for the printable coloring book ` +
        `"${clamp(product.title, 90)}". Show one of the book's printed pages (matching the ` +
        `line-art style and subjects in the attached reference) on ${m.surface}, styled ` +
        `with colored pencils plus ${m.props}. ${m.vibe} mood, ${m.light}, vertical 2:3. ` +
        `The staging must match the book's mood. No text, no badges, no watermark, no invented claims.`
      );
    },
  },
  {
    id: 'finished',
    label: 'Before / after',
    prompt: (product) =>
      `Create a before-and-after Pinterest pin for the printable coloring book ` +
      `"${clamp(product.title, 90)}". Show one of the book's pages beautifully colored in ` +
      `next to the same page as blank black-and-white line art, matching the style and ` +
      `subjects of the attached reference. Clean and inspiring, vertical 2:3, showing the ` +
      `coloring payoff. Minimal or no text, no badges, no watermark, no invented claims.`,
  },
  {
    id: 'scene',
    label: 'Single scene',
    prompt: (product) =>
      `Create a Pinterest pin that spotlights a single illustration from the coloring ` +
      `book "${clamp(product.title, 90)}". Crop in on one charming scene from the attached ` +
      `reference's line-art, as a clean vertical 2:3 image with generous margins. Let the ` +
      `artwork be the focus. Minimal or no text, no badges, no watermark, no invented claims.`,
  },
];

const VARIANT_BY_ID = new Map(PIN_VARIANTS.map((v) => [v.id, v]));
const DEFAULT_VARIANT = VARIANT_BY_ID.get('cover');

// The ordered list of variant ids to rotate through, from queue config or all.
function variantOrder(queue) {
  const wanted = Array.isArray(queue && queue.pin_variants) ? queue.pin_variants : null;
  const ids = (wanted && wanted.length ? wanted : PIN_VARIANTS.map((v) => v.id))
    .map((id) => String(id).trim().toLowerCase())
    .filter((id) => VARIANT_BY_ID.has(id));
  return ids.length ? ids : ['cover'];
}

// Rotation index for an entry's next post. Entries posted before rotation
// tracking existed (variant_i unset but posted=true) already had their cover
// posted, so start them at index 1 (the first lifestyle variant) instead of
// repeating the cover. Never-posted entries lead with the cover at index 0.
function startIndexFor(entry) {
  if (Number.isInteger(entry && entry.variant_i)) return entry.variant_i;
  return entry && entry.posted ? 1 : 0;
}

// Pick the variant for this post: a forced override (env) wins; otherwise the
// rotation index selects the id in the order. Returns { variant, index } so the
// caller can advance the counter by the index actually used.
function variantForEntry(entry, order) {
  if (FORCED_VARIANT && VARIANT_BY_ID.has(FORCED_VARIANT)) {
    return { variant: VARIANT_BY_ID.get(FORCED_VARIANT), index: startIndexFor(entry), forced: true };
  }
  const index = startIndexFor(entry);
  return { variant: VARIANT_BY_ID.get(order[index % order.length]) || DEFAULT_VARIANT, index, forced: false };
}

async function generateReplicateImage(product, variant) {
  if (!REPLICATE_TOKEN || !product.image) return null;
  const pred = await replicateRun(REPLICATE_MODEL, {
    prompt: (variant || DEFAULT_VARIANT).prompt(product),
    input_images: [product.image],
    aspect_ratio: IMAGE_ASPECT_RATIO,
    quality: IMAGE_QUALITY,
    number_of_images: 1,
  });
  if (!pred) return null;
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  return typeof out === 'string' && out ? out : null;
}

async function resolvePinMedia(product, imageSource, variant) {
  const v = variant || DEFAULT_VARIANT;
  if (imageSource === 'replicate') {
    const url = await generateReplicateImage(product, v);
    if (url) return { mediaSource: { source_type: 'image_url', url }, source: `replicate:${v.id}` };
    console.warn(`  falling back to Etsy image for "${product.title}" (Replicate unavailable).`);
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
    `\nImage source: ${(process.env.IMAGE_SOURCE || 'replicate')} (model ${REPLICATE_MODEL}, quality ${IMAGE_QUALITY}). ` +
      `Copy source: ${(process.env.COPY_SOURCE || 'llm')} (model ${REPLICATE_TEXT_MODEL}). ` +
      `Replicate token ${REPLICATE_TOKEN ? 'present' : 'MISSING → falls back to Etsy image + template copy'}.`
  );
  console.log(
    `Pin variants: ${PIN_VARIANTS.map((v) => v.id).join(', ')} (rotated per product; ` +
      `force one with PIN_VARIANT, restrict/reorder with queue.pin_variants). ` +
      `Preview them with MODE=preview.`
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
  const imageSource = (process.env.IMAGE_SOURCE || queue.image_source || 'replicate').trim().toLowerCase();
  const copySource = (process.env.COPY_SOURCE || queue.copy_source || 'llm').trim().toLowerCase();
  const varOrder = variantOrder(queue);
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

  const varDesc = FORCED_VARIANT && VARIANT_BY_ID.has(FORCED_VARIANT)
    ? `forced ${FORCED_VARIANT}`
    : `rotating ${varOrder.join(' → ')}`;
  console.log(
    `Queue: ${queue.pins.length} product(s); ${neverPosted.length} never-posted, ` +
      `${recyclable.length} recycle-eligible. Image: ${imageSource} (${varDesc}), copy: ${copySource}. ` +
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
    const { variant, index: variantIndex, forced: variantForced } = variantForEntry(entry, varOrder);

    if (DRY_RUN) {
      const copy = await resolveCopy(entry, product, boardName, copySource);
      console.log(`  [dry] "${copy.title}" → ${boardName} (image: ${imageSource}/${variant.id}, copy: ${copy.source})`);
      console.log(`        desc: ${copy.description}`);
      if (copy.alt_text) console.log(`        alt:  ${copy.alt_text}`);
      published++;
      continue;
    }

    const media = await resolvePinMedia(product, imageSource, variant);
    if (!media) {
      console.warn(`  skip "${product.title}": no image available.`);
      continue;
    }
    const copy = await resolveCopy(entry, product, boardName, copySource);
    const body = {
      board_id: boardId,
      title: copy.title,
      description: copy.description,
      link: onDomainLink(product.url),
      media_source: media.mediaSource,
    };
    if (copy.alt_text) body.alt_text = copy.alt_text;
    try {
      await api(token, '/pins', { method: 'POST', body });
      entry.posted = true;
      entry.posted_at = new Date().toISOString();
      // Advance the rotation past the index actually used, so the next post for
      // this product moves to the following variant. A forced variant (env) does
      // not move the pointer.
      if (!variantForced) entry.variant_i = variantIndex + 1;
      dirty = true;
      published++;
      console.log(`  ✓ pinned "${body.title}" → ${boardName} [${media.source}/${copy.source}]`);
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

// ---- Preview mode (no posting) --------------------------------------------

// Fetch a generated image URL to disk, choosing an extension from its type.
async function downloadImage(url, dir, base) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  const ext = ct.includes('webp') ? 'webp' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'png';
  const file = `${base}.${ext}`;
  await writeFile(join(dir, file), Buffer.from(await res.arrayBuffer()));
  return file;
}

function previewProducts(products) {
  const withImage = products.filter((p) => p.image);
  if (PREVIEW_LISTING_ID) {
    const hit = withImage.filter((p) => String(p.listing_id) === PREVIEW_LISTING_ID);
    if (!hit.length) throw new Error(`PREVIEW_LISTING_ID ${PREVIEW_LISTING_ID} not found (or has no image).`);
    return hit;
  }
  return withImage.slice(0, PREVIEW_PRODUCTS);
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function previewIndexHtml(stamp, rows) {
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.listing_id)) byProduct.set(r.listing_id, { title: r.title, items: [] });
    byProduct.get(r.listing_id).items.push(r);
  }
  const sections = [...byProduct.values()]
    .map((g) => {
      const cards = g.items
        .map(
          (r) => `
      <figure>
        ${r.file ? `<img src="${escHtml(r.file)}" alt="${escHtml(r.label)}">` : `<div class="fail">generation failed</div>`}
        <figcaption><strong>${escHtml(r.label)}</strong><br><span>${escHtml(r.variant)}</span></figcaption>
      </figure>`
        )
        .join('');
      return `<section><h2>${escHtml(g.title)}</h2><div class="row">${cards}</div></section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pin variant preview ${escHtml(stamp)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:24px;background:#faf8f5;color:#222}
  h1{font-size:20px} h2{font-size:16px;margin-top:32px}
  .row{display:flex;flex-wrap:wrap;gap:16px}
  figure{margin:0;width:220px}
  img{width:220px;height:330px;object-fit:cover;border-radius:8px;box-shadow:0 1px 6px rgba(0,0,0,.15)}
  .fail{width:220px;height:330px;display:flex;align-items:center;justify-content:center;background:#eee;border-radius:8px;color:#999;font-size:13px}
  figcaption{font-size:13px;margin-top:6px} figcaption span{color:#888}
</style></head><body>
<h1>Bliss Fox — Pinterest pin variant preview</h1>
<p>Generated ${escHtml(stamp)} · model ${escHtml(REPLICATE_MODEL)} · quality ${escHtml(IMAGE_QUALITY)} · aspect ${escHtml(IMAGE_ASPECT_RATIO)}</p>
${sections}
</body></html>`;
}

async function runPreview() {
  if (!REPLICATE_TOKEN) {
    console.error('ERROR: preview mode needs REPLICATE_API_TOKEN (it generates images, but posts nothing).');
    process.exit(1);
  }
  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  const picks = previewProducts(products);
  const queue = await loadQueue();
  const variants =
    FORCED_VARIANT && VARIANT_BY_ID.has(FORCED_VARIANT)
      ? [VARIANT_BY_ID.get(FORCED_VARIANT)]
      : variantOrder(queue).map((id) => VARIANT_BY_ID.get(id));

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = join(PREVIEW_ROOT, stamp);
  await mkdir(dir, { recursive: true });
  console.log(`Preview (${ENV}): ${picks.length} product(s) × ${variants.length} variant(s) → ${dir}`);

  const rows = [];
  for (const product of picks) {
    for (const variant of variants) {
      process.stdout.write(`  ${product.listing_id} / ${variant.id} … `);
      const url = await generateReplicateImage(product, variant);
      let file = null;
      if (url) {
        try {
          file = await downloadImage(url, dir, `${product.listing_id}-${variant.id}`);
          console.log('ok');
        } catch (err) {
          console.log(`saved image URL only (download failed: ${err.message})`);
        }
      } else {
        console.log('generation failed');
      }
      rows.push({
        listing_id: product.listing_id,
        title: product.title,
        variant: variant.id,
        label: variant.label,
        url,
        file,
        prompt: variant.prompt(product),
      });
    }
  }

  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      { generated: new Date().toISOString(), model: REPLICATE_MODEL, quality: IMAGE_QUALITY, aspect_ratio: IMAGE_ASPECT_RATIO, rows },
      null,
      2
    ) + '\n',
    'utf8'
  );
  await writeFile(join(dir, 'index.html'), previewIndexHtml(stamp, rows), 'utf8');
  const ok = rows.filter((r) => r.file).length;
  console.log(`\nDone: ${ok}/${rows.length} images saved. Open ${join(dir, 'index.html')} to compare variants.`);
}

async function main() {
  if (MODE === 'preview') return runPreview();
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
