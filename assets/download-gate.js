/*
 * Bliss Fox Studio — passcode-gated download page runtime.
 *
 * Generic across every kit. Each generated page carries two JSON blobs:
 *   #kit-config  non-secret structure (product name, sizes, section list…)
 *   #enc-blob    the R2 base URL, AES-GCM encrypted with the buyer's passcode
 *
 * The real download links can only be built once the base URL is decrypted, so
 * viewing the page source before unlocking reveals no working file links — only
 * ciphertext. On a correct passcode we derive the key (PBKDF2), decrypt the
 * base, then render the complete-book cards, the size toggle, and the section /
 * bonus lists. See scripts/make-download-page.mjs for how pages are generated.
 */
(function () {
  var cfgEl = document.getElementById("kit-config");
  var encEl = document.getElementById("enc-blob");
  if (!cfgEl || !encEl) return;

  var KIT = JSON.parse(cfgEl.textContent);
  var ENC = JSON.parse(encEl.textContent);
  var STORE_KEY = "bfs-dl-base:" + (KIT.urlSlug || location.pathname);

  var form = document.getElementById("gateForm");
  var input = document.getElementById("passInput");
  var errorEl = document.getElementById("passError");
  var gate = document.getElementById("gate");
  var area = document.getElementById("downloadArea");

  var ARROW = '<span class="dl-link-arrow" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 4v12m0 0l-5-5m5 5l5-5M5 20h14"/></svg></span>';

  // ---- crypto helpers -------------------------------------------------------
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decryptBase(passcode) {
    var enc = new TextEncoder();
    return crypto.subtle
      .importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"])
      .then(function (keyMaterial) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: b64ToBytes(ENC.salt), iterations: ENC.iterations, hash: "SHA-256" },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"]
        );
      })
      .then(function (key) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(ENC.iv) }, key, b64ToBytes(ENC.ct));
      })
      .then(function (buf) {
        return new TextDecoder().decode(buf).replace(/\/+$/, "");
      });
  }

  // ---- link builders --------------------------------------------------------
  function fileUrl(base, size, slug, part) {
    var name = KIT.filePrefix + "-" + slug + (part ? "-" + part : "") + ".pdf";
    return base + "/" + size + "/" + name;
  }

  function linksFor(base, item, size) {
    var splitHere = item.split && KIT.splitSizes && KIT.splitSizes.indexOf(size) !== -1;
    if (splitHere) {
      return [
        { href: fileUrl(base, size, item.slug, "part1"), part: "Part 1" },
        { href: fileUrl(base, size, item.slug, "part2"), part: "Part 2" }
      ];
    }
    return [{ href: fileUrl(base, size, item.slug, ""), part: "" }];
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function linkButton(name, link) {
    var label = esc(name) + (link.part ? ' <em class="dl-part">' + link.part + "</em>" : "");
    return '<a class="dl-link" href="' + link.href + '" target="_blank" rel="noopener">' +
             "<span>" + label + "</span>" + ARROW + "</a>";
  }

  function renderList(el, items, base, size) {
    if (!el) return;
    var html = "";
    items.forEach(function (item) {
      linksFor(base, item, size).forEach(function (link) { html += linkButton(item.name, link); });
    });
    el.innerHTML = html;
  }

  // ---- full render on unlock ------------------------------------------------
  function render(base) {
    var sizes = KIT.sizes || [];
    var bookLabel = KIT.pages ? "Download " + KIT.pages + "-Page Book" : "Download";

    // Complete-book cards (one per size).
    var completeGrid = document.getElementById("completeGrid");
    if (completeGrid && KIT.completeSlug) {
      completeGrid.innerHTML = sizes.map(function (s) {
        return '<div class="size-card">' +
                 '<span class="size-name">' + esc(s.name) + "</span>" +
                 (s.dims ? '<span class="size-dims">' + esc(s.dims) + "</span>" : "") +
                 '<a class="btn btn-primary" href="' + fileUrl(base, s.id, KIT.completeSlug, "") +
                   '" target="_blank" rel="noopener">' + esc(bookLabel) + "</a>" +
               "</div>";
      }).join("");
    }

    // Size toggle drives the section + bonus lists.
    var toggle = document.getElementById("sizeToggle");
    var sectionList = document.getElementById("sectionList");
    var bonusList = document.getElementById("bonusList");

    function paint(size) {
      renderList(sectionList, KIT.sections || [], base, size);
      renderList(bonusList, KIT.bonus || [], base, size);
    }

    if (toggle && sizes.length) {
      toggle.innerHTML = sizes.map(function (s, i) {
        return '<button type="button" role="radio" aria-checked="' + (i === 0 ? "true" : "false") +
               '" data-size="' + esc(s.id) + '">' + esc(s.name) + "</button>";
      }).join("");
      var buttons = Array.prototype.slice.call(toggle.querySelectorAll("button"));
      function select(size) {
        buttons.forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.size === size)); });
        paint(size);
      }
      buttons.forEach(function (btn, i) {
        btn.addEventListener("click", function () { select(btn.dataset.size); });
        btn.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          var next = (i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
          buttons[next].focus();
          select(buttons[next].dataset.size);
        });
      });
      select(sizes[0].id);
    } else {
      paint(sizes.length ? sizes[0].id : "");
    }

    gate.hidden = true;
    area.hidden = false;
  }

  function unlock(passcode, opts) {
    return decryptBase(passcode).then(function (base) {
      if (!/^https?:\/\//.test(base)) throw new Error("bad payload");
      try { sessionStorage.setItem(STORE_KEY, base); } catch (e) {}
      render(base);
    }).catch(function () {
      if (opts && opts.silent) return; // stale/empty cached attempt — just show the form
      errorEl.hidden = false;
      input.value = "";
      input.focus();
    });
  }

  // Re-open without re-entering the passcode within the same browser session.
  var cached = null;
  try { cached = sessionStorage.getItem(STORE_KEY); } catch (e) {}
  if (cached && /^https?:\/\//.test(cached)) {
    render(cached);
  }

  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      errorEl.hidden = true;
      var pass = (input.value || "").trim();
      if (!pass) { errorEl.hidden = false; return; }
      unlock(pass);
    });
  }
})();
