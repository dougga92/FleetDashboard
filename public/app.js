// Live fleet board — polls /api/fleet and renders. Vanilla JS, no build step.
const POLL_MS = 10000;

const $ = (id) => document.getElementById(id);
// Average per order = revenue / orders. Every order counts as paid (payment
// isn't captured; test orders are voided at the venue by the "Test Test" name),
// so the venues' "unpaid" field is ignored. null when there are no orders.
const avgOrder = (revenue, orders) => {
  const n = Number(orders) || 0;
  return n > 0 ? (Number(revenue) || 0) / n : null;
};
const money = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ago(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's ago';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm ago';
  return Math.floor(m / 60) + 'h ago';
}

// whole = round to dollars (the small per-venue box has no room for cents on a phone)
function avgText(revenue, orders, whole = false) {
  const a = avgOrder(revenue, orders);
  if (a === null) return '—';
  return whole ? '$' + Math.round(a).toLocaleString() : money(a);
}

const num = (n) => (Number(n) || 0).toLocaleString();

// AJ's photo-to-sale ratio: orders ÷ photos taken, as a percent ("—" with no photos).
function saleRate(orders, photos) {
  const o = Number(orders) || 0, p = Number(photos) || 0;
  if (p <= 0) return '—';
  const pct = (o / p) * 100;
  return pct.toFixed(1) + '%';
}

// Thin progress bar for the ACS gauge; level = ok | warn | bad (set by the server).
function meter(m) {
  const pct = Math.min(100, Math.max(0, Number(m.pct) || 0));
  return `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div class="meter-fill meter-${esc(m.level)}" style="width:${pct}%"></div>
      </div>`;
}

function renderSummary(s) {
  const tiles = [
    { label: 'Venues online', value: `${s.online}/${s.total}`, cls: s.offline ? 'warn' : 'ok',
      sub: s.offline ? `${s.offline} offline` : 'all reporting' },
    { label: 'All events to date', value: money(s.eventRevenue), cls: '',
      sub: `${s.eventOrders} order${s.eventOrders === 1 ? '' : 's'} · ${s.eventVenues} venue${s.eventVenues === 1 ? '' : 's'}` },
    { label: 'Avg per order', value: avgText(s.eventRevenue, s.eventOrders), cls: '',
      sub: `all events · today ${avgText(s.todayRevenue, s.todayOrders)}` },
    { label: "Today's revenue", value: money(s.todayRevenue), cls: '', sub: `${s.todayOrders} order${s.todayOrders === 1 ? '' : 's'}` },
    { label: 'Emails sent today (fleet)', value: num(s.todayEmails), cls: '',
      sub: `${num(s.todayEmailsAcs)} via ACS · reporting venues` },
    { label: 'ACS hourly cap', value: `${num(s.acsHour)} / ${num(s.acsCap)}`, cls: s.acsLevel === 'ok' ? '' : s.acsLevel,
      sub: `${s.acsPct}% · ` + (s.acsSince
        ? 'since ' + new Date(s.acsSince).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' (restart)'
        : 'last 60 min'),
      meter: { pct: s.acsPct, level: s.acsLevel } },
  ];
  $('summary').innerHTML = tiles.map(t => `
    <div class="tile">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value ${t.cls}">${esc(t.value)}</div>
      ${t.meter ? meter(t.meter) : ''}
      <div class="tile-sub">${esc(t.sub)}</div>
    </div>`).join('');
}

