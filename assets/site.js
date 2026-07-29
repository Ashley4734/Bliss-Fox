/* Bliss Fox Studio — shared behavior. All handlers are guarded so each
   page only runs what it needs. No dependencies. */
(function () {
  'use strict';

  /* ---- Mobile nav ---- */
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    var setOpen = function (open) {
      links.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    toggle.addEventListener('click', function () {
      setOpen(!links.classList.contains('open'));
    });
    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { setOpen(false); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && links.classList.contains('open')) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  /* ---- Etsy catalog (data-driven) ----
     Renders product cards from /data/products.json, which is refreshed by the
     scheduled Etsy sync. Pages opt in with:
       <div id="catalog"> ... </div>   full catalog grid (+ optional #filterBar)
       <div id="featured"> ... </div>  homepage preview grid
  */
  var THEME_LABELS = {
    cozy: 'Cozy',
    animals: 'Animals',
    professions: 'Trades & helpers',
    kids: 'Kids',
    seasonal: 'Seasonal',
    spooky: 'Spooky',
    fantasy: 'Fantasy',
    patriotic: 'Patriotic'
  };
  var SHOP_URL = 'https://www.etsy.com/shop/BlissFoxStudio';
  var LOGO = '/assets/bliss-fox-studio-logo.png';

  var catalogEl = document.getElementById('catalog');
  var featuredEl = document.getElementById('featured');

  if (catalogEl || featuredEl) {
    fetch('/data/products.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var products = (data && data.products) || [];
        if (featuredEl) renderFeatured(featuredEl, products);
        if (catalogEl) renderCatalog(catalogEl, products);
      })
      .catch(function () {
        if (featuredEl) showMessage(featuredEl, false);
        if (catalogEl) showMessage(catalogEl, true);
      });
  }

  function makeCard(p) {
    var card = document.createElement('article');
    card.className = 'book-card';
    card.setAttribute('data-themes', (p.themes || []).join(' '));

    var a = document.createElement('a');
    a.href = p.url || SHOP_URL;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', 'View ' + (p.title || 'listing') + ' on Etsy');

    var img = document.createElement('img');
    img.className = 'book-cover-img';
    img.src = p.image || LOGO;
    img.alt = (p.title || 'Bliss Fox Studio digital download') + ' cover';
    img.loading = 'lazy';
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.addEventListener('error', function () {
      if (img.src.indexOf(LOGO) === -1) img.src = LOGO;
    });
    a.appendChild(img);

    var h3 = document.createElement('h3');
    h3.textContent = p.title || 'Bliss Fox Studio download';
    a.appendChild(h3);

    if (p.description) {
      var desc = document.createElement('p');
      desc.textContent = p.description;
      a.appendChild(desc);
    }

    var themes = (p.themes || []).filter(function (t) { return THEME_LABELS[t]; });
    if (themes.length) {
      var tags = document.createElement('div');
      tags.className = 'tags';
      themes.slice(0, 3).forEach(function (t) {
        var span = document.createElement('span');
        span.className = 'tag ' + t;
        span.textContent = THEME_LABELS[t];
        tags.appendChild(span);
      });
      a.appendChild(tags);
    }

    if (p.price && p.price.display) {
      var price = document.createElement('div');
      price.className = 'card-price';
      if (p.price.on_sale && p.price.original_display) {
        price.classList.add('has-sale');
        var sale = document.createElement('span');
        sale.className = 'price-sale';
        sale.textContent = p.price.display;
        var orig = document.createElement('span');
        orig.className = 'price-original';
        orig.textContent = p.price.original_display;
        price.appendChild(sale);
        price.appendChild(orig);
        if (p.price.percent_off) {
          var badge = document.createElement('span');
          badge.className = 'price-badge';
          badge.textContent = '−' + p.price.percent_off + '%';
          price.appendChild(badge);
        }
      } else {
        price.textContent = p.price.display;
      }
      a.appendChild(price);
    }

    card.appendChild(a);
    return card;
  }

  function showMessage(container, isCatalog) {
    var wrap = document.createElement('div');
    wrap.className = 'catalog-message';
    var h = document.createElement('p');
    h.className = 'catalog-message-title';
    h.textContent = isCatalog
      ? 'Fresh digital downloads are on the way.'
      : 'New digital downloads are on the way.';
    var sub = document.createElement('p');
    sub.textContent = 'Visit the Bliss Fox Studio Etsy shop to see everything available right now.';
    var cta = document.createElement('a');
    cta.className = 'btn btn-primary';
    cta.href = SHOP_URL;
    cta.target = '_blank';
    cta.rel = 'noopener';
    cta.textContent = 'Shop on Etsy';
    wrap.appendChild(h);
    wrap.appendChild(sub);
    wrap.appendChild(cta);
    container.innerHTML = '';
    container.appendChild(wrap);
  }

  function renderFeatured(container, products) {
    container.innerHTML = '';
    if (!products.length) { showMessage(container, false); return; }
    products.slice(0, 8).forEach(function (p) {
      container.appendChild(makeCard(p));
    });
  }

  function renderCatalog(container, products) {
    container.innerHTML = '';
    var status = document.getElementById('catalogStatus');
    var filterBar = document.getElementById('filterBar');

    if (!products.length) {
      if (status) status.style.display = 'none';
      if (filterBar) filterBar.hidden = true;
      showMessage(container, true);
      return;
    }

    if (status) status.style.display = 'none';
    products.forEach(function (p) { container.appendChild(makeCard(p)); });

    var empty = document.getElementById('catalogEmpty');

    /* Build filter chips from the themes actually present in the catalog. */
    if (filterBar) {
      var present = {};
      products.forEach(function (p) {
        (p.themes || []).forEach(function (t) { if (THEME_LABELS[t]) present[t] = true; });
      });
      var themeKeys = Object.keys(present);
      if (themeKeys.length < 2) {
        filterBar.hidden = true;
      } else {
        filterBar.hidden = false;
        filterBar.innerHTML = '';
        addFilterBtn(filterBar, 'all', 'All downloads', true);
        themeKeys.forEach(function (t) { addFilterBtn(filterBar, t, THEME_LABELS[t], false); });
        wireFilter(filterBar, container, empty);
      }
    }
  }

  function addFilterBtn(bar, value, label, pressed) {
    var btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.setAttribute('data-filter', value);
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    btn.textContent = label;
    bar.appendChild(btn);
  }

  function wireFilter(filterBar, container, empty) {
    var cards = Array.prototype.slice.call(container.querySelectorAll('[data-themes]'));
    filterBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.filter-btn');
      if (!btn) return;
      var theme = btn.getAttribute('data-filter');
      filterBar.querySelectorAll('.filter-btn').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      var visible = 0;
      cards.forEach(function (card) {
        var match = theme === 'all' ||
          card.getAttribute('data-themes').split(' ').indexOf(theme) !== -1;
        card.classList.toggle('is-hidden', !match);
        if (match) visible++;
      });
      if (empty) empty.style.display = visible ? 'none' : 'block';
    });
  }

  /* ---- Footer year ---- */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
