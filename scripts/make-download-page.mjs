#!/usr/bin/env node
/**
 * Bliss Fox Studio — passcode-gated download page generator.
 *
 * Mints a self-contained, per-kit download page whose R2 base URL is encrypted
 * with a buyer passcode (PBKDF2 + AES-GCM). The page shows only a passcode form
 * until unlocked; nothing downloadable is present in the source beforehand. The
 * shared runtime that decrypts + renders lives in assets/download-gate.js.
 *
 * Usage:
 *   BASE_URL='https://files.blissfoxstudio.com/<secret-path>/kit' \
 *   PASSCODE='the-code-you-give-buyers' \
 *   node scripts/make-download-page.mjs book-of-shadows
 *
 * The positional arg is the kit name -> scripts/kits/<name>.json (structure
 * only, safe to commit). The two SECRETS come from the environment and are
 * NEVER written to disk in plaintext — only the encrypted page is emitted to
 * download/<urlSlug>.html.
 *
 * Notes:
 *   - Pick a fresh, unguessable R2 path per kit and do not commit it anywhere in
 *     plaintext. The generated ciphertext is safe to commit.
 *   - The page URL (urlSlug) lives in the kit JSON so builds are reproducible.
 *     The passcode is the real gate, so a discoverable slug is acceptable.
 */
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ITERATIONS = 200000;

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

async function encrypt(plaintext, passcode) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return {
    v: 1,
    iterations: ITERATIONS,
    salt: Buffer.from(salt).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    ct: Buffer.from(new Uint8Array(ct)).toString("base64")
  };
}