// Running total for the venue's current event (all days). Older venue
// versions don't send it yet.
function eventBlock(v) {
  const e = v.eventTotals;
  if (!e) return v.event ? '<div class="event-total muted">Event total: update venue to show</div>' : '';
  const since = e.since ? ' since ' + new Date(e.since + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  return `
      <div class="event-total">
        <span class="event-money">${money(e.revenue)}</span>
        <span class="money-label">this event${esc(since)} · ${e.orders || 0} order${e.orders === 1 ? '' : 's'} · avg ${avgText(e.revenue, e.orders)} · ${saleRate(e.orders, e.photos)} photo→sale</span>
      </div>`;
}

// "What's selling": product mix a venue sends as today.sales / eventTotals.sales
// (EventPhotos build with sales mix). Shape:
//   { orders: { package, cart, packageWithExtras },
//     packages: [{ name, orders, revenue }],        // package price × orders
//     prints:   [{ size, qty, revenue }],           // à la carte print lines
//     digitals: { qty, revenue }, bundles: { qty, revenue },
//     addons:   { qty, revenue } }                  // lines sold below full price
// Every part is optional; nothing renders for builds that don't send it.
const MAX_MIX_ROWS = 4;
function mixList(rows, nameOf) {
  const list = (Array.isArray(rows) ? rows : []).filter(r => r && Number(r.qty ?? r.orders) > 0)
    .sort((a, b) => (Number(b.qty ?? b.orders) || 0) - (Number(a.qty ?? a.orders) || 0));
  const shown = list.slice(0, MAX_MIX_ROWS).map(r => `${esc(nameOf(r))} ×${num(r.qty ?? r.orders)}`);
  if (list.length > MAX_MIX_ROWS) shown.push(`+${list.length - MAX_MIX_ROWS} more`);
  return shown.join(' · ');
}
function salesMix(s) {
  if (!s || typeof s !== 'object') return '';
  const o = s.orders || {};
  const pkg = Number(o.package) || 0, cart = Number(o.cart) || 0, total = pkg + cart;
  const rows = [];
  if (total > 0) {
    const pct = Math.round((pkg / total) * 100);
    rows.push(`<div class="mix-split" title="${pkg} package orders, ${cart} à la carte">
          <div class="mix-bar"><span class="mix-pkg" style="width:${pct}%"></span></div>
          <div class="mix-legend"><span><i class="sw sw-pkg"></i>Packages ${pkg} (${pct}%)</span><span><i class="sw sw-cart"></i>À la carte ${cart} (${100 - pct}%)</span></div>
        </div>`);
  }
  const line = (label, text) => text ? `<div class="mix-row"><span class="mix-k">${label}</span><span class="mix-v">${text}</span></div>` : '';
  rows.push(line('Packages', mixList(s.packages, r => r.name || 'Package')));
  rows.push(line('Prints', mixList(s.prints, r => r.size || 'Print')));
  const qr = (x) => x && Number(x.qty) > 0 ? `×${num(x.qty)} · ${money(x.revenue)}` : '';
  rows.push(line('Digitals', qr(s.digitals)));
  rows.push(line('Bundles', qr(s.bundles)));
  const ext = Number(o.packageWithExtras) || 0;
  const addon = qr(s.addons);
  rows.push(line('Add-ons', addon ? addon + (ext ? ` · on ${ext} package order${ext === 1 ? '' : 's'}` : '') : ''));
  const body = rows.filter(Boolean).join('');
  return body;
}
function salesBlock(v) {
  const today = salesMix(v.today && v.today.sales);
  const ev = salesMix(v.eventTotals && v.eventTotals.sales);
  if (!today && !ev) return '';
  return `
      <div class="mix">
        <div class="mix-title">What's selling today</div>
        ${today || '<div class="mix-row muted">No sales yet today</div>'}
        ${ev ? `<details class="mix-event"><summary>This event</summary>${ev}</details>` : ''}
      </div>`;
}

// Per-machine status row: S (server), P (photographer station), one K per kiosk.
// state: on (green) | off (red) | unknown (grey: older venue build, no data).
const MAX_KIOSK_DOTS = 12;
function dot(letter, state, title) {
  return `<span class="mach mach-${state}" title="${esc(title)}" aria-label="${esc(title)}">${letter}<span class="mach-dot"></span></span>`;
}
function machinesRow(v) {
  const m = v.machines && typeof v.machines === 'object' ? v.machines : null;
  // S = the main box is up: heartbeat fresh (server-computed). Older builds
  // without machines also use their legacy printerOnline flag.
  const sUp = v.serverFresh && (m || v.printerOnline !== false);
  const parts = [dot('S', sUp ? 'on' : 'off', sUp ? 'Server online' : (v.serverFresh ? 'Server: printer offline' : 'Server: no recent heartbeat'))];
  if (!m) {
    parts.push(dot('P', 'unknown', 'Photographer: update venue to show'));
    parts.push(dot('K', 'unknown', 'Kiosks: update venue to show'));
  } else {
    // A stale heartbeat means we don't know the current state of the others.
    const stale = !v.serverFresh;
    parts.push(stale ? dot('P', 'unknown', 'Photographer: no recent heartbeat')
      : dot('P', m.photographerOnline === true ? 'on' : 'off', m.photographerOnline === true ? 'Photographer online' : 'Photographer offline'));
    const recent = Math.max(0, Math.floor(Number(m.kiosksRecent) || 0));
    const online = Math.min(recent, Math.max(0, Math.floor(Number(m.kiosksOnline) || 0)));
    if (stale || recent === 0) {
      parts.push(dot('K', 'unknown', stale ? 'Kiosks: no recent heartbeat' : 'No kiosks online'));
    } else {
      const shown = Math.min(recent, MAX_KIOSK_DOTS);
      for (let i = 0; i < shown; i++) {
        parts.push(i < online ? dot('K', 'on', 'Kiosk online') : dot('K', 'off', 'Kiosk just dropped (seen in the last 5 min)'));
      }
      if (recent > shown) parts.push(`<span class="mach-more">+${recent - shown}</span>`);
    }
  }
  return `<div class="machines" aria-label="Machines">${parts.join('')}</div>`;
}

// Version badge: the newest version any venue reports counts as "latest";
// venues behind it get an amber "update" tag. Compares 1.2.10 > 1.2.9 numerically.
let latestVersion = null;
function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
function versionTag(ver) {
  if (!ver) return '<span class="ver ver-unknown" title="Version not reported">v?</span>';
  if (latestVersion && cmpVersion(ver, latestVersion) < 0) {
    return `<span class="ver ver-old" title="Behind: latest is v${esc(latestVersion)}">v${esc(ver)}</span>`;
  }
  return `<span class="ver ver-ok" title="Latest version">v${esc(ver)}</span>`;
}

const keyOf = (v) => String(v.machineId || v.venue || 'unknown');

function card(v, sale) {
  const t = v.today || {};
  return `
    <div class="card ${v.online ? 'online' : 'offline'}${sale ? ' sale-pulse' : ''}" data-key="${esc(keyOf(v))}">
      ${sale ? `<span class="sale-pop" aria-live="polite">+${sale.orders} sale${sale.orders === 1 ? '' : 's'}${sale.revenue > 0 ? ' · ' + money(sale.revenue) : ''}</span>` : ''}
      <div class="card-head">
        <span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
        <div class="card-title">
          <div class="venue-name">${esc(v.venue || 'Unknown venue')}</div>
          ${v.event ? `<div class="venue-event">${esc(v.event)}</div>` : ''}
        </div>
        <span class="status-pill ${v.online ? 'status-online' : 'status-offline'}">
          <span class="dot"></span>${v.online ? 'Online' : 'Offline'}
        </span>
      </div>

      <div class="card-money">
        <span class="money">${money(t.revenue)}</span>
        <span class="money-label">today</span>
      </div>

      ${eventBlock(v)}

      <div class="metrics">
        <div class="metric"><div class="metric-value">${t.orders || 0}</div><div class="metric-label">Orders</div></div>
        <div class="metric"><div class="metric-value">${avgText(t.revenue, t.orders, true)}</div><div class="metric-label">Avg order</div></div>
        <div class="metric"><div class="metric-value">${t.photos || 0}</div><div class="metric-label">Photos</div></div>
        <div class="metric"><div class="metric-value">${num(t.emails)}</div><div class="metric-label">Emails</div></div>
        <div class="metric metric-wide"><div class="metric-value">${saleRate(t.orders, t.photos)}</div><div class="metric-label">Photo → sale (orders ÷ photos)</div></div>
      </div>

      ${salesBlock(v)}

      <div class="card-foot">
        ${machinesRow(v)}
        <span class="meta">${v.online ? 'updated ' + ago(v.ageSec) : 'last seen ' + ago(v.ageSec)}</span>
        ${versionTag(v.version)}
      </div>
    </div>`;
}

async function tick() {
  try {
    const r = await fetch('/api/fleet', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    renderSummary(data.summary);
    if (data.dashboardVersion) $('app-ver').textContent = 'v' + data.dashboardVersion;
    lastVenues = data.venues;
    latestVersion = data.venues.map(v => v.version).filter(Boolean).reduce((m, x) => (!m || cmpVersion(x, m) > 0 ? x : m), null);
    detectSales(data.venues);
    if (!dragging) renderGrid();
    renderCharts(data.venues);
    $('empty').hidden = data.venues.length > 0;
    const when = new Date(data.generatedAt).toLocaleTimeString();
    $('updated').textContent = 'updated ' + when;
    $('live').style.background = 'var(--green)';
  } catch (e) {
    $('updated').textContent = 'reconnecting…';
    $('live').style.background = 'var(--amber)';
  }
}

// ── Sorting (saved in THIS browser only, so each viewer sorts independently) ──
const SORT_KEY = 'fleet.sort', ORDER_KEY = 'fleet.order';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep in memory */ } },
};
let sortMode = store.get(SORT_KEY, 'name');
let customOrder = store.get(ORDER_KEY, []);
let lastVenues = [];
let dragging = null;

