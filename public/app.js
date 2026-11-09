/* LandLink SPA: hash router, no build step. All user content goes through esc(). */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lang = (() => { try { return localStorage.getItem('ll_lang') || 'en'; } catch { return 'en'; } })();
  const t = (k, vars = {}) => {
    const s = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
    return s.replace(/\{(\w+)\}/g, (_, x) => vars[x] ?? '');
  };
  const main = $('#main');
  const state = { user: null, meta: null };

  async function api(path, opts = {}) {
    const o = { credentials: 'same-origin', headers: {}, ...opts };
    if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const r = await fetch(`/api${path}`, o);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const shortNum = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(0)}k` : String(n));
  const priceText = (l) => (l.price === 0 && l.listing_types.includes('partnership')
    ? t('profit_share')
    : `${l.currency} ${num(l.price)}${l.price_unit !== 'total' ? ` / ${t(l.price_unit)}` : ''}`);
  const sizeText = (l) => `${num(l.size)} ${l.size_unit}`;
  const place = (l) => [l.town, l.region, l.country].filter(Boolean).join(', ');
  const typePills = (l) => l.listing_types.map((x) => `<span class="pill type">${esc(t(x))}</span>`).join(' ');
  const statusPill = (s) => `<span class="pill ${s === 'verified' ? 'verified' : s === 'pending' ? 'pending' : s === 'rejected' ? 'rejected' : ''}">${esc(t(`status_${s}`))}</span>`;
  const verifiedPill = `<span class="pill verified" title="Documents checked by LandLink"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>${esc(t('verified'))}</span>`;
  const coverImg = (l, cls = '') => (l.cover ? `<img src="${esc(l.cover)}" alt="" loading="lazy" class="${cls}">` : `<div class="noimg ${cls}" aria-hidden="true"></div>`);
  const loading = () => `<div class="empty"><span class="spinner"></span> ${esc(t('loading'))}</div>`;
  const empty = (title, hint = '') => `<div class="empty"><svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true"><path fill="currentColor" d="M3 20h18L14 8l-4 6-2-3z"/></svg><p><strong>${esc(title)}</strong></p>${hint ? `<p class="small">${esc(hint)}</p>` : ''}</div>`;
  const when = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  // Minimal, safe markdown for chat replies: escape first, then bold/italics/bullets.
  const md = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, '$1<em>$2</em>')
    .split(/\n{2,}/).map((p) => {
      const lines = p.split('\n');
      if (lines.every((x) => /^\s*([-*•]|\d+\.)\s/.test(x))) return `<ul>${lines.map((x) => `<li>${x.replace(/^\s*([-*•]|\d+\.)\s/, '')}</li>`).join('')}</ul>`;
      return `<p>${lines.join('<br>')}</p>`;
    }).join('');

  function applyI18n(root = document) {
    $$('[data-i18n]', root).forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-placeholder]', root).forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }

  // ---------- theme ----------
  const root = document.documentElement;
  try { const th = localStorage.getItem('ll_theme'); if (th) root.dataset.theme = th; } catch { /* storage unavailable */ }
  $('#themeBtn').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('ll_theme', root.dataset.theme); } catch { /* ignore */ }
  });

  // ---------- nav ----------
  function renderNav() {
    const u = state.user;
    const links = [['#/', t('browse')]];
    if (u && u.role === 'customer') links.push(['#/saved', t('saved')], ['#/inbox', t('inbox')]);
    if (u && u.role === 'lender') links.push(['#/dashboard', t('dashboard')], ['#/inbox', t('inbox')]);
    if (u && u.role === 'admin') links.push(['#/admin', t('admin')]);
    const here = location.hash.split('/').slice(0, 2).join('/') || '#/';
    $('#nav').innerHTML = links.map(([h, l]) => `<a href="${h}" class="${here === h ? 'active' : ''}">${esc(l)}</a>`).join('')
      + '<span class="spacer"></span>'
      + (u
        ? `<span class="muted small" style="align-self:center;padding:0 8px">${esc(u.name)}</span><button type="button" id="logoutBtn">${esc(t('logout'))}</button>`
        : `<a href="#/login">${esc(t('login'))}</a><a href="#/register" class="btn primary small" style="color:#fff">${esc(t('register'))}</a>`);
    $('#bellBtn').classList.toggle('hidden', !u);
    const lo = $('#logoutBtn');
    if (lo) lo.addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); state.user = null; sessionStorage.removeItem('ll_chat'); location.hash = '#/'; renderNav(); route(); });
  }
  $('#menuBtn').addEventListener('click', () => {
    const open = $('#nav').classList.toggle('open');
    $('#menuBtn').setAttribute('aria-expanded', open);
  });
  $('#nav').addEventListener('click', (e) => { if (e.target.closest('a,button')) $('#nav').classList.remove('open'); });

  async function refreshBell() {
    if (!state.user) return;
    try {
      const { unread } = await api('/notifications');
      const b = $('#bellCount');
      b.textContent = unread > 9 ? '9+' : unread;
      b.classList.toggle('hidden', !unread);
    } catch { /* offline */ }
  }
  setInterval(refreshBell, 30000);

  // ---------- maps ----------
  const TILE = {
    street: () => L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
    satellite: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
  };
  function makeMap(el, opts = {}) {
    const map = L.map(el, { zoomControl: true, ...opts });
    let mode = 'street';
    let layer = TILE.street().addTo(map);
    const Toggle = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const b = L.DomUtil.create('button', 'layer-toggle');
        b.type = 'button'; b.textContent = 'Satellite'; b.setAttribute('aria-label', 'Switch map layer');
        L.DomEvent.disableClickPropagation(b);
        b.addEventListener('click', () => {
          map.removeLayer(layer);
          mode = mode === 'street' ? 'satellite' : 'street';
          layer = TILE[mode]().addTo(map);
          b.textContent = mode === 'street' ? 'Satellite' : 'Map';
        });
        return b;
      },
    });
    map.addControl(new Toggle());
    return map;
  }
  const priceIcon = (l, active = false) => L.divIcon({
    className: '', iconSize: null,
    html: `<span class="price-marker${active ? ' active' : ''}">${esc(l.price === 0 ? '%' : `${l.currency === 'KES' ? 'K' : l.currency === 'RWF' ? 'R' : ''}${shortNum(l.price)}`)}</span>`,
  });

  // ---------- router ----------
  let cleanup = null;
  const routes = [
    [/^#?\/?$/, viewBrowse],
    [/^#\/listing\/(\d+)$/, viewDetail],
    [/^#\/login$/, viewLogin],
    [/^#\/register$/, viewRegister],
    [/^#\/dashboard$/, viewDashboard, 'lender'],
    [/^#\/new$/, (m) => viewForm(m, null), 'lender'],
    [/^#\/edit\/(\d+)$/, (m) => viewForm(m, m[1]), 'lender'],
    [/^#\/inbox(?:\/(\d+))?$/, viewInbox, 'any'],
    [/^#\/saved$/, viewSaved, 'any'],
    [/^#\/notifications$/, viewNotifications, 'any'],
    [/^#\/admin$/, viewAdmin, 'admin'],
  ];
  async function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    const hash = location.hash || '#/';
    renderNav();
    for (const [re, fn, need] of routes) {
      const m = hash.match(re);
      if (!m) continue;
      if (need && !state.user) { sessionStorage.setItem('ll_next', hash); location.hash = '#/login'; return; }
      if (need && need !== 'any' && state.user.role !== need) { main.innerHTML = `<div class="page">${empty('You don\'t have access to this page.')}</div>`; return; }
      main.innerHTML = loading();
      try { await fn(m); } catch (e) { main.innerHTML = `<div class="page">${empty(e.message)}</div>`; }
      applyI18n(main);
      main.focus({ preventScroll: true });
      return;
    }
    main.innerHTML = `<div class="page">${empty('Page not found.')}</div>`;
  }
  window.addEventListener('hashchange', route);

  // ---------- browse ----------
  const FILTER_KEYS = ['land_type', 'listing_type', 'price_min', 'price_max', 'size_min', 'size_max', 'region', 'duration_months', 'sort'];
  const browseState = { q: '', filters: {}, near: null };
  try { Object.assign(browseState, JSON.parse(sessionStorage.getItem('ll_browse') || '{}')); } catch { /* ignore */ }

  async function viewBrowse() {
    const m = state.meta;
    const opt = (list, label = (x) => t(x)) => `<option value="">${esc(t('any'))}</option>` + list.map((x) => `<option value="${esc(x)}">${esc(label(x))}</option>`).join('');
    main.innerHTML = `
      <div class="browse" id="browse">
        <div class="browse-side">
          <div class="searchbar">
            <form id="searchForm" role="search">
              <label for="q" class="sr-only">${esc(t('search'))}</label>
              <input id="q" name="q" type="search" placeholder="${esc(t('search_placeholder'))}" value="${esc(browseState.q)}">
              <button class="btn primary" type="submit" aria-label="${esc(t('search'))}">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/></svg>
              </button>
            </form>
            <div class="row" style="margin-top:8px">
              <button class="btn small" type="button" id="filterBtn" aria-expanded="false" aria-controls="filters">${esc(t('filters'))} <span id="filterCount"></span></button>
              <button class="btn small" type="button" id="nearBtn" aria-pressed="${!!browseState.near}">📍 ${esc(t('near_me'))}</button>
              <button class="btn small" type="button" id="clearBtn">${esc(t('clear'))}</button>
            </div>
          </div>
          <form class="filters" id="filters" aria-label="${esc(t('filters'))}">
            <div class="grid2">
              <div class="field"><label for="f_land_type">${esc(t('land_type'))}</label><select id="f_land_type" name="land_type">${opt(m.land_types)}</select></div>
              <div class="field"><label for="f_listing_type">${esc(t('listing_type'))}</label><select id="f_listing_type" name="listing_type">${opt(m.listing_types)}</select></div>
              <div class="field"><label for="f_price_min">${esc(t('price'))} ${esc(t('min'))}</label><input id="f_price_min" name="price_min" type="number" min="0" inputmode="numeric"></div>
              <div class="field"><label for="f_price_max">${esc(t('price'))} ${esc(t('max'))}</label><input id="f_price_max" name="price_max" type="number" min="0" inputmode="numeric"></div>
              <div class="field"><label for="f_size_min">${esc(t('size_acres'))} ${esc(t('min'))}</label><input id="f_size_min" name="size_min" type="number" min="0" step="any" inputmode="decimal"></div>
              <div class="field"><label for="f_size_max">${esc(t('size_acres'))} ${esc(t('max'))}</label><input id="f_size_max" name="size_max" type="number" min="0" step="any" inputmode="decimal"></div>
              <div class="field"><label for="f_region">${esc(t('region'))}</label><input id="f_region" name="region" placeholder="e.g. Nakuru, Kigali"></div>
              <div class="field"><label for="f_duration">${esc(t('duration'))}</label><input id="f_duration" name="duration_months" type="number" min="1" inputmode="numeric" placeholder="e.g. 24"></div>
            </div>
            <button class="btn primary small" type="submit">${esc(t('search'))}</button>
          </form>
          <div class="result-head">
            <strong id="count" aria-live="polite"></strong>
            <label class="row small"><span class="sr-only">${esc(t('sort'))}</span>
              <select id="sort" name="sort">${['newest', 'price_asc', 'price_desc', 'size_asc', 'size_desc'].map((s) => `<option value="${s}">${esc(t(s))}</option>`).join('')}</select>
            </label>
          </div>
          <div class="results" id="results"></div>
        </div>
        <div class="map-wrap"><div id="map" class="map" role="region" aria-label="Map of listings"></div></div>
        <button class="btn primary mobile-toggle" type="button" id="viewToggle">🗺 ${esc(t('map'))}</button>
      </div>`;

    const filtersEl = $('#filters');
    for (const k of FILTER_KEYS) { const el = filtersEl.elements[k] || $(`#${k}`); if (el && browseState.filters[k]) el.value = browseState.filters[k]; }
    if (browseState.filters.sort) $('#sort').value = browseState.filters.sort;

    const map = makeMap('map', { center: [-1.0, 33.5], zoom: 6 });
    const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 });
    map.addLayer(cluster);
    const markers = new Map();
    let activeId = null;
    let seq = 0;

    function setActive(id, { pan = false, scroll = false } = {}) {
      if (activeId && markers.has(activeId)) { const [mk, l] = markers.get(activeId); mk.setIcon(priceIcon(l)); }
      $$('.lcard.active').forEach((c) => c.classList.remove('active'));
      activeId = id;
      const card = $(`.lcard[data-id="${id}"]`);
      if (card) { card.classList.add('active'); if (scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      if (markers.has(id)) {
        const [mk, l] = markers.get(id);
        mk.setIcon(priceIcon(l, true));
        if (pan) cluster.zoomToShowLayer(mk, () => mk.openPopup());
      }
    }

    async function load() {
      const my = ++seq;
      const params = new URLSearchParams();
      if (browseState.q) params.set('q', browseState.q);
      for (const [k, v] of Object.entries(browseState.filters)) if (v) params.set(k, v);
      if (browseState.near) { params.set('near_lat', browseState.near.lat); params.set('near_lng', browseState.near.lng); params.set('radius_km', 100); }
      sessionStorage.setItem('ll_browse', JSON.stringify(browseState));
      const active = Object.entries(browseState.filters).filter(([k, v]) => v && k !== 'sort').length;
      $('#filterCount').textContent = active ? `(${active})` : '';
      $('#nearBtn').setAttribute('aria-pressed', !!browseState.near);
      $('#results').innerHTML = Array.from({ length: 4 }, () => '<div class="skeleton" style="height:116px"></div>').join('');
      let data;
      try { data = await api(`/listings?${params}`); } catch (e) { $('#results').innerHTML = empty(e.message); return; }
      if (my !== seq) return; // a newer search started
      $('#count').textContent = t('results', { n: data.total });
      cluster.clearLayers(); markers.clear();
      if (!data.results.length) { $('#results').innerHTML = empty(t('no_results'), t('no_results_hint')); return; }
      $('#results').innerHTML = data.results.map((l) => `
        <a class="card lcard" href="#/listing/${l.id}" data-id="${l.id}">
          ${coverImg(l)}
          <div>
            <div class="row" style="gap:4px">${verifiedPill} ${typePills(l)}</div>
            <h3>${esc(l.title)}</h3>
            <div class="price">${esc(priceText(l))}${l.negotiable ? ` <span class="muted small">· ${esc(t('negotiable'))}</span>` : ''}</div>
            <div class="meta">${esc(sizeText(l))} · ${esc(t(l.land_type))} · ${esc(place(l))}${l.distance_km != null ? ` · ${l.distance_km} km` : ''}</div>
          </div>
        </a>`).join('');
      const bounds = [];
      for (const l of data.results) {
        if (l.lat == null) continue;
        const mk = L.marker([l.lat, l.lng], { icon: priceIcon(l), title: l.title, keyboard: true });
        mk.bindPopup(`<a class="popup-card" href="#/listing/${l.id}">${l.cover ? `<img src="${esc(l.cover)}" alt="">` : ''}<strong>${esc(l.title)}</strong><br>${esc(priceText(l))}<br><span class="muted">${esc(sizeText(l))} · ${esc(place(l))}</span></a>`);
        mk.on('click', () => setActive(l.id, { scroll: true }));
        cluster.addLayer(mk);
        markers.set(l.id, [mk, l]);
        bounds.push([l.lat, l.lng]);
      }
      if (browseState.near) bounds.push([browseState.near.lat, browseState.near.lng]);
      if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    }

    $('#results').addEventListener('mouseover', (e) => { const c = e.target.closest('.lcard'); if (c && Number(c.dataset.id) !== activeId) setActive(Number(c.dataset.id)); });
    $('#results').addEventListener('click', (e) => {
      const c = e.target.closest('.lcard');
      // On desktop the first click highlights on the map; a click on an active card opens it.
      if (c && innerWidth > 860 && Number(c.dataset.id) !== activeId) { e.preventDefault(); setActive(Number(c.dataset.id), { pan: true }); }
    });
    $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); browseState.q = $('#q').value.trim(); load(); });
    filtersEl.addEventListener('submit', (e) => {
      e.preventDefault();
      for (const k of FILTER_KEYS) if (filtersEl.elements[k]) browseState.filters[k] = filtersEl.elements[k].value;
      load();
    });
    $('#sort').addEventListener('change', (e) => { browseState.filters.sort = e.target.value; load(); });
    $('#filterBtn').addEventListener('click', () => { const o = filtersEl.classList.toggle('open'); $('#filterBtn').setAttribute('aria-expanded', o); });
    $('#clearBtn').addEventListener('click', () => { browseState.q = ''; browseState.filters = {}; browseState.near = null; $('#q').value = ''; filtersEl.reset(); $('#sort').value = 'newest'; load(); });
    $('#nearBtn').addEventListener('click', () => {
      if (browseState.near) { browseState.near = null; load(); return; }
      if (!navigator.geolocation) return toast('Location is not available in this browser.');
      $('#nearBtn').disabled = true;
      navigator.geolocation.getCurrentPosition(
        (p) => { $('#nearBtn').disabled = false; browseState.near = { lat: p.coords.latitude, lng: p.coords.longitude }; load(); },
        () => { $('#nearBtn').disabled = false; toast('Couldn\'t get your location. Check location permissions.'); },
        { timeout: 10000 },
      );
    });
    $('#viewToggle').addEventListener('click', () => {
      const show = $('#browse').classList.toggle('show-map');
      $('#viewToggle').textContent = show ? `☰ ${t('list')}` : `🗺 ${t('map')}`;
      setTimeout(() => map.invalidateSize(), 50);
    });
    const onResize = () => map.invalidateSize();
    addEventListener('resize', onResize);
    cleanup = () => { removeEventListener('resize', onResize); map.remove(); };
    await load();
  }

  // ---------- detail ----------
  async function viewDetail(m) {
    const { listing: l } = await api(`/listings/${m[1]}`);
    const u = state.user;
    const f = l.features || {};
    const featureRows = [
      ['Water source', f.water_source], ['Road access', f.road_access], ['Soil type', f.soil_type],
      ['Electricity', f.electricity ? 'Yes' : null], ['Fenced', f.fenced ? 'Yes' : null], ['Borehole', f.borehole ? 'Yes' : null], ['Irrigation', f.irrigation ? 'Yes' : null],
    ].filter(([, v]) => v);
    const dur = l.duration_min || l.duration_max ? `${l.duration_min ?? '–'} to ${l.duration_max ?? '–'} ${l.duration_unit || ''}` : '—';
    const canNegotiate = u && u.role === 'customer' && l.status === 'verified';
    main.innerHTML = `
      <div class="page">
        <p><a href="#/">← ${esc(t('browse'))}</a></p>
        ${l.status !== 'verified' ? `<p class="notice">This listing is <strong>${esc(t(`status_${l.status}`))}</strong> and isn't visible to customers.${l.reject_reason ? ` Reason: ${esc(l.reject_reason)}` : ''}</p>` : ''}
        <div class="detail">
          <div>
            <div class="gallery">
              ${l.photos.length ? `<img class="main" id="mainPhoto" src="${esc(l.photos[0].url)}" alt="Photo 1 of ${esc(l.title)}">` : '<div class="main skeleton" style="animation:none"></div>'}
              ${l.photos.length > 1 ? `<div class="thumbs" role="list">${l.photos.map((p, i) => `<button type="button" role="listitem" data-src="${esc(p.url)}" data-i="${i + 1}" aria-current="${i === 0}" aria-label="Show photo ${i + 1}"><img src="${esc(p.url)}" alt=""></button>`).join('')}</div>` : ''}
            </div>
            <div class="row" style="margin-top:16px">${l.verified ? verifiedPill : ''} ${typePills(l)} <span class="pill">${esc(t(l.land_type))}</span></div>
            <h1 style="margin-top:8px">${esc(l.title)}</h1>
            <p class="muted">${esc(place(l))}</p>
            <div class="facts">
              <div class="fact"><div class="k">Size</div><div class="v">${esc(sizeText(l))}</div></div>
              <div class="fact"><div class="k">${esc(t('price'))}</div><div class="v">${esc(priceText(l))}</div></div>
              <div class="fact"><div class="k">Duration</div><div class="v">${esc(dur)}</div></div>
              <div class="fact"><div class="k">Available from</div><div class="v">${esc(l.available_from || 'Now')}</div></div>
            </div>
            <h2>${esc(t('description'))}</h2>
            <p style="white-space:pre-wrap">${esc(l.description) || '<span class="muted">No description.</span>'}</p>
            ${l.permitted_uses.length ? `<h2>${esc(t('permitted'))}</h2><div class="tags">${l.permitted_uses.map((x) => `<span class="tag">✓ ${esc(x)}</span>`).join('')}</div>` : ''}
            ${l.prohibited_uses.length ? `<h2 style="margin-top:16px">${esc(t('prohibited'))}</h2><div class="tags">${l.prohibited_uses.map((x) => `<span class="tag no">✕ ${esc(x)}</span>`).join('')}</div>` : ''}
            ${l.uses_notes ? `<p class="muted small" style="margin-top:8px">${esc(l.uses_notes)}</p>` : ''}
            ${featureRows.length ? `<h2 style="margin-top:16px">${esc(t('features'))}</h2><div class="facts">${featureRows.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>` : ''}
            ${l.lat != null ? `<h2>Location</h2><div id="detailMap" class="detail-map"></div>` : ''}
          </div>
          <aside class="sticky">
            <div class="card pad">
              <div class="big-price">${esc(priceText(l))}</div>
              ${l.negotiable ? `<p class="muted small" style="margin:0">${esc(t('negotiable'))}</p>` : ''}
              <p class="small">Listed by <strong>${esc(l.owner.name)}</strong></p>
              ${canNegotiate ? `
                <div class="row" style="margin:12px 0">
                  <button class="btn primary" id="offerBtn" type="button">${esc(t('make_offer'))}</button>
                  <button class="btn" id="msgBtn" type="button">${esc(t('message_owner'))}</button>
                </div>` : ''}
              ${u && l.status === 'verified' && !l.is_owner ? `<button class="btn small" id="saveBtn" type="button" aria-pressed="${l.saved}">${l.saved ? '♥ ' + esc(t('unsave')) : '♡ ' + esc(t('save'))}</button>` : ''}
              ${l.is_owner ? `<a class="btn" href="#/edit/${l.id}">${esc(t('edit'))}</a>` : ''}
              <h3 style="margin-top:16px">${esc(t('contacts'))}</h3>
              ${l.contacts ? `<ul class="small" style="padding-left:18px;margin:0">
                  ${l.contacts.phone ? `<li>Phone: <a href="tel:${esc(l.contacts.phone)}">${esc(l.contacts.phone)}</a></li>` : ''}
                  ${l.contacts.whatsapp ? `<li>WhatsApp: <a href="https://wa.me/${esc(l.contacts.whatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener">${esc(l.contacts.whatsapp)}</a></li>` : ''}
                  ${l.contacts.email ? `<li>Email: <a href="mailto:${esc(l.contacts.email)}">${esc(l.contacts.email)}</a></li>` : ''}
                </ul>` : `<p class="small"><a href="#/login">${esc(t('login_for_contacts'))}</a></p>`}
              ${l.deed_url ? `<p><a class="btn small" href="${esc(l.deed_url)}" target="_blank" rel="noopener">📄 ${esc(t('view_deed'))}</a></p>` : ''}
              ${l.id_url ? `<p class="small muted">Your ID: <a href="${esc(l.id_url)}" target="_blank" rel="noopener">view</a> (only you and admins can see this)</p>` : ''}
              <p class="notice" style="margin-top:12px">${esc(t('disclaimer'))}</p>
              ${u && !l.is_owner ? `<button class="btn small danger" id="reportBtn" type="button">⚑ ${esc(t('report'))}</button>` : ''}
            </div>
          </aside>
        </div>
      </div>`;

    $$('.thumbs button').forEach((b) => b.addEventListener('click', () => {
      $('#mainPhoto').src = b.dataset.src; $('#mainPhoto').alt = `Photo ${b.dataset.i} of ${l.title}`;
      $$('.thumbs button').forEach((x) => x.setAttribute('aria-current', x === b));
    }));
    if (l.lat != null) {
      const map = makeMap('detailMap', { center: [l.lat, l.lng], zoom: 14, scrollWheelZoom: false });
      L.marker([l.lat, l.lng], { title: l.title }).addTo(map);
      cleanup = () => map.remove();
    }
    const saveBtn = $('#saveBtn');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const { saved } = await api(`/listings/${l.id}/save`, { method: 'POST' });
      saveBtn.setAttribute('aria-pressed', saved);
      saveBtn.textContent = saved ? `♥ ${t('unsave')}` : `♡ ${t('save')}`;
    });
    const offerBtn = $('#offerBtn');
    if (offerBtn) offerBtn.addEventListener('click', () => offerDialog({ listing_id: l.id }, l));
    const msgBtn = $('#msgBtn');
    if (msgBtn) msgBtn.addEventListener('click', () => formDialog({
      title: `${t('message_owner')}`,
      fields: '<div class="field"><label for="d_body">Message</label><textarea id="d_body" name="body" required maxlength="2000">Hello, is this land still available? I\'d like to arrange a site visit.</textarea></div>',
      submit: t('send'),
      onSubmit: async (fd) => { const r = await api('/messages', { method: 'POST', body: { listing_id: l.id, body: fd.get('body') } }); location.hash = `#/inbox/${r.thread_id}`; },
    }));
    const reportBtn = $('#reportBtn');
    if (reportBtn) reportBtn.addEventListener('click', () => formDialog({
      title: t('report'),
      fields: '<p class="small muted">Tell us why you think this listing may be fraudulent. Our team will review it.</p><div class="field"><label for="d_reason">Reason</label><textarea id="d_reason" name="reason" required minlength="5" maxlength="1000"></textarea></div>',
      submit: 'Send report',
      onSubmit: async (fd) => { await api(`/listings/${l.id}/report`, { method: 'POST', body: { reason: fd.get('reason') } }); toast('Thanks. Our team will review this listing.'); },
    }));
  }

  // ---------- dialogs ----------
  function formDialog({ title, fields, submit, onSubmit }) {
    const d = $('#dialog');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${fields}<p class="error" role="alert" id="d_err"></p>
      <div class="row" style="justify-content:flex-end"><button class="btn" value="cancel" type="button" id="d_cancel">Cancel</button><button class="btn primary" type="submit">${esc(submit)}</button></div></form>`;
    const form = $('form', d);
    $('#d_cancel', d).addEventListener('click', () => d.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try { await onSubmit(new FormData(form)); d.close(); } catch (err) { $('#d_err', d).textContent = err.message; } finally { btn.disabled = false; }
    });
    d.showModal();
    const first = $('input,textarea,select', form); if (first) first.focus();
  }
  function offerDialog(target, l, { counterOf = null } = {}) {
    formDialog({
      title: counterOf ? 'Counter-offer' : t('make_offer'),
      fields: `
        <div class="field"><label for="d_price">Your price (${esc(l.currency)}${l.price_unit && l.price_unit !== 'total' ? ` per ${esc(l.price_unit)}` : ''})</label>
          <input id="d_price" name="price" type="number" min="1" required inputmode="numeric" value="${esc(l.price || '')}"></div>
        <div class="field"><label for="d_dur">Proposed duration</label><input id="d_dur" name="duration" maxlength="60" placeholder="e.g. 2 years"></div>
        <div class="field"><label for="d_msg">Message (optional)</label><textarea id="d_msg" name="message" maxlength="1000"></textarea></div>
        <p class="notice small">${esc(t('disclaimer'))}</p>`,
      submit: counterOf ? 'Send counter-offer' : 'Send offer',
      onSubmit: async (fd) => {
        const body = { price: fd.get('price'), duration: fd.get('duration'), message: fd.get('message') };
        if (counterOf) {
          await api(`/offers/${counterOf}/respond`, { method: 'POST', body: { action: 'counter', ...body } });
          route();
        } else {
          const r = await api('/offers', { method: 'POST', body: { ...target, ...body } });
          location.hash = `#/inbox/${r.thread_id}`;
        }
      },
    });
  }

  // ---------- auth ----------
  function afterLogin(user) {
    state.user = user;
    refreshBell();
    const next = sessionStorage.getItem('ll_next'); sessionStorage.removeItem('ll_next');
    location.hash = next || (user.role === 'lender' ? '#/dashboard' : user.role === 'admin' ? '#/admin' : '#/');
  }
  function viewLogin() {
    main.innerHTML = `
      <div class="page"><div class="card pad auth">
        <h1>${esc(t('login'))}</h1>
        <form id="loginForm" novalidate>
          <div class="field"><label for="l_email">${esc(t('email'))}</label><input id="l_email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="l_pw">${esc(t('password'))}</label><input id="l_pw" name="password" type="password" autocomplete="current-password" required></div>
          <p class="error" role="alert" id="l_err"></p>
          <button class="btn primary" type="submit" style="width:100%">${esc(t('login'))}</button>
        </form>
        <p class="small">New here? <a href="#/register">${esc(t('register'))}</a></p>
      </div></div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const btn = $('button', e.target); btn.disabled = true;
      try { const { user } = await api('/auth/login', { method: 'POST', body: Object.fromEntries(fd) }); afterLogin(user); } catch (err) { $('#l_err').textContent = err.message; } finally { btn.disabled = false; }
    });
  }
  function viewRegister() {
    main.innerHTML = `
      <div class="page"><div class="card pad auth">
        <h1>${esc(t('register'))}</h1>
        <form id="regForm" novalidate>
          <fieldset class="field" style="border:0;padding:0"><legend>${esc(t('i_am'))}</legend>
            <div class="role-pick">
              <label><input type="radio" name="role" value="customer" checked> <span>${esc(t('role_customer'))}</span></label>
              <label><input type="radio" name="role" value="lender"> <span>${esc(t('role_lender'))}</span></label>
            </div>
          </fieldset>
          <div class="field"><label for="r_name">${esc(t('name'))}</label><input id="r_name" name="name" autocomplete="name" required minlength="2"></div>
          <div class="field"><label for="r_email">${esc(t('email'))}</label><input id="r_email" name="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="r_phone">${esc(t('phone'))}</label><input id="r_phone" name="phone" type="tel" autocomplete="tel" placeholder="+254…"></div>
          <div class="field"><label for="r_pw">${esc(t('password'))}</label><input id="r_pw" name="password" type="password" autocomplete="new-password" required minlength="8" aria-describedby="r_pw_hint"><span class="hint" id="r_pw_hint">At least 8 characters, with a letter and a number.</span></div>
          <p class="error" role="alert" id="r_err"></p>
          <button class="btn primary" type="submit" style="width:100%">${esc(t('register'))}</button>
        </form>
        <p class="small">Have an account? <a href="#/login">${esc(t('login'))}</a></p>
      </div></div>`;
    $('#regForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button', e.target); btn.disabled = true;
      try { const { user } = await api('/auth/register', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); afterLogin(user); } catch (err) { $('#r_err').textContent = err.message; } finally { btn.disabled = false; }
    });
  }

  // ---------- lender dashboard ----------
  async function viewDashboard() {
    const { results } = await api('/listings/mine');
    const totals = results.reduce((a, l) => ({ v: a.v + l.views, s: a.s + l.saves, i: a.i + l.inquiries }), { v: 0, s: 0, i: 0 });
    main.innerHTML = `
      <div class="page">
        <div class="row" style="justify-content:space-between"><h1>${esc(t('dashboard'))}</h1><a class="btn primary" href="#/new">+ ${esc(t('new_listing'))}</a></div>
        <div class="grid3" style="margin-bottom:16px">
          <div class="card pad"><div class="muted small">Total ${esc(t('views'))}</div><div class="big-price">${totals.v}</div></div>
          <div class="card pad"><div class="muted small">Total ${esc(t('saves'))}</div><div class="big-price">${totals.s}</div></div>
          <div class="card pad"><div class="muted small">Total ${esc(t('inquiries'))}</div><div class="big-price">${totals.i}</div></div>
        </div>
        <div class="mine">
          ${results.length ? results.map((l) => `
            <div class="card mine-item" data-id="${l.id}">
              ${l.photos[0] ? `<img src="${esc(l.photos[0].url)}" alt="">` : '<div class="noimg"></div>'}
              <div>
                <div class="row" style="gap:6px">${statusPill(l.status)}${l.duplicate_deed ? '<span class="pill rejected">Duplicate deed number</span>' : ''}</div>
                <h3 style="margin:4px 0"><a href="#/listing/${l.id}">${esc(l.title)}</a></h3>
                <div class="small">${esc(priceText(l))} · ${esc(sizeText(l))}</div>
                ${l.reject_reason ? `<div class="small error">Rejected: ${esc(l.reject_reason)}</div>` : ''}
                <div class="stats"><span>👁 ${l.views} ${esc(t('views'))}</span><span>♥ ${l.saves} ${esc(t('saves'))}</span><span>✉ ${l.inquiries} ${esc(t('inquiries'))}</span></div>
              </div>
              <div class="row actions">
                <a class="btn small" href="#/edit/${l.id}">${esc(t('edit'))}</a>
                ${['draft', 'rejected'].includes(l.status) ? `<button class="btn small primary" data-act="submit">${esc(t('submit_review'))}</button>` : ''}
                ${l.status === 'verified' ? `<button class="btn small" data-act="pause">${esc(t('pause'))}</button>` : ''}
                ${l.status === 'paused' ? `<button class="btn small" data-act="resume">${esc(t('resume'))}</button>` : ''}
                <button class="btn small danger" data-act="delete">${esc(t('delete'))}</button>
              </div>
            </div>`).join('') : `<div class="card">${empty(t('empty_mine'), 'Create your first listing to reach customers.')}</div>`}
        </div>
      </div>`;
    $('.mine').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.closest('[data-id]').dataset.id; const act = b.dataset.act;
      if (act === 'delete') {
        return formDialog({ title: 'Delete listing?', fields: '<p>This permanently removes the listing, its photos and documents. This can\'t be undone.</p>', submit: 'Delete', onSubmit: async () => { await api(`/listings/${id}`, { method: 'DELETE' }); toast('Listing deleted.'); route(); } });
      }
      b.disabled = true;
      try { await api(`/listings/${id}/${act}`, { method: 'POST' }); toast(act === 'submit' ? 'Submitted for verification.' : 'Updated.'); route(); } catch (err) { toast(err.message); b.disabled = false; }
    });
  }

  // ---------- listing form ----------
  async function viewForm(_m, id) {
    const meta = state.meta;
    const l = id ? (await api(`/listings/${id}`)).listing : null;
    if (l && !l.is_owner) throw new Error('You can only edit your own listings.');
    const val = (k, d = '') => esc(l ? (l[k] ?? d) : d);
    const sel = (name, list, cur, label = (x) => t(x)) => `<select id="i_${name}" name="${name}" required>${list.map((x) => `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(label(x))}</option>`).join('')}</select>`;
    const checks = (name, list, cur = []) => {
      const extras = cur.filter((x) => !list.includes(x));
      return `<div class="checks">${list.map((x) => `<label><input type="checkbox" name="${name}" value="${esc(x)}" ${cur.includes(x) ? 'checked' : ''}> ${esc(x)}</label>`).join('')}</div>
        <div class="field" style="margin-top:8px"><label for="i_${name}_other" class="small">Other (comma-separated)</label><input id="i_${name}_other" name="${name}_other" value="${esc(extras.join(', '))}"></div>`;
    };
    const f = (l && l.features) || {};
    const u = state.user;
    main.innerHTML = `
      <div class="page">
        <p><a href="#/dashboard">← ${esc(t('dashboard'))}</a></p>
        <h1>${l ? `${esc(t('edit'))}: ${esc(l.title)}` : esc(t('new_listing'))}</h1>
        ${l && ['verified', 'rejected'].includes(l.status) ? '<p class="notice">Saving changes will send this listing back for verification. It will be hidden until an admin approves it again.</p>' : ''}
        <form id="listingForm" class="card pad" novalidate>
          <fieldset><legend>Basics</legend>
            <div class="field"><label for="i_title">Title</label><input id="i_title" name="title" required minlength="5" maxlength="120" value="${val('title')}" placeholder="e.g. 5 acres of fertile farmland near Nakuru"></div>
            <div class="field"><label for="i_description">${esc(t('description'))}</label><textarea id="i_description" name="description" maxlength="5000">${val('description')}</textarea></div>
            <div class="grid3">
              <div class="field"><label for="i_land_type">${esc(t('land_type'))}</label>${sel('land_type', meta.land_types, l && l.land_type)}</div>
              <div class="field"><label for="i_size">Size</label><input id="i_size" name="size" type="number" step="any" min="0" required inputmode="decimal" value="${val('size')}"></div>
              <div class="field"><label for="i_size_unit">Unit</label>${sel('size_unit', meta.size_units, l ? l.size_unit : 'acres', (x) => x)}</div>
            </div>
            <fieldset class="field" style="border:0;padding:0;margin:0"><legend>${esc(t('listing_type'))}</legend>
              <div class="checks">${meta.listing_types.map((x) => `<label><input type="checkbox" name="listing_types" value="${x}" ${l ? (l.listing_types.includes(x) ? 'checked' : '') : (x === 'lease' ? 'checked' : '')}> ${esc(t(x))}${x === 'partnership' ? ' (profit-sharing)' : ''}</label>`).join('')}</div>
            </fieldset>
          </fieldset>

          <fieldset><legend>${esc(t('price'))} and terms</legend>
            <div class="grid3">
              <div class="field"><label for="i_price">${esc(t('price'))}</label><input id="i_price" name="price" type="number" min="0" required inputmode="numeric" value="${val('price')}"><span class="hint">Use 0 for profit-share only.</span></div>
              <div class="field"><label for="i_currency">Currency</label>${sel('currency', meta.currencies, l ? l.currency : 'KES', (x) => x)}</div>
              <div class="field"><label for="i_price_unit">Per</label>${sel('price_unit', meta.price_units, l ? l.price_unit : 'year')}</div>
            </div>
            <label class="checks"><input type="checkbox" name="negotiable" value="true" ${!l || l.negotiable ? 'checked' : ''}> ${esc(t('negotiable'))}</label>
            <div class="grid3" style="margin-top:12px">
              <div class="field"><label for="i_duration_min">Min. duration</label><input id="i_duration_min" name="duration_min" type="number" min="0" inputmode="numeric" value="${val('duration_min')}"></div>
              <div class="field"><label for="i_duration_max">Max. duration</label><input id="i_duration_max" name="duration_max" type="number" min="0" inputmode="numeric" value="${val('duration_max')}"></div>
              <div class="field"><label for="i_duration_unit">Duration unit</label>${sel('duration_unit', meta.duration_units, l ? l.duration_unit || 'years' : 'years', (x) => x)}</div>
            </div>
            <div class="field"><label for="i_available_from">Available from</label><input id="i_available_from" name="available_from" type="date" value="${val('available_from')}"></div>
          </fieldset>

          <fieldset><legend>Location</legend>
            <div class="grid3">
              <div class="field"><label for="i_country">Country</label><select id="i_country" name="country">${['Kenya', 'Rwanda', 'Uganda', 'Tanzania'].map((c) => `<option ${l && l.country === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
              <div class="field"><label for="i_region">Region / county</label><input id="i_region" name="region" value="${val('region')}"></div>
              <div class="field"><label for="i_town">Town</label><input id="i_town" name="town" value="${val('town')}"></div>
            </div>
            <div class="field"><label for="i_addr">Find on map</label>
              <div class="row" style="flex-wrap:nowrap"><input id="i_addr" placeholder="Search an address or place"><button class="btn" type="button" id="addrBtn">Find</button></div>
              <span class="hint">Or click on the map to drop the pin at the exact spot.</span></div>
            <p><button class="btn" type="button" id="gpsBtn">📍 Use my current location</button>
              <span class="hint" id="gpsHint">Standing on the land? Use your phone's GPS for the most accurate pin.</span></p>
            <div id="pickMap" class="pick-map" aria-label="Map: click to place the pin"></div>
            <p class="small muted" id="latlng">${l && l.lat != null ? `Pin: ${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : 'No pin placed yet.'}</p>
            <input type="hidden" name="lat" value="${val('lat')}"><input type="hidden" name="lng" value="${val('lng')}">
          </fieldset>

          <fieldset><legend>${esc(t('permitted'))}</legend>${checks('permitted_uses', meta.permitted, l ? l.permitted_uses : [])}</fieldset>
          <fieldset><legend>${esc(t('prohibited'))}</legend>${checks('prohibited_uses', meta.prohibited, l ? l.prohibited_uses : ['sub-leasing'])}
            <div class="field"><label for="i_uses_notes">Notes on use</label><input id="i_uses_notes" name="uses_notes" maxlength="1000" value="${val('uses_notes')}"></div></fieldset>

          <fieldset><legend>${esc(t('features'))}</legend>
            <div class="grid2">
              <div class="field"><label for="i_water">Water source</label><input id="i_water" data-feature="water_source" value="${esc(f.water_source || '')}" placeholder="e.g. borehole, river"></div>
              <div class="field"><label for="i_road">Road access</label><input id="i_road" data-feature="road_access" value="${esc(f.road_access || '')}" placeholder="e.g. tarmac 1km"></div>
              <div class="field"><label for="i_soil">Soil type</label><input id="i_soil" data-feature="soil_type" value="${esc(f.soil_type || '')}" placeholder="e.g. red loam"></div>
            </div>
            <div class="checks">${['electricity', 'fenced', 'borehole', 'irrigation'].map((k) => `<label><input type="checkbox" data-feature="${k}" ${f[k] ? 'checked' : ''}> ${k[0].toUpperCase() + k.slice(1)}</label>`).join('')}</div>
          </fieldset>

          <fieldset><legend>Contacts</legend>
            <p class="hint">Shown only to logged-in users.</p>
            <div class="grid3">
              <div class="field"><label for="i_cp">Phone</label><input id="i_cp" name="contact_phone" type="tel" value="${l ? esc(l.contacts?.phone || '') : esc(u.phone || '')}"></div>
              <div class="field"><label for="i_cw">WhatsApp</label><input id="i_cw" name="contact_whatsapp" type="tel" value="${l ? esc(l.contacts?.whatsapp || '') : esc(u.phone || '')}"></div>
              <div class="field"><label for="i_ce">Email</label><input id="i_ce" name="contact_email" type="email" value="${l ? esc(l.contacts?.email || '') : esc(u.email)}"></div>
            </div>
          </fieldset>

          <fieldset><legend>Photos</legend>
            ${l && l.photos.length ? `<div class="photo-strip" id="photoStrip">${l.photos.map((p) => `<figure><img src="${esc(p.url)}" alt=""><button type="button" data-photo="${p.id}" aria-label="Remove photo">✕</button></figure>`).join('')}</div>` : ''}
            <div class="field" style="margin-top:8px"><label for="i_photos">Add photos</label><input id="i_photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><span class="hint">JPG, PNG or WebP, up to 5MB each, max 10.</span></div>
          </fieldset>

          <fieldset><legend>Verification documents (private)</legend>
            <p class="hint">Only you and LandLink admins can see these. Your ID is never shown to customers.</p>
            <div class="field"><label for="i_deed_number">Title deed number (optional)</label><input id="i_deed_number" name="deed_number" maxlength="60" value="${val('deed_number')}" placeholder="e.g. NAKURU/BAHATI/1123 or the Rwanda UPI"><span class="hint">Used to detect duplicate listings of the same land.</span></div>
            <div class="grid2">
              <div class="field"><label for="i_deed">Title deed ${l && l.has_deed ? '(uploaded ✓, replace)' : ''}</label><input id="i_deed" name="deed" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><span class="hint">PDF or image, up to 10MB.</span></div>
              <div class="field"><label for="i_id">National ID or passport ${l && l.has_id ? '(uploaded ✓, replace)' : ''}</label><input id="i_id" name="id_doc" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"><span class="hint">PDF or image, up to 10MB.</span></div>
            </div>
            <label class="checks"><input type="checkbox" name="show_deed" value="true" ${l && l.show_deed ? 'checked' : ''}> Show title deed to customers</label>
          </fieldset>

          <p class="error" role="alert" id="f_err"></p>
          <div class="row">
            <button class="btn" type="submit" data-submit="false">Save draft</button>
            <button class="btn primary" type="submit" data-submit="true">${esc(t('submit_review'))}</button>
          </div>
        </form>
      </div>`;

    const form = $('#listingForm');
    const start = l && l.lat != null ? [l.lat, l.lng] : [-0.5, 35.5];
    const map = makeMap('pickMap', { center: start, zoom: l && l.lat != null ? 14 : 6 });
    let pin = l && l.lat != null ? L.marker(start, { draggable: true }).addTo(map) : null;
    function setPin(lat, lng, zoom) {
      if (!pin) { pin = L.marker([lat, lng], { draggable: true }).addTo(map); pin.on('dragend', () => { const p = pin.getLatLng(); setPin(p.lat, p.lng); }); } else pin.setLatLng([lat, lng]);
      form.elements.lat.value = lat.toFixed(6); form.elements.lng.value = lng.toFixed(6);
      $('#latlng').textContent = `Pin: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      if (zoom) map.setView([lat, lng], zoom);
    }
    if (pin) pin.on('dragend', () => { const p = pin.getLatLng(); setPin(p.lat, p.lng); });
    map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng));
    cleanup = () => map.remove();

    async function geocode() {
      const q = $('#i_addr').value.trim(); if (!q) return;
      $('#addrBtn').disabled = true;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ke,rw,ug,tz&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en' } });
        const [hit] = await r.json();
        if (!hit) toast('Place not found. Try a nearby town, or click on the map.'); else setPin(+hit.lat, +hit.lon, 14);
      } catch { toast('Address search is unavailable. Click on the map instead.'); } finally { $('#addrBtn').disabled = false; }
    }
    $('#addrBtn').addEventListener('click', geocode);
    $('#gpsBtn').addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Location is not available on this device.');
      $('#gpsBtn').disabled = true;
      $('#gpsHint').textContent = 'Getting your location…';
      navigator.geolocation.getCurrentPosition(
        (p) => {
          $('#gpsBtn').disabled = false;
          setPin(p.coords.latitude, p.coords.longitude, 17);
          $('#gpsHint').textContent = `Pinned from GPS (accurate to about ${Math.round(p.coords.accuracy)} m). Drag the pin to adjust.`;
        },
        () => {
          $('#gpsBtn').disabled = false;
          $('#gpsHint').textContent = 'Couldn\'t get your location. Allow location access, or click on the map instead.';
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
      );
    });
    $('#i_addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); geocode(); } });

    const strip = $('#photoStrip');
    if (strip) strip.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-photo]'); if (!b) return;
      await api(`/listings/${l.id}/photos/${b.dataset.photo}`, { method: 'DELETE' });
      b.closest('figure').remove();
    });

    let submitFlag = 'false';
    $$('button[type=submit]', form).forEach((b) => b.addEventListener('click', () => { submitFlag = b.dataset.submit; }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#f_err'); err.textContent = '';
      const photos = $('#i_photos').files;
      for (const p of photos) if (p.size > 5 * 1024 * 1024) { err.textContent = `"${p.name}" is larger than 5MB.`; return; }
      for (const inp of [$('#i_deed'), $('#i_id')]) if (inp.files[0] && inp.files[0].size > 10 * 1024 * 1024) { err.textContent = 'Documents must be 10MB or smaller.'; return; }

      const fd = new FormData();
      for (const el of form.elements) {
        if (!el.name || el.type === 'file' || el.name.endsWith('_other') || ['listing_types', 'permitted_uses', 'prohibited_uses'].includes(el.name)) continue;
        if (el.type === 'checkbox') { if (el.checked) fd.append(el.name, el.value); continue; }
        fd.append(el.name, el.value);
      }
      fd.append('listing_types', $$('input[name=listing_types]:checked', form).map((x) => x.value).join(','));
      for (const k of ['permitted_uses', 'prohibited_uses']) {
        const list = [...$$(`input[name=${k}]:checked`, form).map((x) => x.value), ...form.elements[`${k}_other`].value.split(',').map((s) => s.trim()).filter(Boolean)];
        fd.append(k, JSON.stringify(list));
      }
      const feats = {};
      $$('[data-feature]', form).forEach((el) => { feats[el.dataset.feature] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
      fd.append('features', JSON.stringify(feats));
      for (const p of photos) fd.append('photos', p);
      if ($('#i_deed').files[0]) fd.append('deed', $('#i_deed').files[0]);
      if ($('#i_id').files[0]) fd.append('id_doc', $('#i_id').files[0]);
      fd.append('submit', submitFlag);

      const btns = $$('button[type=submit]', form); btns.forEach((b) => { b.disabled = true; });
      try {
        await api(l ? `/listings/${l.id}` : '/listings', { method: l ? 'PUT' : 'POST', body: fd });
        toast(submitFlag === 'true' ? 'Submitted for verification. We\'ll notify you when it\'s reviewed.' : 'Saved.');
        location.hash = '#/dashboard';
      } catch (ex) {
        // A draft may have been created before the submit check failed; keep the user on the form.
        err.textContent = ex.message;
        btns.forEach((b) => { b.disabled = false; });
      }
    });
  }

  // ---------- saved ----------
  async function viewSaved() {
    const { results } = await api('/listings/saved');
    main.innerHTML = `<div class="page"><h1>${esc(t('saved'))}</h1>
      <div class="mine">${results.length ? results.map((l) => `
        <a class="card lcard" href="#/listing/${l.id}">${coverImg(l)}<div><div class="row">${verifiedPill} ${typePills(l)}</div><h3>${esc(l.title)}</h3><div class="price">${esc(priceText(l))}</div><div class="meta">${esc(sizeText(l))} · ${esc(place(l))}</div></div></a>`).join('')
    : `<div class="card">${empty(t('empty_saved'), 'Tap ♡ Save on a listing to keep it here.')}</div>`}</div></div>`;
  }

  // ---------- inbox ----------
  let inboxPoll;
  async function viewInbox(m) {
    const threadId = m[1] ? Number(m[1]) : null;
    const { results } = await api('/messages/threads');
    const me = state.user;
    main.innerHTML = `
      <div class="page">
        <h1>${esc(t('inbox'))}</h1>
        <p class="notice small">${esc(t('disclaimer'))}</p>
        <div class="inbox ${threadId ? 'has-thread' : ''}" style="margin-top:12px">
          <div class="thread-list">${results.length ? results.map((th) => `
            <a href="#/inbox/${th.id}" class="card thread-link ${th.id === threadId ? 'active' : ''}">
              <strong>${esc(th.listing_title)}</strong>
              <div class="small">${esc(me.id === th.customer_id ? th.lender_name : th.customer_name)}${th.offer_status ? ` · <span class="pill">${esc(th.offer_status)}</span>` : ''}</div>
              <div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(th.last_message || '')}</div>
            </a>`).join('') : `<div class="card">${empty(t('empty_inbox'), me.role === 'customer' ? 'Open a listing and make an offer or message the owner.' : 'Offers from customers will appear here.')}</div>`}
          </div>
          <div id="threadPane">${threadId ? loading() : `<div class="card">${empty('Select a conversation')}</div>`}</div>
        </div>
      </div>`;
    if (threadId) await renderThread(threadId);
  }
  async function renderThread(id) {
    const pane = $('#threadPane');
    const d = await api(`/messages/threads/${id}`);
    const me = d.me;
    const name = Object.fromEntries(d.names.map((n) => [n.id, n.name]));
    const open = d.offers.slice().reverse().find((o) => o.status === 'offered');
    const accepted = d.offers.find((o) => o.status === 'accepted');
    const isCustomer = me === d.thread.customer_id;
    pane.innerHTML = `
      <div class="card thread">
        <div class="pad" style="border-bottom:1px solid var(--border)">
          <a href="#/inbox" class="small inbox-back">← All conversations</a>
          <h2 style="margin:4px 0"><a href="#/listing/${d.listing.id}">${esc(d.listing.title)}</a></h2>
          <div class="small muted">Asking ${esc(d.listing.currency)} ${num(d.listing.price)}${d.listing.price_unit !== 'total' ? ` / ${esc(d.listing.price_unit)}` : ''}</div>
        </div>
        <div class="msgs" id="msgs">${d.messages.map((x) => `
          <div class="msg ${x.from_user === me ? 'me' : ''}">${x.offer_id ? '💰 ' : ''}${esc(x.body)}<div class="when">${esc(x.from_user === me ? 'You' : name[x.from_user])} · ${esc(when(x.created_at))}</div></div>`).join('') || '<p class="muted small">No messages yet.</p>'}</div>
        ${accepted ? `<div class="offer-box"><strong>✓ Offer accepted:</strong> ${esc(d.listing.currency)} ${num(accepted.price)}${accepted.duration ? `, ${esc(accepted.duration)}` : ''}. Arrange a site visit and have a lawyer draft the agreement. LandLink does not handle payments.</div>` : ''}
        ${open ? `<div class="offer-box">
            <div><strong>Open offer:</strong> ${esc(d.listing.currency)} ${num(open.price)}${open.duration ? ` · ${esc(open.duration)}` : ''} <span class="muted small">from ${esc(open.from_user === me ? 'you' : name[open.from_user])}</span></div>
            ${open.from_user !== me ? `<div class="row" style="margin-top:8px">
              <button class="btn small primary" data-respond="accept">${esc(t('accept'))}</button>
              <button class="btn small" data-respond="counter">${esc(t('counter'))}</button>
              <button class="btn small danger" data-respond="decline">${esc(t('decline'))}</button></div>` : '<div class="small muted">Waiting for a response.</div>'}
          </div>` : (isCustomer && !accepted ? `<div class="offer-box"><button class="btn small primary" id="newOffer">${esc(t('make_offer'))}</button></div>` : '')}
        <form class="compose" id="compose">
          <label for="c_body" class="sr-only">Message</label>
          <input id="c_body" name="body" maxlength="2000" placeholder="Write a message…" autocomplete="off" required>
          <button class="btn primary" type="submit">${esc(t('send'))}</button>
        </form>
      </div>`;
    const msgs = $('#msgs'); msgs.scrollTop = msgs.scrollHeight;
    $('#compose').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = $('#c_body').value.trim(); if (!body) return;
      $('#c_body').value = '';
      try { await api('/messages', { method: 'POST', body: { thread_id: id, body } }); renderThread(id); } catch (err) { toast(err.message); }
    });
    pane.querySelectorAll('[data-respond]').forEach((b) => b.addEventListener('click', async () => {
      const action = b.dataset.respond;
      if (action === 'counter') return offerDialog(null, { ...d.listing, price: open.price }, { counterOf: open.id });
      b.disabled = true;
      try { await api(`/offers/${open.id}/respond`, { method: 'POST', body: { action } }); toast(`Offer ${action}ed.`); route(); } catch (err) { toast(err.message); }
    }));
    const no = $('#newOffer');
    if (no) no.addEventListener('click', () => offerDialog({ thread_id: id }, d.listing));
    clearInterval(inboxPoll);
    const count = d.messages.length;
    inboxPoll = setInterval(async () => {
      if (!document.body.contains(pane)) return clearInterval(inboxPoll);
      try { const n = await api(`/messages/threads/${id}`); if (n.messages.length !== count && !$('#c_body').value) renderThread(id); } catch { /* ignore */ }
    }, 10000);
    cleanup = () => clearInterval(inboxPoll);
  }

  // ---------- notifications ----------
  async function viewNotifications() {
    const { results } = await api('/notifications');
    main.innerHTML = `<div class="page"><h1>${esc(t('notifications'))}</h1><div class="card">${results.length
      ? results.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/')}"><strong>${esc(n.title)}</strong><div class="small">${esc(n.body)}</div><div class="small muted">${esc(when(n.created_at))}</div></a>`).join('')
      : empty('No notifications yet.')}</div></div>`;
    await api('/notifications/read', { method: 'POST' });
    refreshBell();
  }

  // ---------- admin ----------
  let adminTab = 'queue';
  async function viewAdmin() {
    const s = await api('/admin/stats');
    main.innerHTML = `
      <div class="page">
        <h1>${esc(t('admin'))}</h1>
        <div class="tabs" role="tablist">
          ${[['queue', `Review queue (${s.pending})`], ['reports', `Reports (${s.open_reports})`], ['users', `Users (${s.users})`]].map(([k, l]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="${adminTab === k}">${esc(l)}</button>`).join('')}
        </div>
        <div id="adminPane">${loading()}</div>
      </div>`;
    $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { adminTab = b.dataset.tab; viewAdmin(); } });
    const pane = $('#adminPane');
    if (adminTab === 'queue') {
      const { results } = await api('/admin/queue');
      pane.innerHTML = results.length ? results.map((l) => `
        <div class="card pad" style="margin-bottom:16px" data-id="${l.id}">
          <div class="row" style="justify-content:space-between">
            <div><h2 style="margin:0"><a href="#/listing/${l.id}">${esc(l.title)}</a></h2>
              <div class="small muted">${esc(l.owner_name)} (${esc(l.owner_email)}) · ${esc(place(l))} · ${esc(priceText(l))} · ${esc(sizeText(l))}</div>
              <div class="small">Deed no.: <strong>${esc(l.deed_number || 'not given')}</strong> ${l.duplicate_deed ? '<span class="pill rejected">⚠ Duplicate deed number</span>' : ''}</div>
              ${l.deed_conflicts.length ? `<div class="small error">Same deed number used by: ${l.deed_conflicts.map((c) => `<a href="#/listing/${c.id}">#${c.id} ${esc(c.title)}</a> (${esc(c.status)})`).join(', ')}</div>` : ''}
            </div>
            <div class="row"><button class="btn primary" data-act="approve">Approve</button><button class="btn danger" data-act="reject">Reject</button></div>
          </div>
          <div class="review" style="margin-top:12px">
            <div><h3>Listing</h3>${l.photos[0] ? `<img src="${esc(l.photos[0].url)}" alt="" style="border-radius:8px;width:100%;aspect-ratio:4/3;object-fit:cover">` : '<p class="muted">No photos</p>'}<p class="small" style="white-space:pre-wrap">${esc(l.description.slice(0, 400))}</p></div>
            <div><h3>Title deed</h3>${l.deed_url ? `<iframe class="doc-frame" src="${esc(l.deed_url)}" title="Title deed"></iframe><a class="small" href="${esc(l.deed_url)}" target="_blank" rel="noopener">Open in new tab</a>` : '<p class="error">Missing</p>'}</div>
            <div><h3>Owner ID</h3>${l.id_url ? `<iframe class="doc-frame" src="${esc(l.id_url)}" title="Owner ID"></iframe><a class="small" href="${esc(l.id_url)}" target="_blank" rel="noopener">Open in new tab</a>` : '<p class="error">Missing</p>'}</div>
          </div>
        </div>`).join('') : `<div class="card">${empty('The review queue is empty.', 'New submissions will appear here.')}</div>`;
      pane.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const id = b.closest('[data-id]').dataset.id;
        if (b.dataset.act === 'approve') {
          b.disabled = true;
          try { await api(`/admin/listings/${id}/approve`, { method: 'POST' }); toast('Listing approved and published.'); viewAdmin(); } catch (err) { toast(err.message); b.disabled = false; }
        } else {
          formDialog({ title: 'Reject listing', fields: '<div class="field"><label for="d_r">Reason (sent to the owner)</label><textarea id="d_r" name="reason" required minlength="5" maxlength="500" placeholder="e.g. The name on the title deed does not match the ID."></textarea></div>', submit: 'Reject', onSubmit: async (fd) => { await api(`/admin/listings/${id}/reject`, { method: 'POST', body: { reason: fd.get('reason') } }); toast('Listing rejected.'); viewAdmin(); } });
        }
      });
    } else if (adminTab === 'reports') {
      const { results } = await api('/admin/reports');
      pane.innerHTML = results.length ? `<div class="card table-wrap"><table><thead><tr><th>Listing</th><th>Reason</th><th>By</th><th>Status</th><th></th></tr></thead><tbody>${results.map((r) => `
        <tr data-id="${r.id}"><td><a href="#/listing/${r.listing_id}">${esc(r.listing_title)}</a><div class="small muted">${esc(r.listing_status)}</div></td><td>${esc(r.reason)}</td><td>${esc(r.reporter_name)}<div class="small muted">${esc(when(r.created_at))}</div></td><td>${esc(r.status)}</td>
        <td>${r.status === 'open' ? '<div class="row"><button class="btn small" data-act="dismiss">Dismiss</button><button class="btn small danger" data-act="takedown">Take down</button></div>' : ''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="card">${empty('No reports.')}</div>`;
      pane.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        await api(`/admin/reports/${b.closest('[data-id]').dataset.id}/resolve`, { method: 'POST', body: { takedown: b.dataset.act === 'takedown' } });
        toast('Report resolved.'); viewAdmin();
      });
    } else {
      const { results } = await api('/admin/users');
      pane.innerHTML = `<div class="card table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Listings</th><th></th></tr></thead><tbody>${results.map((u) => `
        <tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.listings}</td>
        <td>${u.role === 'admin' ? '' : `<button class="btn small ${u.suspended ? '' : 'danger'}" data-suspend="${u.suspended ? 0 : 1}">${u.suspended ? 'Reinstate' : 'Suspend'}</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      pane.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-suspend]'); if (!b) return;
        await api(`/admin/users/${b.closest('[data-id]').dataset.id}/suspend`, { method: 'POST', body: { suspended: b.dataset.suspend === '1' } });
        toast(b.dataset.suspend === '1' ? 'User suspended. Their live listings were paused.' : 'User reinstated.'); viewAdmin();
      });
    }
  }

  // ---------- chatbot ----------
  const chat = {
    get history() { try { return JSON.parse(sessionStorage.getItem('ll_chat') || '[]'); } catch { return []; } },
    set history(h) { try { sessionStorage.setItem('ll_chat', JSON.stringify(h.slice(-30))); } catch { /* ignore */ } },
  };
  const chatLog = $('#chatLog');
  function chatCards(list) {
    if (!list || !list.length) return '';
    return `<div class="chat-cards">${list.map((l) => `<a class="chat-card" href="#/listing/${l.id}">${coverImg(l)}<div><strong>${esc(l.title)}</strong><br>${esc(priceText(l))} · ${esc(sizeText(l))}<br><span class="muted">${esc(place(l))}</span></div></a>`).join('')}</div>`;
  }
  function renderChat() {
    const h = chat.history;
    chatLog.innerHTML = `<div class="bubble">${md(t('chat_hello'))}</div>` + h.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : ''}">${m.role === 'user' ? esc(m.content) : md(m.content)}${chatCards(m.listings)}</div>`).join('');
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function toggleChat(open) {
    $('#chatPanel').classList.toggle('hidden', !open);
    $('#chatFab').setAttribute('aria-expanded', open);
    if (open) { renderChat(); $('#chatInput').focus(); }
  }
  $('#chatFab').addEventListener('click', () => toggleChat($('#chatPanel').classList.contains('hidden')));
  $('#chatClose').addEventListener('click', () => toggleChat(false));
  chatLog.addEventListener('click', (e) => { if (e.target.closest('a') && innerWidth <= 500) toggleChat(false); });
  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const message = input.value.trim(); if (!message) return;
    input.value = '';
    const prior = chat.history;
    chat.history = [...prior, { role: 'user', content: message }];
    renderChat();
    chatLog.insertAdjacentHTML('beforeend', '<div class="bubble" id="typing"><span class="typing" aria-label="Assistant is typing"><i></i><i></i><i></i></span></div>');
    chatLog.scrollTop = chatLog.scrollHeight;
    try {
      const r = await api('/chat', { method: 'POST', body: { message, history: prior.map(({ role, content }) => ({ role, content })) } });
      chat.history = [...chat.history, { role: 'assistant', content: r.reply, listings: r.listings }];
      $('#chatSource').textContent = r.source === 'ai' ? '· AI' : '· basic mode';
    } catch (err) {
      chat.history = [...chat.history, { role: 'assistant', content: err.message }];
    }
    renderChat();
  });

  // ---------- boot ----------
  (async () => {
    applyI18n();
    try {
      const [me, meta] = await Promise.all([api('/auth/me'), api('/listings/meta')]);
      state.user = me.user; state.meta = meta;
    } catch {
      main.innerHTML = `<div class="page">${empty('Can\'t reach the server. Check your connection and refresh.')}</div>`;
      return;
    }
    refreshBell();
    route();
  })();
})();