function page(kit, encBlob) {
  const title = kit.pageTitle || kit.productName || "Your Download";
  const brandTitle = `${title} | Bliss Fox Studio`;
  const kitJson = JSON.stringify(kit);
  const encJson = JSON.stringify(encBlob);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <link rel="icon" type="image/png" href="/assets/favicon-16x16.png" sizes="16x16">
  <link rel="icon" type="image/png" href="/assets/favicon-32x32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">

  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#fffaf2" />
  <link rel="icon" type="image/png" href="/assets/bliss-fox-studio-logo.png" />
  <link rel="apple-touch-icon" href="/assets/bliss-fox-studio-logo.png" />

  <title>${brandTitle}</title>
  <meta name="description" content="Enter your download passcode to access your Bliss Fox Studio purchase." />
  <!-- Private post-purchase page: keep it out of search results. -->
  <meta name="robots" content="noindex, nofollow" />

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Fraunces:ital,opsz,wght@0,9..144,400..900;1,9..144,400..900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/site.css?v=etsy-links-20260730" />

  <style>
    .dl-hero { text-align: center; padding: 64px 0 8px; }
    .dl-hero .eyebrow { margin-bottom: 18px; }
    .dl-hero h1 { font-size: clamp(38px, 5.4vw, 62px); margin: 0 auto 16px; max-width: 760px; letter-spacing: -2px; line-height: 1.0; }
    .dl-hero p { color: var(--muted); font-size: clamp(17px, 2vw, 20px); max-width: 620px; margin: 0 auto; }

    .dl-section { padding: 40px 0; }
    .dl-section-head { text-align: center; margin-bottom: 26px; }
    .dl-section-head h2 { font-size: clamp(26px, 3.4vw, 40px); }
    .dl-section-head p { color: var(--muted); margin: 10px auto 0; max-width: 520px; font-size: 16px; }

    /* Passcode gate */
    .gate-wrap { display: flex; justify-content: center; padding: 30px 0 64px; }
    .gate-card {
      width: min(440px, 100%); background: #fff; border: 1px solid var(--line);
      border-radius: 28px; padding: 34px 30px; box-shadow: var(--shadow); text-align: center;
    }
    .gate-card .gate-icon { font-size: 34px; line-height: 1; }
    .gate-card h2 { font-size: 26px; margin: 14px 0 6px; letter-spacing: -.6px; }
    .gate-card p { color: var(--muted); font-size: 15px; margin: 0 0 20px; }
    .gate-card form { display: flex; flex-direction: column; gap: 12px; }
    .gate-card input {
      font-family: var(--body); font-size: 16px; font-weight: 700; text-align: center;
      padding: 14px 16px; border-radius: 16px; border: 1px solid var(--line); background: var(--warm);
      color: var(--plum); width: 100%;
    }
    .gate-card input:focus-visible { outline: 3px solid var(--red); outline-offset: 1px; }
    .gate-card .btn { width: 100%; }
    .gate-error { color: var(--red-ink); font-weight: 800; font-size: 14px; margin: 4px 0 0; }

    /* Complete book — three size cards */
    .size-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .size-card {
      background: #fff; border: 1px solid var(--line); border-radius: 28px; padding: 30px 24px;
      text-align: center; box-shadow: var(--shadow-sm); display: flex; flex-direction: column;
      align-items: center; gap: 6px; transition: transform .25s ease, box-shadow .25s ease;
    }
    .size-card:hover { transform: translateY(-4px); box-shadow: var(--shadow); }
    .size-card .size-name { font-family: var(--display); font-weight: 700; font-size: 30px; letter-spacing: -.8px; }
    .size-card .size-dims { color: var(--muted); font-weight: 700; font-size: 15px; }
    .size-card .btn { margin-top: 18px; width: 100%; }

    /* Size toggle */
    .size-toggle-wrap { text-align: center; margin-bottom: 26px; }
    .size-toggle {
      display: inline-flex; gap: 4px; padding: 5px; border-radius: 999px;
      background: #fff; border: 1px solid var(--line); box-shadow: var(--shadow-sm);
    }
    .size-toggle button {
      border: 0; background: transparent; cursor: pointer; font-family: var(--body);
      font-weight: 800; font-size: 15px; color: var(--muted); line-height: 1;
      padding: 11px 22px; border-radius: 999px; transition: background .2s ease, color .2s ease;
    }
    .size-toggle button[aria-checked="true"] { background: var(--red); color: #fff; box-shadow: 0 8px 20px rgba(230, 0, 35, .18); }
    .size-toggle button:not([aria-checked="true"]):hover { background: var(--sand); color: var(--plum); }
    .size-toggle-hint { display: block; color: var(--muted); font-size: 13px; font-weight: 700; margin-top: 12px; }

    /* Section + bonus lists */
    .dl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
    .dl-link {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 18px 20px;
      font-weight: 800; color: var(--plum); box-shadow: var(--shadow-sm);
      transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
    }
    .dl-link:hover { transform: translateY(-3px); box-shadow: var(--shadow); border-color: var(--rose-deep); }
    .dl-link .dl-part { font-style: normal; font-weight: 700; color: var(--muted); font-size: 13px; margin-left: 4px; }
    .dl-link .dl-link-arrow {
      flex: none; width: 34px; height: 34px; border-radius: 12px; display: grid; place-items: center;
      background: var(--rose); color: #8a2747;
    }
    .dl-link .dl-link-arrow svg { width: 18px; height: 18px; }
    .dl-bonus .dl-link .dl-link-arrow { background: var(--gold); color: #8a6410; }

    .dl-note { text-align: center; color: var(--muted); font-size: 14px; max-width: 560px; margin: 22px auto 0; }
    .dl-divider { border: 0; border-top: 1px solid var(--line); margin: 4px auto; width: min(var(--maxw), calc(100% - 32px)); }

    @media (max-width: 720px) {
      .size-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#top">Skip to content</a>

  <nav class="nav" aria-label="Main navigation">
    <div class="container nav-inner">
      <a class="brand" href="/" aria-label="Bliss Fox Studio home">
        <span class="logo" aria-hidden="true"><img src="/assets/bliss-fox-studio-logo.png" alt="" loading="eager"></span>
        <span>Bliss Fox Studio</span>
      </a>
      <button class="nav-toggle" id="navToggle" aria-label="Open menu" aria-expanded="false" aria-controls="navLinks">
        <svg class="icon-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        <svg class="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="nav-links" id="navLinks">
        <a href="/">Home</a>
        <a href="/books">All Books</a>
        <a href="/#shop">Shop</a>
        <a href="/#about">About</a>
        <a href="/privacy">Privacy</a>
        <a class="btn btn-primary nav-cta" href="https://blissfoxstudio.etsy.com/" target="_blank" rel="noopener">Shop Etsy</a>
      </div>
    </div>
  </nav>

  <main id="top">
    <header class="dl-hero container">
      <span class="eyebrow reveal d1">🔮 Your download is ready</span>
      <h1 class="reveal d1">${title}</h1>
      <p class="reveal d2">Thank you for purchasing ${kit.productName ? "the " + kit.productName : "from Bliss Fox Studio"}. Enter the passcode from your order to unlock your downloads.</p>
    </header>

    <!-- Passcode gate (shown until unlocked) -->
    <div id="gate" class="container gate-wrap">
      <div class="gate-card">
        <div class="gate-icon" aria-hidden="true">🔒</div>
        <h2>Enter your passcode</h2>
        <p>You'll find it in your order confirmation or thank-you note.</p>
        <form id="gateForm" autocomplete="off" novalidate>
          <input id="passInput" type="password" inputmode="text" autocomplete="off"
                 aria-label="Download passcode" placeholder="Passcode" />
          <p id="passError" class="gate-error" role="alert" hidden>That passcode didn't match. Please try again.</p>
          <button class="btn btn-primary" type="submit">Unlock downloads</button>
        </form>
      </div>
    </div>

    <!-- Download area (revealed after a correct passcode) -->
    <div id="downloadArea" hidden>
      <section class="dl-section">
        <div class="container">
          <div class="dl-section-head">
            <h2>The complete book</h2>
            <p>The full ${kit.pages ? kit.pages + "-page " : ""}download in your preferred paper size.</p>
          </div>
          <div class="size-grid" id="completeGrid"></div>
        </div>
      </section>

      <hr class="dl-divider" />

      <section class="dl-section">
        <div class="container">
          <div class="dl-section-head">
            <h2>Individual sections</h2>
            <p>Prefer to print one part at a time? Grab any section on its own.</p>
          </div>
          <div class="size-toggle-wrap">
            <div class="size-toggle" id="sizeToggle" role="radiogroup" aria-label="Choose your download size"></div>
            <span class="size-toggle-hint">The section &amp; bonus downloads below match the size you pick here.</span>
          </div>
          <div class="dl-grid" id="sectionList" aria-live="polite"></div>
        </div>
      </section>

      <hr class="dl-divider" />

      <section class="dl-section dl-bonus">
        <div class="container">
          <div class="dl-section-head">
            <h2>✨ Bonus downloads</h2>
            <p>A few extras to make it your own.</p>
          </div>
          <div class="dl-grid" id="bonusList" aria-live="polite"></div>
          <p class="dl-note">Having trouble with a download? <a href="https://blissfoxstudio.etsy.com/" target="_blank" rel="noopener" style="color:var(--red-ink);font-weight:800;">Message us on Etsy</a> and we'll get you sorted.</p>
        </div>
      </section>
    </div>
  </main>

  <footer>
    <div class="container footer-grid">
      <div><strong>🦊 Bliss Fox Studio</strong><br />Coloring books, printable pages, and cozy creative downloads.</div>
      <div class="footer-links">
        <a href="https://blissfoxstudio.etsy.com/" target="_blank" rel="noopener">Etsy</a>
        <a href="/">Home</a>
        <a href="/privacy">Privacy</a>
      </div>
      <div class="footer-legal">&copy; <span id="year"></span> Bliss Fox Studio. Printable coloring books and digital downloads, sold through our Etsy shop.</div>
    </div>
  </footer>

  <script type="application/json" id="kit-config">${kitJson}</script>
  <script type="application/json" id="enc-blob">${encJson}</script>
  <script src="/assets/site.js?v=etsy-links-20260730" defer></script>
  <script src="/assets/download-gate.js?v=gate-1" defer></script>
</body>
</html>
`;
}

async function main() {
  const name = process.argv[2];
  if (!name) fail("Usage: BASE_URL=… PASSCODE=… node scripts/make-download-page.mjs <kit-name>");

  const baseUrl = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");
  const passcode = (process.env.PASSCODE || "").trim();
  if (!baseUrl) fail("Set BASE_URL (the R2 kit base, e.g. https://files.blissfoxstudio.com/<path>/kit).");
  if (!/^https?:\/\//.test(baseUrl)) fail("BASE_URL must be an absolute http(s) URL.");
  if (passcode.length < 4) fail("Set PASSCODE to at least 4 characters.");

  let kit;
  try {
    kit = JSON.parse(readFileSync(join(ROOT, "scripts", "kits", name + ".json"), "utf8"));
  } catch (e) {
    fail("Could not read scripts/kits/" + name + ".json — " + e.message);
  }
  if (!kit.urlSlug) fail("Kit JSON needs a urlSlug (the unguessable page path).");
  if (!kit.filePrefix) fail("Kit JSON needs a filePrefix (e.g. book-of-shadows).");

  const encBlob = await encrypt(baseUrl, passcode);
  const html = page(kit, encBlob);

  const outDir = join(ROOT, "download");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, kit.urlSlug + ".html");
  writeFileSync(outFile, html);

  console.log("✓ Wrote download/" + kit.urlSlug + ".html");
  console.log("  Public URL : https://blissfoxstudio.com/download/" + kit.urlSlug);
  console.log("  Passcode   : (the PASSCODE you just passed — share it with buyers, it is NOT stored)");
  console.log("  Base URL   : encrypted into the page; plaintext never written to disk.");
}

main().catch(function (e) { fail(e.stack || String(e)); });