const rev = (v) => Number(v.today && v.today.revenue) || 0;
const byName = (a, b) => String(a.venue || '').localeCompare(String(b.venue || ''), undefined, { sensitivity: 'base' });
function sorted(venues) {
  const list = venues.slice();
  if (sortMode === 'high') return list.sort((a, b) => rev(b) - rev(a) || byName(a, b));
  if (sortMode === 'low')  return list.sort((a, b) => rev(a) - rev(b) || byName(a, b));
  if (sortMode === 'custom') {
    // Venues not placed yet (new ones) go at the end, by name.
    const pos = new Map(customOrder.map((k, i) => [k, i]));
    return list.sort((a, b) => (pos.has(keyOf(a)) ? pos.get(keyOf(a)) : 1e9) - (pos.has(keyOf(b)) ? pos.get(keyOf(b)) : 1e9) || byName(a, b));
  }
  return list.sort(byName);
}

// ── Sale pulse: a card flashes when its order count goes up between polls ──
const PULSE_MS = 6000;
let prevCounts = null;           // key -> { orders, revenue }; null until the first poll
const pulses = new Map();        // key -> { orders, revenue, until }
function detectSales(venues) {
  const now = Date.now();
  const next = new Map();
  for (const v of venues) {
    const t = v.today || {};
    const cur = { orders: Number(t.orders) || 0, revenue: Number(t.revenue) || 0 };
    next.set(keyOf(v), cur);
    const old = prevCounts && prevCounts.get(keyOf(v));
    if (old && cur.orders > old.orders) {   // a drop = new day, not a sale
      saleSound();
      pulses.set(keyOf(v), { orders: cur.orders - old.orders, revenue: Math.round((cur.revenue - old.revenue) * 100) / 100, until: now + PULSE_MS });
    }
  }
  prevCounts = next;
  for (const [k, p] of pulses) if (p.until <= now) pulses.delete(k);
}

