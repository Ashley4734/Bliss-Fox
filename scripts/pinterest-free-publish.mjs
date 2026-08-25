#!/usr/bin/env node
/**
 * Free-page Pin publisher — Bliss Fox Studio.
 *
 * Posts organic Pins for the *free* coloring pages at /free/<slug>. Kept
 * separate from scripts/pinterest-publish.mjs on purpose: that job sells
 * products (Etsy links, Replicate-generated lifestyle art, variant rotation),
 * this one gives a page away (on-site links, pre-rendered art). Separating them
 * means this campaign can be paused, retimed or rewritten without touching the
 * daily product drip, and the two show up as distinct campaigns in analytics.
 *
 * Pin art is NOT generated here. `pipeline/free_pages.py` in the etsy-coloring-studio
 * repo renders it from the real page art and commits it to /assets/pins/. The pin is
 * the artwork alone — no caption or logo baked in — so the copy below is what carries
 * the "free" hook, and it is the only place that wording exists.
 *
 * Modes (MODE env):
 *   verify   — check the token, boards and manifest; post nothing (default)
 *   publish  — post up to MAX_PER_RUN eligible Pins
 *
 * Env: PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REFRESH_TOKEN
 *      MAX_PER_RUN (default 3), DRY_RUN=1, PINTEREST_ENV=sandbox
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENV = (process.env.PINTEREST_ENV || 'production').trim().toLowerCase();
const IS_SANDBOX = ENV === 'sandbox';
const API = `${IS_SANDBOX ? 'https://api-sandbox.pinterest.com' : 'https://api.pinterest.com'}/v5`;
const TOKEN_URL = `${API}/oauth/token`;
const SITE_HOST = 'https://blissfoxstudio.com';

const APP_ID = (process.env.PINTEREST_APP_ID || '').trim();
const APP_SECRET = (process.env.PINTEREST_APP_SECRET || '').trim();
const REFRESH_TOKEN_VAR = IS_SANDBOX ? 'PINTEREST_SANDBOX_REFRESH_TOKEN' : 'PINTEREST_REFRESH_TOKEN';
const REFRESH_TOKEN = (process.env[REFRESH_TOKEN_VAR] || '').trim();

const MODE = (process.env.MODE || 'verify').trim().toLowerCase();
const MAX_PER_RUN = Math.max(1, Number.parseInt(process.env.MAX_PER_RUN || '3', 10) || 3);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FREE_FILE = join(__dirname, '..', 'data', 'free-pages.json');
const QUEUE_FILE = join(__dirname, '..', 'data', 'pinterest-free-queue.json');

const DAY_MS = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Freebies go to one dedicated board by default: "free printable coloring pages"
// is a high-volume Pinterest search term in its own right, and keeping the
// giveaway on its own board keeps its analytics separate from the product pins.
const DEFAULT_FREE_BOARD = 'Free Printable Coloring Pages';

// Fallback boards if the dedicated one doesn't exist yet.
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

const THEME_HASHTAGS = {
  cozy: '#cottagecore',
  spooky: '#halloween',
  fantasy: '#fantasyart',
  animals: '#cuteanimals',
  seasonal: '#seasonal',
  professions: '#communityhelpers',
  kids: '#kidsactivities',
  patriotic: '#usa',
};

// Order the queue by what actually earns traffic, not alphabetically. The
// 2026-07-26 shop audit measured views/listing/day by theme: holiday & seasonal
// 1.02, cozy scenes 0.81, goth/witchy 0.80, floral 0.48, kawaii 0.39, plain
// animals 0.19, careers 0.18. Lower rank posts first; untagged sits mid-table.
const THEME_RANK = {
  seasonal: 0, cozy: 1, spooky: 2, fantasy: 3, patriotic: 4, kids: 5, animals: 6, professions: 7,
};
const UNTAGGED_RANK = 4;

// Month (0=Jan) -> themes to push to the front, so timely pages go out while the
// search traffic is ramping. The audit's finding was that seasonal books need a
// 6-8 week lead, so Halloween starts in August, not October.
const SEASONAL_FIRST = {
  0: ['cozy'],
  1: ['seasonal'],
  4: ['patriotic'],
  5: ['patriotic'],
  6: ['patriotic'],
  7: ['spooky', 'seasonal'],
  8: ['spooky', 'seasonal'],
  9: ['spooky', 'seasonal'],
  10: ['seasonal'],
  11: ['seasonal'],
};

function themeRank(item) {
  const ranks = (item.themes || []).map((t) => THEME_RANK[t]).filter((n) => n !== undefined);
  return ranks.length ? Math.min(...ranks) : UNTAGGED_RANK;
}

// Rotating title/description angles so a recycled Pin for the same page reads
// differently. Index comes from the ledger's angle_i, advanced on each post.
const TITLE_ANGLES = [
  (t) => `Free ${t} Coloring Page (Printable PDF)`,
  (t) => `Free Printable ${t} Coloring Page`,
  (t) => `${t} Coloring Page — Free Printable Download`,
  (t) => `Free ${t} Coloring Sheet to Print at Home`,
];

const DESC_ANGLES = [
  (i) => `Print this ${i.short} coloring page free — no signup, no email. A full-size PDF sized for US Letter that prints on any home printer.`,
  (i) => `Grab a free ${i.short} coloring page to print at home. Instant PDF download, ready for pencils, markers or gel pens.`,
  (i) => `A free printable ${i.short} coloring page — download the PDF, print it, and colour it in tonight. No signup needed.`,
  (i) => `Free ${i.short} coloring page for a calm evening in. Print as many copies as you like for personal or classroom use.`,
];

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

function clamp(text, max) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

function hashtagsFor(item) {
  const tags = [];
  for (const t of item.themes || []) if (THEME_HASHTAGS[t]) tags.push(THEME_HASHTAGS[t]);
  tags.push('#freeprintable', '#coloringpages');
  return [...new Set(tags)].slice(0, 3).join(' ');
}

function buildCopy(item, angleIndex) {
  const short = item.short_title || 'Coloring';
  const title = clamp(TITLE_ANGLES[angleIndex % TITLE_ANGLES.length](short), 100);
  const lead = DESC_ANGLES[angleIndex % DESC_ANGLES.length]({ short });
  const upsell = item.page_count
    ? ` Love it? The full ${item.page_count}-page book is an instant download on Etsy.`
    : ' Love it? The full book is an instant download on Etsy.';
  const description = clamp(`${lead}${upsell} ${hashtagsFor(item)}`, 500);
  const alt = clamp(`Black and white printable ${short} coloring page from Bliss Fox Studio`, 200);
  return { title, description, alt_text: alt };
}

function boardNameFor(item, freeBoard, boards) {
  // Prefer the dedicated free board; if it isn't created yet, fall back to the
  // product theme board so a missing board never silently stops the campaign.
  if (boardIdByName(boards, freeBoard)) return freeBoard;
  const theme = (item.themes || []).find((t) => THEME_BOARDS[t]);
  return (theme && THEME_BOARDS[theme]) || 'Printable Coloring Books';
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function loadQueue() {
  const q = await loadJson(QUEUE_FILE, {});
  return {
    _readme:
      'Self-maintaining ledger for the FREE-PAGE Pin campaign. Every entry in ' +
      'data/free-pages.json is enqueued automatically; recycle_after_days makes a page ' +
      'eligible to re-pin (with a different copy angle) that many days after its last post. ' +
      'You normally do not need to edit this file.',
    auto_enqueue: q.auto_enqueue !== false,
    recycle_after_days: Number.isFinite(q.recycle_after_days) ? q.recycle_after_days : 30,
    free_board: q.free_board || DEFAULT_FREE_BOARD,
    pins: Array.isArray(q.pins) ? q.pins : [],
  };
}

function eligibleToPost(entry, recycleDays, now) {
  if (!entry.posted) return true;
  if (!recycleDays) return false;
  const last = Date.parse(entry.posted_at || '');
  return Number.isFinite(last) && now - last >= recycleDays * DAY_MS;
}

async function runVerify(token) {
  const manifest = await loadJson(FREE_FILE, { pages: [] });
  const pages = manifest.pages || [];
  const queue = await loadQueue();
  const boards = await listBoards(token);

  console.log(`Token OK (${ENV}). ${boards.length} board(s) on the account.`);
  console.log(`Manifest: ${pages.length} free page(s) in data/free-pages.json.`);

  const freeBoardId = boardIdByName(boards, queue.free_board);
  if (freeBoardId) {
    console.log(`✓ Dedicated board "${queue.free_board}" found.`);
  } else {
    console.warn(
      `! Board "${queue.free_board}" does NOT exist. Create it in the Pinterest UI ` +
        `for a clean free-page campaign; until then pins fall back to theme boards.`
    );
    const needed = new Set();
    for (const it of pages) needed.add(boardNameFor(it, queue.free_board, boards));
    for (const name of needed) {
      console.log(`  fallback board "${name}": ${boardIdByName(boards, name) ? 'found' : 'MISSING'}`);
    }
  }

  const now = Date.now();
  const due = pages.filter((it) => {
    const e = queue.pins.find((x) => x.slug === it.slug);
    return !e || eligibleToPost(e, queue.recycle_after_days, now);
  });
  console.log(`${due.length} page(s) eligible to post right now (MAX_PER_RUN=${MAX_PER_RUN}).`);
  for (const it of due.slice(0, 5)) {
    const copy = buildCopy(it, 0);
    console.log(`  · ${copy.title}`);
    console.log(`      → ${SITE_HOST}/free/${it.slug}`);
  }
}

async function runPublish(token) {
  const manifest = await loadJson(FREE_FILE, { pages: [] });
  const pages = manifest.pages || [];
  if (!pages.length) {
    console.error('No free pages in data/free-pages.json — nothing to publish.');
    return;
  }
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const queue = await loadQueue();
  let dirty = false;

  if (queue.auto_enqueue) {
    const known = new Set(queue.pins.map((e) => e.slug));
    let added = 0;
    for (const p of pages) {
      if (!known.has(p.slug)) {
        queue.pins.push({ slug: p.slug, posted: false });
        known.add(p.slug);
        added++;
      }
    }
    if (added) {
      dirty = true;
      console.log(`Auto-enqueued ${added} new free page(s).`);
    }
  }

  const now = Date.now();
  const neverPosted = queue.pins.filter((e) => !e.posted && bySlug.has(e.slug));
  const recyclable = queue.pins
    .filter((e) => e.posted && bySlug.has(e.slug) && eligibleToPost(e, queue.recycle_after_days, now))
    .sort((a, b) => Date.parse(a.posted_at || 0) - Date.parse(b.posted_at || 0));
  const boost = SEASONAL_FIRST[new Date().getMonth()] || [];
  const isBoosted = (e) => (bySlug.get(e.slug).themes || []).some((t) => boost.includes(t));
  const candidates = [...neverPosted, ...recyclable]
    .map((e, i) => ({ e, i, b: isBoosted(e) ? 0 : 1, r: themeRank(bySlug.get(e.slug)) }))
    .sort((x, y) => x.b - y.b || x.r - y.r || x.i - y.i)
    .map((x) => x.e);

  console.log(
    `Free-page queue: ${queue.pins.length} page(s); ${neverPosted.length} never-posted, ` +
      `${recyclable.length} recycle-eligible.` +
      (boost.length ? ` Seasonal boost this month: ${boost.join(', ')}.` : '') +
      ` Publishing up to ${MAX_PER_RUN}` + (DRY_RUN ? ' (DRY RUN)…' : '…')
  );

  const boards = candidates.length ? await listBoards(token) : [];
  let published = 0;   // Pins actually created
  let previewed = 0;   // dry-run only: what a real run would have posted

  for (const entry of candidates) {
    if (published + previewed >= MAX_PER_RUN) break;
    const item = bySlug.get(entry.slug);
    if (!item) continue;

    const boardName = boardNameFor(item, queue.free_board, boards);
    const boardId = boardIdByName(boards, boardName);
    if (!boardId) {
      console.warn(`  skip "${item.short_title}": board "${boardName}" not found — create it first.`);
      continue;
    }

    const angleIndex = Number.isInteger(entry.angle_i) ? entry.angle_i : 0;
    const copy = buildCopy(item, angleIndex);
    const link = `${SITE_HOST}/free/${item.slug}`;
    const imageUrl = `${SITE_HOST}${item.pin}`;

    if (DRY_RUN) {
      console.log(`  [dry] "${copy.title}" → ${boardName}`);
      console.log(`        link: ${link}`);
      console.log(`        img:  ${imageUrl}`);
      console.log(`        desc: ${copy.description}`);
      previewed++;
      continue;
    }

    try {
      await api(token, '/pins', {
        method: 'POST',
        body: {
          board_id: boardId,
          title: copy.title,
          description: copy.description,
          alt_text: copy.alt_text,
          link,
          media_source: { source_type: 'image_url', url: imageUrl },
        },
      });
      entry.posted = true;
      entry.posted_at = new Date().toISOString();
      entry.angle_i = angleIndex + 1;
      dirty = true;
      published++;
      console.log(`  ✓ pinned "${copy.title}" → ${boardName}`);
      await sleep(1500);
    } catch (err) {
      console.error(`  ✗ failed "${copy.title}": ${err.message}`);
    }
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — nothing was posted. ${previewed} Pin(s) would have gone out.`);
  }
  if (dirty) {
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
    console.log(`Updated data/pinterest-free-queue.json (${published} newly posted this run).`);
  } else {
    console.log(`No queue changes (${published} posted).`);
  }
}

async function main() {
  requireAuth();
  const token = await getAccessToken();
  if (MODE === 'publish') await runPublish(token);
  else await runVerify(token);
}

// Only run when invoked directly, so the pure copy helpers above can be
// imported and asserted on without the script trying to reach Pinterest.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { buildCopy, hashtagsFor, clamp, eligibleToPost, TITLE_ANGLES, DESC_ANGLES };
