#!/usr/bin/env node
/**
 * Bliss Fox Studio — Pinterest analytics report.
 *
 * Pulls analytics for the account's recent Pins (pins:read), maps each Pin back
 * to our Etsy product via the Pin's link, and aggregates performance by product
 * and by theme. Writes:
 *   data/pinterest-analytics.md            human-readable latest report
 *   data/pinterest-analytics-history.json  one row of totals appended per run
 *
 * Data handling: we store ONLY aggregated analytics numbers keyed to our own
 * listing_ids / themes (Pinterest permits storing campaign/analytics data about
 * your own account). Pinterest pin ids are used transiently and never persisted.
 *
 * Env: PINTEREST_APP_ID, PINTEREST_APP_SECRET, PINTEREST_REFRESH_TOKEN
 *      LOOKBACK_DAYS (default 30), MAX_ANALYZE (default 120)
 *
 * Node 18+ (global fetch). No dependencies.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://api.pinterest.com/v5';
const APP_ID = (process.env.PINTEREST_APP_ID || '').trim();
const APP_SECRET = (process.env.PINTEREST_APP_SECRET || '').trim();
const REFRESH_TOKEN = (process.env.PINTEREST_REFRESH_TOKEN || '').trim();
const LOOKBACK_DAYS = Math.max(1, Number.parseInt(process.env.LOOKBACK_DAYS || '30', 10) || 30);
const MAX_ANALYZE = Math.max(1, Number.parseInt(process.env.MAX_ANALYZE || '120', 10) || 120);

const METRICS = ['IMPRESSION', 'SAVE', 'PIN_CLICK', 'OUTBOUND_CLICK'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRODUCTS_FILE = join(__dirname, '..', 'data', 'products.json');
const REPORT_FILE = join(__dirname, '..', 'data', 'pinterest-analytics.md');
const HISTORY_FILE = join(__dirname, '..', 'data', 'pinterest-analytics-history.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function getAccessToken() {
  if (!APP_ID || !APP_SECRET || !REFRESH_TOKEN) {
    throw new Error('Missing PINTEREST_APP_ID / PINTEREST_APP_SECRET / PINTEREST_REFRESH_TOKEN.');
  }
  const basic = Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64');
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}. ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error('Token refresh returned no access_token.');
  return data.access_token;
}

// GET with retry on 429 (honors Retry-After) and transient 5xx.
async function apiGet(token, path) {
  const url = path.startsWith('http') ? path : `${API}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = (Number.isFinite(ra) && ra > 0 ? ra : 10) * 1000;
      await sleep(waitMs);
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
      const err = new Error(`Pinterest API ${res.status} for ${path}: ${(json && json.message) || text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
}

// List the account's Pins (id, link, created_at). Bounded by maxPages.
async function listPins(token, maxPages = 20) {
  const pins = [];
  let bookmark = '';
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ page_size: '100' });
    if (bookmark) q.set('bookmark', bookmark);
    const data = await apiGet(token, `/pins?${q.toString()}`);
    for (const p of data.items || []) {
      pins.push({ id: p.id, link: p.link || '', created_at: p.created_at || '' });
    }
    bookmark = data.bookmark || '';
    if (!bookmark) break;
  }
  return pins;
}

function sumMetrics(analytics) {
  const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
  if (!analytics || typeof analytics !== 'object') return totals;
  for (const group of Object.values(analytics)) {
    if (!group || typeof group !== 'object') continue;
    if (group.summary_metrics && typeof group.summary_metrics === 'object') {
      for (const m of METRICS) if (typeof group.summary_metrics[m] === 'number') totals[m] += group.summary_metrics[m];
    } else if (Array.isArray(group.daily_metrics)) {
      for (const d of group.daily_metrics) {
        const met = (d && d.metrics) || {};
        for (const m of METRICS) if (typeof met[m] === 'number') totals[m] += met[m];
      }
    }
  }
  return totals;
}

async function pinAnalytics(token, pinId, start, end) {
  const q = new URLSearchParams({ start_date: start, end_date: end, metric_types: METRICS.join(',') });
  try {
    const data = await apiGet(token, `/pins/${pinId}/analytics?${q.toString()}`);
    return sumMetrics(data);
  } catch (err) {
    console.warn(`  analytics unavailable for a pin: ${err.message}`);
    return null;
  }
}

function listingIdFromLink(link) {
  const m = String(link || '').match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const token = await getAccessToken();
  const products = (await loadJson(PRODUCTS_FILE, { products: [] })).products || [];
  const byId = new Map(products.map((p) => [String(p.listing_id), p]));

  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
  const startStr = ymd(start);
  const endStr = ymd(end);

  console.log(`Analytics window: ${startStr} → ${endStr} (${LOOKBACK_DAYS} days).`);
  const allPins = await listPins(token);
  console.log(`Account has ${allPins.length} Pin(s); analyzing up to ${MAX_ANALYZE} most recent within window…`);

  const recent = allPins
    .filter((p) => !p.created_at || Date.parse(p.created_at) >= start.getTime())
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
    .slice(0, MAX_ANALYZE);

  const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
  const byProduct = new Map(); // listing_id -> {metrics, pins}
  const byTheme = new Map(); // theme -> metrics
  let analyzed = 0;

  for (const pin of recent) {
    const met = await pinAnalytics(token, pin.id, startStr, endStr);
    if (!met) continue;
    analyzed++;
    for (const m of METRICS) totals[m] += met[m];

    const lid = listingIdFromLink(pin.link);
    const product = lid ? byId.get(lid) : null;
    const key = lid || 'unknown';
    if (!byProduct.has(key)) byProduct.set(key, { metrics: Object.fromEntries(METRICS.map((m) => [m, 0])), pins: 0, title: product ? product.title : `listing ${key}` });
    const bp = byProduct.get(key);
    bp.pins++;
    for (const m of METRICS) bp.metrics[m] += met[m];

    const themes = (product && product.themes && product.themes.length ? product.themes : ['(untagged)']);
    for (const t of themes) {
      if (!byTheme.has(t)) byTheme.set(t, Object.fromEntries(METRICS.map((m) => [m, 0])));
      const bt = byTheme.get(t);
      for (const m of METRICS) bt[m] += met[m];
    }
    await sleep(300);
  }

  // Build the report.
  const topProducts = [...byProduct.values()]
    .sort((a, b) => b.metrics.OUTBOUND_CLICK - a.metrics.OUTBOUND_CLICK || b.metrics.SAVE - a.metrics.SAVE)
    .slice(0, 10);
  const themeRows = [...byTheme.entries()].sort((a, b) => b[1].OUTBOUND_CLICK - a[1].OUTBOUND_CLICK);

  const lines = [];
  lines.push(`# Pinterest analytics — Bliss Fox Studio`);
  lines.push('');
  lines.push(`_Window: ${startStr} → ${endStr} (${LOOKBACK_DAYS} days). ${analyzed} of ${recent.length} recent Pins analyzed. Generated ${endStr}._`);
  lines.push('');
  lines.push(`## Totals`);
  lines.push('');
  lines.push(`| Impressions | Saves | Pin clicks | Outbound clicks |`);
  lines.push(`|---:|---:|---:|---:|`);
  lines.push(`| ${fmt(totals.IMPRESSION)} | ${fmt(totals.SAVE)} | ${fmt(totals.PIN_CLICK)} | ${fmt(totals.OUTBOUND_CLICK)} |`);
  lines.push('');
  lines.push(`## Top products (by outbound clicks)`);
  lines.push('');
  if (topProducts.length) {
    lines.push(`| Product | Impr. | Saves | Outbound |`);
    lines.push(`|---|---:|---:|---:|`);
    for (const p of topProducts) {
      const title = (p.title || '').replace(/\|/g, '/').slice(0, 70);
      lines.push(`| ${title} | ${fmt(p.metrics.IMPRESSION)} | ${fmt(p.metrics.SAVE)} | ${fmt(p.metrics.OUTBOUND_CLICK)} |`);
    }
  } else {
    lines.push('_No per-product data yet (Pins may be too new for analytics)._');
  }
  lines.push('');
  lines.push(`## By theme (by outbound clicks)`);
  lines.push('');
  if (themeRows.length) {
    lines.push(`| Theme | Impr. | Saves | Outbound |`);
    lines.push(`|---|---:|---:|---:|`);
    for (const [theme, m] of themeRows) {
      lines.push(`| ${theme} | ${fmt(m.IMPRESSION)} | ${fmt(m.SAVE)} | ${fmt(m.OUTBOUND_CLICK)} |`);
    }
  } else {
    lines.push('_No theme data yet._');
  }
  lines.push('');
  await writeFile(REPORT_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${REPORT_FILE}`);

  // Append a totals row to history (aggregates only).
  const history = await loadJson(HISTORY_FILE, { runs: [] });
  history.runs = Array.isArray(history.runs) ? history.runs : [];
  history.runs.push({
    date: endStr,
    window_days: LOOKBACK_DAYS,
    pins_analyzed: analyzed,
    impressions: totals.IMPRESSION,
    saves: totals.SAVE,
    pin_clicks: totals.PIN_CLICK,
    outbound_clicks: totals.OUTBOUND_CLICK,
  });
  history.runs = history.runs.slice(-104); // keep ~2 years of weekly rows
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n', 'utf8');
  console.log(`Updated ${HISTORY_FILE}`);
  console.log(
    `Totals — impressions ${totals.IMPRESSION}, saves ${totals.SAVE}, ` +
      `pin clicks ${totals.PIN_CLICK}, outbound ${totals.OUTBOUND_CLICK}.`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