function renderGrid() {
  const grid = $('grid');
  // Keep "This event" panels open across refreshes.
  const open = new Set([...grid.querySelectorAll('.card')].filter(c => c.querySelector('.mix-event[open]')).map(c => c.dataset.key));
  grid.innerHTML = sorted(lastVenues).map(v => {
    const p = pulses.get(keyOf(v));
    return card(v, p || null);   // pulses expire (6 s) before the next poll (10 s), so each shows once
  }).join('');
  for (const k of open) {
    const d = grid.querySelector(`.card[data-key="${CSS.escape(k)}"] .mix-event`);
    if (d) d.open = true;
  }
  grid.classList.toggle('custom-sort', sortMode === 'custom');
}

function renderSortBar() {
  for (const b of document.querySelectorAll('#sortbar [data-sort]')) b.setAttribute('aria-pressed', String(b.dataset.sort === sortMode));
  $('sort-hint').hidden = sortMode !== 'custom';
}
document.getElementById('sortbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  if (b.dataset.sort === 'custom' && sortMode !== 'custom' && !customOrder.length) {
    customOrder = [...$('grid').querySelectorAll('.card')].map(c => c.dataset.key);   // start from what's on screen
    store.set(ORDER_KEY, customOrder);
  }
  sortMode = b.dataset.sort;
  store.set(SORT_KEY, sortMode);
  renderSortBar();
  renderGrid();
});

