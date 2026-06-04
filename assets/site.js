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

  /* ---- Newsletter (inline confirmation) ----
     Replace the TODO with your provider POST or n8n webhook. */
  var form = document.getElementById('signupForm');
  if (form) {
    var input = document.getElementById('signupEmail');
    var msg = document.getElementById('signupMsg');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input.checkValidity()) {
        msg.style.color = '#b3261e';
        msg.textContent = 'Please enter a valid email address.';
        input.focus();
        return;
      }
      msg.style.color = '#1f7a3d';
      msg.textContent = 'Thanks! You are on the list. Watch your inbox for new pages.';
      form.reset();
      // TODO: deliver input.value to MailerLite / ConvertKit / Beehiiv / n8n webhook.
    });
  }

  /* ---- Catalog theme filter ---- */
  var filterBar = document.getElementById('filterBar');
  if (filterBar) {
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-themes]'));
    var empty = document.getElementById('catalogEmpty');
    filterBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.filter-btn');
      if (!btn) return;
      var theme = btn.getAttribute('data-filter');
      filterBar.querySelectorAll('.filter-btn').forEach(function (b) {
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      var visible = 0;
      cards.forEach(function (card) {
        var match = theme === 'all' || card.getAttribute('data-themes').split(' ').indexOf(theme) !== -1;
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
