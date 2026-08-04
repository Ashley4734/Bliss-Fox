#!/usr/bin/env node
/**
 * Bliss Fox Studio — Pinterest organic Pin publisher.
 *
 * Publishes Pins for coloring-book products that YOU have selected in
 * data/pinterest-queue.json. It never posts anything that is not in that
 * queue — this keeps the tool compliant with Pinterest's Developer Guidelines,
 * which require the account owner to choose each Pin that gets published.
 *
 * Modes (set MODE, default "publish"):
 *   verify   — refresh the token, list the account's boards, and print a menu
 *              of products (listing_id + title). Creates no Pins.
 *   publish  — publish up to MAX_PER_RUN queued-but-unposted Pins, then mark
 *              them posted in the queue.
 *   demo     — create a board, create a Pin, and read the Pin back. Intended
 *              for the Pinterest Standard-access review video, run against the
 *              SANDBOX (PINTEREST_ENV=sandbox). Does not touch the queue.
 *
 * Environment (set PINTEREST_ENV, default "production"):
 *   production — https://api.pinterest.com, uses PINTEREST_REFRESH_TOKEN
 *   sandbox    — https://api-sandbox.pinterest.com, uses
 *                PINTEREST_SANDBOX_REFRESH_TOKEN (isolated test environment;
 *                Trial apps can create Pins here but not in production)
 *
 * Data handling: the queue stores only OUR OWN data (Etsy listing_id + a
 * "posted" flag). Board ids are resolved from board NAMES at run time and are
 * never persisted, so no data retrieved from the Pinterest API is stored.
 *
 * Auth (repository secrets, refreshed each run):
 *   PINTEREST_APP_ID                app id (1596011)
 *   PINTEREST_APP_SECRET            app secret
 *   PINTEREST_REFRESH_TOKEN         production refresh token
 *   PINTEREST_SANDBOX_REFRESH_TOKEN sandbox refresh token (demo only)
 *
 * Optional env:
 *   MODE                 "verify" | "publish" | "demo"  (default "publish")
 *   PINTEREST_ENV        "production" | "sandbox"        (default "production")
 *   MAX_PER_RUN          max Pins to publish per run (default 5)
 *   DRY_RUN              "1" to log what would be posted without calling the API
 *
 * Node 18+ (global fetch). No dependencies.
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
// Production and sandbox use separate tokens (isolated environments).
const REFRESH_TOKEN_VAR = IS_SANDBOX ? 'PINTEREST_SANDBOX_REFRESH_TOKEN' : 'PINTEREST_REFRESH_TOKEN';
const REFRESH_TOKEN = (process.env[REFRESH_TOKEN_VAR] || '').trim();
const MODE = (process.env.MODE || 'publish').trim().toLowerCase();
const MAX_PER_RUN = Math.max(1, Number.parseInt(process.env.MAX_PER_RUN || '5', 10) || 5);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = join(__dirname, '..', 'data', 'products.json');
const QUEUE_FILE = join(__dirname, '..', 'data', 'pinterest-queue.json');

// Map each product theme (from the Etsy sync) to the board it should be pinned
// to. Create boards with THESE EXACT names in the Pinterest UI; matching is
// case-insensitive. Products with no theme (or an unmapped one) go to the
// queue's default_board.
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

// Exchange the stored refresh token for a short-lived access token.
async function getAccessToken() {
  const basic = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token refresh failed: HTTP ${res.status} (${ENV}). ` +
        `Check PINTEREST_APP_ID / PINTEREST_APP_SECRET / ${REFRESH_TOKEN_VAR}. ` +
        `Body: ${text.slice(0, 300)}`
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

// Fetch every board on the account (name + id). boards:read scope.
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

// Route feed/pin links through the claimed domain (nginx 301s /listing/... to
// Etsy), matching the Pinterest catalog feed's behaviour.
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

// The board a queued entry targets: explicit `board`, else derived from the
// product's first theme, else the queue default.
function boardNameFor(entry, product, defaultBoard) {
  if (entry.board) return entry.board;
  const theme = (product.themes || []).find((t) => THEME_BOARDS[t]);
  return (theme && THEME_BOARDS[theme]) || defaultBoard;
}

function buildPinBody(entry, product, boardId) {
  return {
    board_id: boardId,
    title: clamp(entry.title || product.title, 100),
    description: clamp(entry.description || product.description || product.title, 500),
    link: onDomainLink(product.url),
    media_source: { source_type: 'image_url', url: product.image },
  };
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
  const missing = [...new Set(Object.values(THEME_BOARDS))].filter(
    (n) => !boardIdByName(boards, n)
  );
  if (missing.length) {
    console.log(`\n⚠ Not found yet (create in the Pinterest UI): ${missing.join(', ')}`);
  } else {
    console.log('\n✓ All theme boards exist.');
  }

  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  console.log(`\nProduct menu (${products.length}) — copy listing_id into the queue:`);
  for (const p of products) {
    const theme = (p.themes || []).find((t) => THEME_BOARDS[t]) || '-';
    console.log(`  ${p.listing_id}\t[${theme}]\t${p.title}`);
  }
  console.log('\nVerify complete. No Pins were created.');
}

// End-to-end API demonstration for the Standard-access review video: create a
// board, create a Pin on it, then read the Pin back. Run against the sandbox.
async function runDemo(token) {
  console.log(`Pinterest API demo (${ENV}).`);
  if (!IS_SANDBOX) {
    console.log('Note: demo is intended for PINTEREST_ENV=sandbox.');
  }

  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  const product = products.find((p) => p.image) || products[0];
  if (!product) throw new Error('No products available to build a demo Pin.');

  // 1) Create a board. Name is unique per run (Pinterest rejects duplicates).
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const boardName = `Bliss Fox Studio Demo ${stamp} UTC`;
  console.log(`\n[1/3] POST /boards — creating board "${boardName}"…`);
  const board = await api(token, '/boards', {
    method: 'POST',
    body: {
      name: boardName,
      description: 'Demo board created via the Pinterest API for standard-access review.',
    },
  });
  console.log(`      ✓ board created: id=${board.id}`);

  // 2) Create a Pin on that board.
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

  // 3) Read the Pin back to show the result.
  console.log(`\n[3/3] GET /pins/${pin.id} — reading the created Pin back…`);
  const fetched = await api(token, `/pins/${pin.id}`);
  console.log('      ✓ retrieved Pin:');
  console.log(
    JSON.stringify(
      {
        id: fetched.id,
        title: fetched.title,
        board_id: fetched.board_id,
        link: fetched.link,
        created_at: fetched.created_at,
      },
      null,
      2
    )
  );
  console.log('\nDemo complete: board + Pin created via the API and read back.');
}

async function runPublish(token) {
  const products = (await loadJson(PRODUCTS_FILE)).products || [];
  const byId = new Map(products.map((p) => [String(p.listing_id), p]));
  const queue = await loadQueue();
  const defaultBoard = queue.default_board || 'Printable Coloring Books';
  const pending = (queue.pins || []).filter((e) => !e.posted);

  if (pending.length === 0) {
    console.log('Nothing to publish: no unposted entries in data/pinterest-queue.json.');
    return;
  }

  const boards = await listBoards(token);
  console.log(
    `${pending.length} queued Pin(s) pending; publishing up to ${MAX_PER_RUN} this run` +
      (DRY_RUN ? ' (DRY RUN)…' : '…')
  );

  let published = 0;
  let changed = false;
  for (const entry of pending) {
    if (published >= MAX_PER_RUN) break;
    const product = byId.get(String(entry.listing_id));
    if (!product) {
      console.warn(`  skip listing ${entry.listing_id}: not in products.json (removed on Etsy?)`);
      continue;
    }
    if (!product.image) {
      console.warn(`  skip "${product.title}": no image available.`);
      continue;
    }
    const boardName = boardNameFor(entry, product, defaultBoard);
    const boardId = boardIdByName(boards, boardName);
    if (!boardId) {
      console.warn(`  skip "${product.title}": board "${boardName}" not found — create it first.`);
      continue;
    }

    const pin = buildPinBody(entry, product, boardId);
    if (DRY_RUN) {
      console.log(`  [dry] would pin "${pin.title}" → ${boardName}`);
      published++;
      continue;
    }
    try {
      await api(token, '/pins', { method: 'POST', body: pin });
      entry.posted = true;
      entry.posted_at = new Date().toISOString();
      changed = true;
      published++;
      console.log(`  ✓ pinned "${pin.title}" → ${boardName}`);
      await sleep(1500); // gentle pacing between writes
    } catch (err) {
      console.error(`  ✗ failed "${pin.title}": ${err.message}`);
    }
  }

  if (changed) {
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
    console.log(`\nUpdated data/pinterest-queue.json (${published} newly posted).`);
  } else {
    console.log(`\nNo queue changes (${published} processed).`);
  }
}

async function main() {
  requireAuth();
  const token = await getAccessToken();
  if (MODE === 'verify') {
    await runVerify(token);
  } else if (MODE === 'demo') {
    await runDemo(token);
  } else {
    await runPublish(token);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