// ── Drag and drop (Custom only). Pointer events, so it works with mouse and touch.
$('grid').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle || sortMode !== 'custom') return;
  const el = handle.closest('.card');
  e.preventDefault();
  dragging = el;
  el.classList.add('dragging');
  handle.setPointerCapture(e.pointerId);
  // Hold near the top/bottom edge to scroll (phone cards are tall).
  let lastY = e.clientY;
  const edge = setInterval(() => {
    if (lastY < 70) window.scrollBy(0, -18);
    else if (lastY > window.innerHeight - 70) window.scrollBy(0, 18);
  }, 16);
  const move = (ev) => {
    lastY = ev.clientY;
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = over && over.closest('#grid .card');
    if (!target || target === el) return;
    const r = target.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2 || (ev.clientX > r.left + r.width / 2 && ev.clientY > r.top);
    target.parentNode.insertBefore(el, after ? target.nextSibling : target);
  };
  const up = () => {
    clearInterval(edge);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    el.classList.remove('dragging');
    customOrder = [...$('grid').querySelectorAll('.card')].map(c => c.dataset.key);
    store.set(ORDER_KEY, customOrder);
    dragging = null;
    renderGrid();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
});

// ── Sale sound (per browser; browsers only allow sound after a click) ──
// Uses the custom sound (sounds/sale-sound.mp3 on the server) if present, else a built-in two-note chime.
const SOUND_KEY = 'fleet.sound';
let soundOn = store.get(SOUND_KEY, false);
let audioCtx = null, customSound = null, lastSoundAt = 0;
function loadCustomSound() {
  fetch('/api/sale-sound').then(r => r.json()).then(j => {
    if (j && j.custom) { customSound = new Audio('/api/sale-sound.mp3'); customSound.preload = 'auto'; }
  }).catch(() => {});
}
function chime() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t0 = audioCtx.currentTime;
  [[1318.5, 0], [1760, 0.12]].forEach(([freq, at]) => {   // E6 then A6: "cha-ching"
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'triangle'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.6);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0 + at); o.stop(t0 + at + 0.65);
  });
}
function playSound() {
  if (customSound) { customSound.currentTime = 0; customSound.play().catch(chime); }
  else chime();
}
// Several venues selling in one poll = one sound, not a pile-up.
function saleSound() {
  if (!soundOn || Date.now() - lastSoundAt < 1500) return;
  lastSoundAt = Date.now();
  try { playSound(); } catch { /* no audio support */ }
}
function renderSoundBtn() {
  const b = $('sound-btn');
  b.setAttribute('aria-pressed', String(soundOn));
  b.textContent = soundOn ? '🔔 Sound on' : '🔕 Sound off';
}
$('sound-btn').addEventListener('click', () => {
  soundOn = !soundOn;
  store.set(SOUND_KEY, soundOn);
  renderSoundBtn();
  if (soundOn) playSound();   // the click unlocks audio and previews the sound
});
// A saved "on" still needs one tap after a reload before the browser plays sound.
document.addEventListener('pointerdown', () => {
  if (soundOn && !audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { once: false, passive: true });

loadCustomSound();
renderSoundBtn();
// ── Compare venues: ranked horizontal bars, one measure per chart ──
// One hue for every bar (one series per chart; colour never encodes rank).
// Values are labelled at the bar end; hover/tap a row for the full detail.
const shortName = (v) => String(v.venue || 'Unknown').split(' - ')[0].trim();
const evAvg = (v) => { const e = v.eventTotals; return e && Number(e.orders) > 0 ? Number(e.revenue) / Number(e.orders) : null; };
const CHARTS = [
  { title: "Today's revenue", val: v => rev(v), fmt: n => money(n).replace(/\.00$/, '') },
  { title: 'Orders today', val: v => Number(v.today && v.today.orders) || 0, fmt: n => num(n) },
  { title: 'Photo → sale today', val: v => { const t = v.today || {}; return Number(t.photos) > 0 ? (Number(t.orders) || 0) / Number(t.photos) * 100 : null; }, fmt: n => n.toFixed(1) + '%' },
  { title: 'This event revenue', val: v => v.eventTotals ? Number(v.eventTotals.revenue) || 0 : null, fmt: n => money(n).replace(/\.00$/, '') },
  { title: 'Avg order, this event', val: evAvg, fmt: n => money(n) },
];
function tipFor(v) {
  const t = v.today || {}, e = v.eventTotals;
  return [
    esc(v.venue || 'Unknown venue') + (v.online ? '' : ' (offline)'),
    `Today: ${money(t.revenue)} · ${num(t.orders)} orders · ${saleRate(t.orders, t.photos)} photo→sale`,
    e ? `This event: ${money(e.revenue)} · ${num(e.orders)} orders · avg ${avgText(e.revenue, e.orders)}` : 'This event: not reported',
  ].join('<br>');
}
function renderCharts(venues) {
  const box = $('charts');
  if (!box || !$('compare').open) return;            // skip the work while collapsed
  box.innerHTML = CHARTS.map(c => {
    const rows = venues.map(v => ({ v, n: c.val(v) }))
      .sort((a, b) => (b.n ?? -1) - (a.n ?? -1) || byName(a.v, b.v));
    const max = Math.max(0, ...rows.map(r => r.n || 0));
    return `
      <figure class="chart">
        <figcaption>${esc(c.title)}</figcaption>
        <ol class="bars">${rows.map(r => `
          <li class="bar-row${r.v.online ? '' : ' bar-off'}" tabindex="0" data-tip="${esc(tipFor(r.v))}">
            <span class="bar-name">${esc(shortName(r.v))}</span>
            <span class="bar-track"><span class="bar" style="width:${max > 0 && r.n > 0 ? Math.max(1.5, (r.n / max) * 100) : 0}%"></span></span>
            <span class="bar-val">${r.n == null ? '—' : esc(c.fmt(r.n))}</span>
          </li>`).join('')}
        </ol>
      </figure>`;
  }).join('');
}
// Remember open/closed per browser; draw as soon as it opens.
$('compare').open = store.get('fleet.compare', window.innerWidth >= 700);   // phones start collapsed
$('compare').addEventListener('toggle', () => {
  store.set('fleet.compare', $('compare').open);
  if ($('compare').open) renderCharts(lastVenues);
});
// Tooltip: hover (mouse), focus (keyboard) or tap (touch).
function showTip(row) {
  const tip = $('chart-tip');
  tip.innerHTML = row.dataset.tip;
  tip.hidden = false;
  const r = row.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + 12)) + window.scrollX + 'px';
  tip.style.top = r.bottom + 6 + window.scrollY + 'px';
}
const hideTip = () => { $('chart-tip').hidden = true; };
$('charts').addEventListener('pointerover', (e) => { const row = e.target.closest('.bar-row'); if (row) showTip(row); });
$('charts').addEventListener('pointerleave', hideTip);
$('charts').addEventListener('focusin', (e) => { const row = e.target.closest('.bar-row'); if (row) showTip(row); });
$('charts').addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.bar-row')) hideTip(); });

renderSortBar();
tick();
setInterval(tick, POLL_MS);
