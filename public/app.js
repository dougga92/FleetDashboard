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

// Sales tax. Venue prices INCLUDE tax, so `revenue` is what customers paid. The
// board shows true revenue = revenue − tax. A venue sends its rate as top-level
// `taxRate` (percent) and, when it can, the tax dollars as `tax` beside each
// `revenue`. Prefer `tax`; else back it out of the rate. null = not reported
// yet (that venue then shows, and counts, with tax in). Same rule as server.js.
function taxOf(rec, v) {
  if (!rec) return null;
  if (rec.tax != null && Number.isFinite(Number(rec.tax))) return Number(rec.tax);
  const rate = Number(v && v.taxRate);
  if (v && v.taxRate != null && Number.isFinite(rate) && rate >= 0) {
    const gross = Number(rec.revenue) || 0;
    return gross - gross / (1 + rate / 100);
  }
  return null;
}
// True revenue (before tax) for a today/event/day record; gross if tax unknown.
const netOf = (rec, v) => { const g = Number(rec && rec.revenue) || 0, t = taxOf(rec, v); return t === null ? g : g - t; };
const rateText = (v) => v.taxRate != null && Number.isFinite(Number(v.taxRate)) ? ` (${Number(v.taxRate)}%)` : '';
// Tax as its own figure ("—" until the venue reports its rate).
const taxMoney = (rec, v) => { const t = taxOf(rec, v); return t === null ? '—' : money(t); };
function taxLine(rec, v) {   // tooltip text
  const t = taxOf(rec, v);
  return t === null ? 'Tax: not reported yet (sales include tax)' : `Sales ${money(netOf(rec, v))} · tax ${money(t)}${rateText(v)}`;
}
const taxMissNote = (names) => names && names.length ? ' · tax still in: ' + names.map(n => String(n).split(' - ')[0]).join(', ') : '';

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

function renderTiles(tiles) {
  $('summary').innerHTML = tiles.map(t => `
    <div class="tile">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value ${t.cls}">${esc(t.value)}</div>
      ${t.meter ? meter(t.meter) : ''}
      <div class="tile-sub">${esc(t.sub)}</div>
      ${t.extra || ''}
    </div>`).join('');
}

const counts = (v) => v.inTotals !== false;     // false = left out of fleet money totals (AJ's Waltz Photo)
const exclNote = (names) => names && names.length ? ' · excl. ' + names.map(n => String(n).split(' - ')[0]).join(', ') : '';
function renderSummary(s) {
  if (viewDate) return renderDaySummary(shownVenues());
  const tiles = [
    { label: 'Venues online', value: `${s.online}/${s.total}`, cls: s.offline ? 'warn' : 'ok',
      sub: s.offline ? `${s.offline} offline` : 'all reporting' },
    alertsTile(),
    { label: 'All events to date', value: money(s.eventNet ?? s.eventRevenue), cls: '',
      sub: `sales, no tax · ${s.eventOrders} order${s.eventOrders === 1 ? '' : 's'} · ${s.eventVenues} venue${s.eventVenues === 1 ? '' : 's'}${exclNote(s.excluded)}${taxMissNote(s.taxMissing)}` },
    { label: 'Avg per order', value: avgText(s.eventNet ?? s.eventRevenue, s.eventOrders), cls: '',
      sub: `all events · today ${avgText(s.todayNet ?? s.todayRevenue, s.todayOrders)}` },
    { label: "Today's sales", value: money(s.todayNet ?? s.todayRevenue), cls: '',
      sub: `no tax · ${s.todayOrders} order${s.todayOrders === 1 ? '' : 's'}${exclNote(s.excluded)}${taxMissNote(s.taxMissing)}` },
    { label: 'Tax today', value: money(s.todayTax), cls: '',
      sub: `all events ${money(s.eventTax)}${exclNote(s.excluded)}` },
    { label: 'Emails sent today (fleet)', value: num(s.todayEmails), cls: '',
      sub: `${num(s.todayEmailsAcs)} via ACS · reporting venues` },
    { label: 'ACS hourly cap', value: `${num(s.acsHour)} / ${num(s.acsCap)}`, cls: s.acsLevel === 'ok' ? '' : s.acsLevel,
      sub: `${s.acsPct}% · ` + (s.acsSince
        ? 'since ' + new Date(s.acsSince).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' (restart)'
        : 'last 60 min'),
      meter: { pct: s.acsPct, level: s.acsLevel } },
  ];
  renderTiles(tiles);
}

// Running total for the venue's current event (all days). Older venue
// versions don't send it yet.
function eventBlock(v) {
  const e = v.eventTotals;
  if (!e) return v.event ? '<div class="event-total muted">Event total: update venue to show</div>' : '';
  const since = e.since ? ' since ' + new Date(e.since + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  return `
      <div class="event-total">
        <span class="nowrap"><span class="event-money">${money(netOf(e, v))}</span> <span class="money-label">sales</span></span>
        <span class="nowrap"><span class="event-money">${taxMoney(e, v)}</span> <span class="money-label">tax</span></span>
        <span class="money-label event-meta">this event${esc(since)} · ${e.orders || 0} order${e.orders === 1 ? '' : 's'} · avg ${avgText(netOf(e, v), e.orders)} · ${saleRate(e.orders, e.photos)} photo→sale</span>
      </div>`;
}

// "What's selling": product mix from today.sales (or the older salesMix) and
// eventTotals.sales. Venues send this shape (EventPhotos 1.3.x):
//   { orders: { total, packages, alaCarte }, packages: [{ name, count }],
//     prints: [{ size, qty }], digitals: <qty>, addOns: { items, amount },
//     packageOrdersWithExtras }
// normSales() also reads the original dashboard spec (orders.package/cart,
// packages[].orders, digitals.qty, addons.qty/revenue). Returns null if absent.
function normSales(s) {
  if (!s || typeof s !== 'object') return null;
  const n = (x) => Math.max(0, Number(x) || 0);
  const o = s.orders || {};
  const merge = (rows, key, cnt) => {
    const m = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r) continue;
      const k = String(r[key] || r.name || '?');
      m.set(k, (m.get(k) || 0) + n(cnt(r)));
    }
    return [...m].map(([name, qty]) => ({ name, qty })).filter(r => r.qty > 0).sort((a, b) => b.qty - a.qty);
  };
  const up = s.addOns || s.addons || {};
  const dg = s.digitals;
  const pkg = n(o.packages ?? o.package), cart = n(o.alaCarte ?? o.cart);
  return {
    pkgOrders: pkg, cartOrders: cart, orders: n(o.total) || pkg + cart,
    pkgWithExtras: n(s.packageOrdersWithExtras ?? o.packageWithExtras),
    packages: merge(s.packages, 'name', r => r.count ?? r.orders),   // the same package can come from several events
    prints: merge(s.prints, 'size', r => r.qty),
    digitals: n(typeof dg === 'object' && dg ? dg.qty : dg),
    bundles: n(s.bundles && typeof s.bundles === 'object' ? s.bundles.qty : s.bundles),
    upItems: n(up.items ?? up.qty), upAmount: n(up.amount ?? up.revenue),
  };
}
const salesOf = (t) => t ? normSales(t.sales || t.salesMix) : null;
const MAX_MIX_ROWS = 4;
function mixList(rows) {
  const shown = rows.slice(0, MAX_MIX_ROWS).map(r => `${esc(r.name)} ×${num(r.qty)}`);
  if (rows.length > MAX_MIX_ROWS) shown.push(`+${rows.length - MAX_MIX_ROWS} more`);
  return shown.join(' · ');
}
// Two-part bar: package orders (blue) vs à la carte orders (orange), 2px gap, labelled.
function splitBar(pkg, cart) {
  const total = pkg + cart;
  if (!total) return '';
  const pct = Math.round((pkg / total) * 100);
  return `<div class="mix-split" title="${pkg} package orders, ${cart} à la carte">
          <div class="mix-bar">${pkg ? `<span class="mix-pkg" style="flex-grow:${pkg}"></span>` : ''}${cart ? `<span class="mix-cart" style="flex-grow:${cart}"></span>` : ''}</div>
          <div class="mix-legend"><span><i class="sw sw-pkg"></i>Packages ${num(pkg)} (${pct}%)</span><span><i class="sw sw-cart"></i>À la carte ${num(cart)} (${100 - pct}%)</span></div>
        </div>`;
}
function upsellText(m) {
  if (!m.upItems && !m.upAmount) return 'none';
  return `${num(m.upItems)} item${m.upItems === 1 ? '' : 's'} · ${money(m.upAmount).replace(/\.00$/, '')}` +
    (m.pkgWithExtras ? ` · on ${num(m.pkgWithExtras)} package order${m.pkgWithExtras === 1 ? '' : 's'}` : '');
}
function cartText(m) {
  const parts = m.prints.map(r => ({ name: r.name, qty: r.qty }));
  if (m.digitals) parts.push({ name: 'Digital', qty: m.digitals });
  if (m.bundles) parts.push({ name: 'Bundle', qty: m.bundles });
  return mixList(parts);
}
function salesMix(raw) {
  const m = normSales(raw);
  if (!m) return '';
  if (!m.orders) return '<div class="mix-row muted">No sales</div>';
  const line = (cls, label, text) => text ? `<div class="mix-row"><span class="mix-k"><i class="sw ${cls}"></i>${label}</span><span class="mix-v">${text}</span></div>` : '';
  return splitBar(m.pkgOrders, m.cartOrders) +
    line('sw-pkg', 'Packages', mixList(m.packages)) +
    line('sw-cart', 'À la carte', cartText(m)) +
    line('sw-up', 'Upsells', upsellText(m));
}
function salesBlock(v) {
  const t = v.today || {}, e = v.eventTotals || {};
  const today = salesMix(t.sales || t.salesMix);
  const ev = salesMix(e.sales || e.salesMix);
  if (!today && !ev) return '';
  return `
      <div class="mix">
        <div class="mix-title">What's selling ${viewDate ? esc(dayName(viewDate)) : 'today'}</div>
        ${today || '<div class="mix-row muted">Not reported</div>'}
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
// Remote update (EventPhotos 1.3.46+): tap the version pill, tap again to confirm.
// The venue pulls GitHub main HEAD, so push first. Target = the newest version any
// venue reports if this one is behind it; otherwise none (done when its commit changes).
let armed = null;                         // { key, act: 'update'|'cancel', until }
const isArmed = (k, act) => armed && armed.key === k && armed.act === act && Date.now() < armed.until;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function versionTag(v) {
  const ver = v.version, k = keyOf(v), u = v.remoteUpdate;
  if (u && u.state === 'pending') {
    const label = isArmed(k, 'cancel') ? 'Cancel update?' : `updating${u.target ? ' → v' + u.target : ''}…`;
    return `<button type="button" class="ver ver-upd" data-upd="${esc(k)}" data-act="cancel"
      title="Update sent ${esc(hhmm(u.issuedAt))}${u.deliveredAt ? ', delivered ' + esc(hhmm(u.deliveredAt)) : ', waiting for next heartbeat'} · from v${esc(u.fromVersion || '?')}${u.fromCommit ? ' (' + esc(u.fromCommit) + ')' : ''} · tap to cancel">${esc(label)}</button>`;
  }
  if (!ver) return '<span class="ver ver-unknown" title="Version not reported">v?</span>';
  const behind = latestVersion && cmpVersion(ver, latestVersion) < 0;
  let note = behind ? `Behind: latest is v${latestVersion}` : 'Latest version';
  if (v.commit) note += ` · commit ${v.commit}`;
  if (u && u.state === 'done') note += ` · updated ${hhmm(u.endedAt)} from v${u.fromVersion || '?'}`;
  if (u && u.state === 'gaveup') note += ` · update sent ${hhmm(u.issuedAt)} made no change (already on main?)`;
  const cls = behind ? 'ver-old' : 'ver-ok';
  const text = `v${ver}${u && u.state === 'gaveup' ? ' · no change' : ''}`;
  if (!v.canUpdate || !v.online) {
    if (!v.canUpdate && remoteUpdateMin) note += ` · remote update needs v${remoteUpdateMin}+ (Pull-Update by hand once)`;
    return `<span class="ver ${cls}" title="${esc(note)}">${esc(text)}</span>`;
  }
  if (isArmed(k, 'update')) {
    return `<span class="ver-wrap"><span class="ver ${cls}">${esc(text)}</span><button type="button" class="ver-btn ver-arm" data-upd="${esc(k)}" data-act="update" title="Pulls GitHub main and restarts the venue for a few minutes">Tap to confirm</button></span>`;
  }
  return `<span class="ver-wrap"><span class="ver ${cls}" title="${esc(note)}">${esc(text)}</span><button type="button" class="ver-btn" data-upd="${esc(k)}" data-act="update" title="Pull GitHub main on this venue (restarts it for a few minutes)">Update</button></span>`;
}
let remoteUpdateMin = null;
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-upd]');
  if (!b) return;
  const k = b.dataset.upd, act = b.dataset.act;
  if (!isArmed(k, act)) {                 // first tap arms it for 6 s
    armed = { key: k, act, until: Date.now() + 6000 };
    renderGrid();
    setTimeout(() => { if (armed && armed.key === k && Date.now() >= armed.until) { armed = null; renderGrid(); } }, 6100);
    return;
  }
  armed = null;
  b.disabled = true; b.textContent = act === 'cancel' ? 'Cancelling…' : 'Sending…';
  const v = lastVenues.find(x => keyOf(x) === k);
  const target = act === 'update' && v && v.version && latestVersion && cmpVersion(v.version, latestVersion) < 0 ? latestVersion : null;
  fetch('/api/update/' + encodeURIComponent(k), {
    method: act === 'cancel' ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(act === 'cancel' ? {} : { target }),
  }).then(r => r.json()).then(j => {
    if (!j.ok) { b.textContent = j.error || 'Failed'; b.title = j.error || ''; setTimeout(tick, 4000); }
    else tick();
  }).catch(() => { b.textContent = 'Failed'; setTimeout(tick, 4000); });
});

const keyOf = (v) => String(v.machineId || v.venue || 'unknown');

// ── Venue trouble (heartbeat `alerts`, EventPhotos 1.3.43+) ──
// A venue's own alerts count only while it is reporting; a dark venue's last
// alerts are stale, and "no heartbeat" is worked out here from its age.
const DARK_SEC = 6 * 60;
const isDark = (v) => (Number(v.ageSec) || 0) > (notifierState ? notifierState.darkAfterMin * 60 : DARK_SEC);
function venueAlerts(v) {
  if (isDark(v)) return [{ key: 'offline', severity: 'critical', message: `No heartbeat in ${Math.max(1, Math.round(v.ageSec / 60))} min (venue offline)`, sinceMs: v.ageSec * 1000 }];
  if (!v.online) return [];
  const sent = Date.parse(v.sentAt);
  return (Array.isArray(v.alerts) ? v.alerts : []).filter(a => a && a.key).map(a => ({
    key: String(a.key), severity: a.severity === 'critical' ? 'critical' : 'warn', message: String(a.message || a.key),
    // venue clock to venue clock (sentAt − since), plus the heartbeat's age
    sinceMs: Number(a.since) > 0 && Number.isFinite(sent) ? Math.max(0, sent - Number(a.since)) + (Number(v.ageSec) || 0) * 1000 : null,
  }));
}
const levelOf = (list) => list.some(a => a.severity === 'critical') ? 'critical' : list.length ? 'warn' : null;
function statusPill(v) {
  const lvl = levelOf(venueAlerts(v));
  if (!v.online && v.remoteUpdate && v.remoteUpdate.state === 'pending') return '<span class="status-pill status-warn"><span class="dot"></span>Updating</span>';
  if (!v.online) return '<span class="status-pill status-offline"><span class="dot"></span>Offline</span>';
  if (lvl === 'critical') return '<span class="status-pill status-offline"><span class="dot"></span>Critical</span>';
  if (lvl === 'warn') return '<span class="status-pill status-warn"><span class="dot"></span>Warning</span>';
  return '<span class="status-pill status-online"><span class="dot"></span>Online</span>';
}
// Open / Closed. Hours come from the venue's own schedule (EventPhotos alert_hours,
// sent as `operating`) or, for older builds, the dashboard default (ALERT_HOURS in the
// venue's time zone). The server works it out (same rule the alert texts use).
const hm = (h) => { h = Number(h); const m = Math.round((h % 1) * 60), H = Math.floor(h) % 24;
  if (!m) return hourText(Math.floor(h)); return `${(H % 12) || 12}:${String(m).padStart(2, '0')} ${H < 12 ? 'am' : 'pm'}`; };
function dayWord(ymd) {
  const d = new Date(ymd + 'T12:00:00'), t = new Date(); t.setHours(12, 0, 0, 0);
  const diff = Math.round((d - t) / 864e5);
  return diff === 1 ? 'tomorrow' : d.toLocaleDateString([], diff < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' });
}
function hoursPill(v) {
  const h = v.hours;
  if (!h) return '';
  const range = (x) => x ? `${hm(x[0])}–${hm(x[1])}` : 'closed';
  let note = '';
  if (h.open && h.today) note = ` · till ${hm(h.today[1])}`;
  else if (!h.open && h.later && h.today) note = ` · opens ${hm(h.today[0])}`;
  else if (!h.open && h.next && validH(h.next.hours)) note = ` · opens ${dayWord(h.next.date)} ${hm(h.next.hours[0])}`;
  const src = h.source === 'venue' ? (h.custom ? 'venue schedule' : 'venue default') : 'dashboard default · venue not sending hours yet';
  const tip = `${h.today !== undefined ? 'Today ' + range(h.today) + ', ' : ''}venue time (${h.tz.replace(/_/g, ' ')}) · ${src}`;
  return `<span class="hours-pill ${h.open ? 'hours-open' : 'hours-closed'}${h.source === 'venue' ? '' : ' hours-default'}" title="${esc(tip)}">${h.open ? 'Open' : 'Closed'}<span class="hours-note">${esc(note)}</span></span>`;
}
const validH = (x) => Array.isArray(x) && x.length === 2;
const forText = (ms) => ms == null ? '' : ' · for ' + agoShort(ms).replace(/ ago$/, '').replace('just now', '<1m');
function alertsBlock(v) {
  const list = venueAlerts(v);
  if (!list.length) return '';
  const open = notifierState && notifierState.open ? notifierState.open.filter(o => o.venueKey === keyOf(v) && o.texted) : [];
  const texted = (k) => { const o = open.find(x => x.key === k); return o && o.notifiedAt ? ' · texted ' + new Date(o.notifiedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; };
  return `<ul class="alerts">${list.sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1)).map(a => `
      <li class="alert alert-${a.severity}"><span class="alert-dot" aria-hidden="true"></span>
        <span><span class="sr-only">${a.severity === 'critical' ? 'Critical' : 'Warning'}: </span>${esc(a.message)}<span class="alert-meta">${esc(forText(a.sinceMs) + texted(a.key))}</span></span></li>`).join('')}
    </ul>`;
}
function alertsTile() {
  const live = lastVenues;
  const crit = live.filter(v => levelOf(venueAlerts(v)) === 'critical').length;
  const warn = live.filter(v => levelOf(venueAlerts(v)) === 'warn').length;
  const n = notifierState;
  const hrs = n && n.hours ? `${hourText(n.hours.start)}–${hourText(n.hours.end)}` : '';
  const sub = !n ? '' : n.texting ? `texts on · ${n.recipients} number${n.recipients === 1 ? '' : 's'} · ${hrs} venue time` : 'texts off · Twilio not set up';
  return {
    label: 'Alerts',
    value: crit ? `${crit} critical` : warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'All clear',
    cls: crit ? 'bad' : warn ? 'warn' : 'ok',
    sub: sub + (crit && warn ? ` · ${warn} warning` : ''),
    extra: n && n.texting ? '<button type="button" class="test-text" id="test-text">Send test text</button>' : '',
  };
}
const hourText = (h) => h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : (h % 12) + (h < 12 ? ' am' : ' pm');
document.addEventListener('click', (e) => {
  const b = e.target.closest('#test-text');
  if (!b) return;
  b.disabled = true; b.textContent = 'Sending…';
  fetch('/api/alerts/test', { method: 'POST' }).then(r => r.json()).then(j => {
    b.textContent = j.ok ? 'Test text sent' : 'Failed: ' + (j.error || 'error');
  }).catch(() => { b.textContent = 'Failed'; }).finally(() => setTimeout(() => { b.disabled = false; b.textContent = 'Send test text'; }, 4000));
});

// Weather at the venue (heartbeat `weather`, EventPhotos 1.3.44+; refreshes about
// hourly). Informational only. Rain, snow and storms get a tinted chip.
const fnum = (n) => n != null && Number.isFinite(Number(n)) ? Math.round(Number(n)) : null;
function weatherChip(v) {
  const w = v.weather;
  if (!w || typeof w !== 'object') return '';
  const t = fnum(w.tempF), hi = fnum(w.hiF), lo = fnum(w.loF), pp = fnum(w.precipPct);
  const main = w.summary ? String(w.summary) : [w.icon, w.label, t != null ? t + '°F' : ''].filter(Boolean).join(' ');
  if (!main) return '';
  const extra = [hi != null && lo != null ? `H${hi}/L${lo}` : '', pp != null && pp > 0 ? `${pp}% rain` : ''].filter(Boolean).join(' · ');
  const cat = ['rain', 'snow', 'storm'].includes(w.category) ? ' wx-' + w.category : '';
  const at = w.at && !Number.isNaN(Date.parse(w.at)) ? ' · updated ' + new Date(w.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return `<div class="wx${cat}" title="${esc((w.place || 'Weather') + at)}">${esc(main)}${extra ? `<span class="wx-extra"> · ${esc(extra)}</span>` : ''}</div>`;
}

function card(v, sale) {
  const t = v.today || {};
  return `
    <div class="card ${v.online ? 'online' : 'offline'}${sale ? ' sale-pulse' : ''}" data-key="${esc(keyOf(v))}">
      ${sale ? `<span class="sale-pop" aria-live="polite">+${sale.orders} sale${sale.orders === 1 ? '' : 's'}${sale.revenue > 0 ? ' · ' + money(sale.revenue) : ''}</span>` : ''}
      <div class="card-head">
        <span class="drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
        <div class="card-title">
          <div class="venue-name">${esc(v.venue || 'Unknown venue')}</div>
          ${v.event || v.digitalOnly ? `<div class="venue-event">${esc(v.event || '')}${v.digitalOnly ? `${v.event ? ' · ' : ''}<span class="digital-tag" title="No printers at this venue: printer alerts are hidden">Digital only</span>` : ''}</div>` : ''}
          ${weatherChip(v)}
        </div>
        <div class="pills">${statusPill(v)}${viewDate ? '' : hoursPill(v)}</div>
      </div>
      ${viewDate ? '' : alertsBlock(v)}

      <div class="card-money">
        <div class="money-pair">
          <span class="money">${money(netOf(t, v))}</span>
          <span class="money-label">sales ${viewDate ? esc(dayName(viewDate)) : 'today'}${taxOf(t, v) === null ? ' · incl. tax' : ''}</span>
        </div>
        <div class="money-pair tax-pair" title="${taxOf(t, v) === null ? 'Needs the venue update that sends its tax rate' : 'Sales tax collected'}">
          <span class="tax-money">${taxMoney(t, v)}</span>
          <span class="money-label">tax${taxOf(t, v) === null ? ' · update venue' : esc(rateText(v))}</span>
        </div>
        ${counts(v) ? '' : '<span class="not-total" title="Toy-donation prints and digitals: left out of the fleet totals">not in fleet totals</span>'}
      </div>

      ${eventBlock(v)}

      <div class="metrics">
        <div class="metric"><div class="metric-value">${t.orders || 0}</div><div class="metric-label">Orders</div></div>
        <div class="metric"><div class="metric-value">${avgText(netOf(t, v), t.orders, true)}</div><div class="metric-label">Avg order</div></div>
        <div class="metric"><div class="metric-value">${t.photos || 0}</div><div class="metric-label">Photos</div></div>
        <div class="metric"><div class="metric-value">${num(t.emails)}</div><div class="metric-label">Emails</div></div>
        <div class="metric metric-wide"><div class="metric-value">${saleRate(t.orders, t.photos)}</div><div class="metric-label">Photo → sale (orders ÷ photos)</div></div>
      </div>

      ${salesBlock(v)}
      <div class="card-tools">
        ${rustdeskBlock(v)}
        ${lastSaleChip(v)}
      </div>

      <div class="card-foot">
        ${machinesRow(v)}
        <span class="meta">${v.online ? 'updated ' + ago(v.ageSec) : 'last seen ' + ago(v.ageSec)}</span>
        ${versionTag(v)}
      </div>
    </div>`;
}

async function tick() {
  try {
    const r = await fetch('/api/fleet', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.dashboardVersion) $('app-ver').textContent = 'v' + data.dashboardVersion;
    remoteUpdateMin = data.remoteUpdateMin || null;
    lastVenues = data.venues;
    lastSummary = data.summary;
    notifierState = data.notifier || null;
    latestVersion = data.venues.map(v => v.version).filter(Boolean).reduce((m, x) => (!m || cmpVersion(x, m) > 0 ? x : m), null);
    detectSales(data.venues);           // sales + sound always follow the live numbers
    if (Date.now() - historyAt > HISTORY_MS || data.venues.some(v => v.dayCount && !venueHistory.has(keyOf(v)))) loadHistory();
    renderView();
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
let notifierState = null;          // server's texting status (GET /api/fleet .notifier)
let dragging = null;

const rev = (v) => netOf(v.today, v);   // before tax
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
  let sold = false, big = false;
  for (const v of venues) {
    const t = v.today || {};
    const cur = { orders: Number(t.orders) || 0, revenue: Number(t.revenue) || 0 };
    next.set(keyOf(v), cur);
    const old = prevCounts && prevCounts.get(keyOf(v));
    if (old && cur.orders > old.orders) {   // a drop = new day, not a sale
      const p = { orders: cur.orders - old.orders, revenue: Math.round((cur.revenue - old.revenue) * 100) / 100, until: now + PULSE_MS };
      pulses.set(keyOf(v), p);
      sold = true;
      if (p.revenue / p.orders >= bigSale) big = true;   // per-order amount, what the customer paid
    }
  }
  if (sold) saleSound(big);
  prevCounts = next;
  for (const [k, p] of pulses) if (p.until <= now) pulses.delete(k);
}

function renderGrid() {
  const grid = $('grid');
  // Keep "This event" panels open across refreshes.
  const open = new Set([...grid.querySelectorAll('.card')].filter(c => c.querySelector('.mix-event[open]')).map(c => c.dataset.key));
  const rdOpen = new Set([...grid.querySelectorAll('.card')].filter(c => c.querySelector('.rd[open]')).map(c => c.dataset.key));
  grid.innerHTML = sorted(shownVenues()).map(v => {
    const p = viewDate ? null : pulses.get(keyOf(v));
    return card(v, p || null);   // pulses expire (6 s) before the next poll (10 s), so each shows once
  }).join('');
  for (const k of open) {
    const d = grid.querySelector(`.card[data-key="${CSS.escape(k)}"] .mix-event`);
    if (d) d.open = true;
  }
  for (const k of rdOpen) {
    const d = grid.querySelector(`.card[data-key="${CSS.escape(k)}"] .rd`);
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
// Two sounds from the server: sale-small.mp3 for a sale under $100 (bigSale)
// and sale-big.mp3 for $100 or more; a missing file falls back to a built-in chime.
const SOUND_KEY = 'fleet.sound';
let soundOn = store.get(SOUND_KEY, false);
let audioCtx = null, lastSoundAt = 0, bigSale = 100;
const sounds = { small: null, big: null };
function loadCustomSound() {
  fetch('/api/sale-sound').then(r => r.json()).then(j => {
    if (!j) return;
    if (Number(j.bigSale) > 0) bigSale = Number(j.bigSale);
    for (const k of ['small', 'big']) if (j[k]) { sounds[k] = new Audio(`/api/sale-sound/${k}.mp3`); sounds[k].preload = 'auto'; }
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
function playSound(big = false) {
  const a = sounds[big ? 'big' : 'small'];
  if (a) { a.currentTime = 0; a.play().catch(chime); }
  else chime();
}
// Several venues selling in one poll = one sound, not a pile-up; the big one
// wins if any of those sales is $100 or more.
function saleSound(big) {
  if (!soundOn || Date.now() - lastSoundAt < 1500) return;
  lastSoundAt = Date.now();
  try { playSound(big); } catch { /* no audio support */ }
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
const evAvg = (v) => { const e = v.eventTotals; return e && Number(e.orders) > 0 ? netOf(e, v) / Number(e.orders) : null; };
const CHARTS = [
  { title: () => (viewDate ? 'Revenue ' + dayName(viewDate) : "Today's revenue") + ' (before tax)', val: v => rev(v), fmt: n => money(n).replace(/\.00$/, '') },
  { title: () => viewDate ? 'Orders ' + dayName(viewDate) : 'Orders today', val: v => Number(v.today && v.today.orders) || 0, fmt: n => num(n) },
  { title: () => 'Photo → sale ' + (viewDate ? dayName(viewDate) : 'today'), val: v => { const t = v.today || {}; return Number(t.photos) > 0 ? (Number(t.orders) || 0) / Number(t.photos) * 100 : null; }, fmt: n => n.toFixed(1) + '%' },
  { title: 'This event revenue (before tax)', val: v => v.eventTotals ? netOf(v.eventTotals, v) : null, fmt: n => money(n).replace(/\.00$/, '') },
  { title: 'Avg order, this event', val: evAvg, fmt: n => money(n) },
];
function tipFor(v) {
  const t = v.today || {}, e = v.eventTotals;
  return [
    esc(v.venue || 'Unknown venue') + (v.online ? '' : ' (offline)') + (counts(v) ? '' : ' · not in fleet totals'),
    `${viewDate ? esc(dayName(viewDate)) : 'Today'}: ${money(netOf(t, v))} · ${num(t.orders)} orders · ${saleRate(t.orders, t.photos)} photo→sale`,
    esc(taxLine(t, v)),
    e ? `This event: ${money(netOf(e, v))} · ${num(e.orders)} orders · avg ${avgText(netOf(e, v), e.orders)}` : 'This event: not reported',
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
        <figcaption>${esc(typeof c.title === 'function' ? c.title() : c.title)}</figcaption>
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
// Chart fly-outs start closed (they cover the cards).
$('compare').addEventListener('toggle', () => {
  if ($('compare').open) renderCharts(shownVenues());
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
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.bar-row, .col')) hideTip(); });

// ── Past days: date picker + night-by-night charts ──
// Venues send `days` (their own per-date totals, venue-local dates, today
// included), fetched from /api/history about once a minute. Picking a past date
// swaps each card's "today" numbers for that date's row; the live date always
// uses the fresher heartbeat `today`. Sales, pulses and sound stay live.
const HISTORY_MS = 60000;
let venueHistory = new Map();         // venue key -> { todayDate, days: [{ date, event, orders, revenue, photos, emails, emailsAcs, sales }] }
let historyAt = 0, historyBusy = false;
let viewDate = null;             // null = live; else 'YYYY-MM-DD' (not saved: every visit starts live)
let lastSummary = null;
let histMeasure = store.get('fleet.histMeasure', 'revenue');

const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateObj = (iso) => new Date(iso + 'T12:00:00');
const dayName = (iso) => dateObj(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const shortDay = (iso) => dateObj(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function loadHistory() {
  if (historyBusy) return;
  historyBusy = true;
  fetch('/api/history', { headers: { Accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(j => { venueHistory = new Map((j.venues || []).map(h => [String(h.key), h])); historyAt = Date.now(); renderView(); })
    .catch(() => { historyAt = Date.now() - HISTORY_MS + 15000; })   // retry in ~15 s
    .finally(() => { historyBusy = false; });
}
const daysOf = (v) => (venueHistory.get(keyOf(v)) || {}).days || [];
// The venue's own "today" (its time zone), so a late-night venue out west stays on its date.
function liveDate(v) {
  const h = venueHistory.get(keyOf(v)) || {};
  return h.todayDate || (v.today && v.today.date) || (daysOf(v)[0] || {}).date || localISO();
}
function recordFor(v, date) {
  if (date === liveDate(v)) return v.today || {};
  return daysOf(v).find(d => d.date === date) || null;
}
function shownVenues() {
  if (!viewDate) return lastVenues;
  return lastVenues.map(v => {
    const r = recordFor(v, viewDate);
    return r ? { ...v, today: r, event: r.event || v.event } : null;
  }).filter(Boolean);
}
const liveDates = () => new Set(lastVenues.map(liveDate));
// Every date any venue has a row for, oldest first.
function allDates() {
  const set = liveDates();
  for (const v of lastVenues) for (const d of daysOf(v)) set.add(d.date);
  return [...set].sort();
}
const pastDates = () => { const live = liveDates(); return allDates().filter(d => !live.has(d)).reverse(); };   // newest first
const hasHistory = () => lastVenues.some(v => daysOf(v).length);

function renderDaySummary(all) {
  const list = all.filter(counts);
  const excluded = all.filter(v => !counts(v)).map(v => v.venue);
  const sumOf = (f) => list.reduce((s, v) => s + (Number(f(v.today || {})) || 0), 0);
  const revenue = Math.round(sumOf(t => t.revenue) * 100) / 100, orders = sumOf(t => t.orders);
  const net = Math.round(list.reduce((s, v) => s + netOf(v.today, v), 0) * 100) / 100;
  const missing = list.filter(v => taxOf(v.today, v) === null).map(v => v.venue);
  const sumAll = (f) => all.reduce((s, v) => s + (Number(f(v.today || {})) || 0), 0);   // emails: every venue uses the real ACS quota
  const photos = sumOf(t => t.photos), emails = sumAll(t => t.emails), acs = sumAll(t => t.emailsAcs);
  const active = all.filter(v => (Number(v.today.orders) || 0) + (Number(v.today.photos) || 0) > 0).length;
  renderTiles([
    { label: dayName(viewDate), value: `${active} venue${active === 1 ? '' : 's'}`, cls: '', sub: 'with photos or sales' },
    { label: 'Sales', value: money(net), cls: '', sub: `no tax · ${num(orders)} order${orders === 1 ? '' : 's'}${exclNote(excluded)}${taxMissNote(missing)}` },
    { label: 'Tax', value: money(revenue - net), cls: '', sub: dayName(viewDate) + exclNote(excluded) },
    { label: 'Avg per order', value: avgText(net, orders), cls: '', sub: dayName(viewDate) },
    { label: 'Photos', value: num(photos), cls: '', sub: `${saleRate(orders, photos)} photo→sale` },
    { label: 'Emails sent', value: num(emails), cls: '', sub: `${num(acs)} via ACS` },
  ]);
}

function renderDaySelect() {
  const sel = $('day-select'), past = pastDates();
  const want = [''].concat(past);
  if (sel.options.length !== want.length || [...sel.options].some((o, i) => o.value !== want[i])) {
    sel.innerHTML = '<option value="">Today (live)</option>' + past.map(d => `<option value="${d}">${esc(dayName(d))}</option>`).join('');
  }
  if (viewDate && !past.includes(viewDate)) sel.insertAdjacentHTML('beforeend', `<option value="${viewDate}">${esc(dayName(viewDate))}</option>`);
  sel.value = viewDate || '';
  const i = want.indexOf(viewDate || '');
  $('day-prev').disabled = i < 0 || i >= want.length - 1;
  $('day-next').disabled = i <= 0;
  sel.disabled = past.length === 0;
  $('day-live').hidden = !viewDate;
  $('day-hint').textContent = !hasHistory() && lastVenues.length ? 'Past dates appear once venues update' : '';
  document.body.classList.toggle('past-view', !!viewDate);
}
function setView(date) {
  viewDate = date || null;
  hideTip();
  renderView();
}
$('day-select').addEventListener('change', (e) => setView(e.target.value));
$('day-live').addEventListener('click', () => setView(null));
$('day-prev').addEventListener('click', () => { const w = [''].concat(pastDates()); setView(w[Math.min(w.length - 1, w.indexOf(viewDate || '') + 1)]); });
$('day-next').addEventListener('click', () => { const w = [''].concat(pastDates()); setView(w[Math.max(0, w.indexOf(viewDate || '') - 1)]); });

// Night by night: one column per date (last 21 dates any venue was active),
// fleet total on top, then one small chart per venue on a shared scale.
// One hue throughout; the selected date gets a ring. Tap a column to open that date.
const HIST_DAYS = 21;
const HIST_MEASURES = {
  revenue: { label: 'Revenue (before tax)', fmt: n => money(n).replace(/\.00$/, '') },
  orders:  { label: 'Orders',  fmt: n => num(n) },
  photos:  { label: 'Photos',  fmt: n => num(n) },
};
function renderHistControls() {
  for (const b of document.querySelectorAll('[data-hm]')) b.setAttribute('aria-pressed', String(b.dataset.hm === histMeasure));
}
document.querySelector('#history .hist-controls').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hm]');
  if (!b) return;
  histMeasure = b.dataset.hm;
  store.set('fleet.histMeasure', histMeasure);
  renderHistControls();
  renderHistory();
});
function columns(dates, valOf, max, tipOf, label) {
  const live = liveDates(), m = HIST_MEASURES[histMeasure];
  return `
    <div class="cols" role="list" aria-label="${esc(label)}">${dates.map(d => {
      const n = valOf(d), sel = viewDate ? d === viewDate : live.has(d);
      return `<button type="button" role="listitem" class="col${sel ? ' col-sel' : ''}" data-date="${d}" data-tip="${esc(tipOf(d, n))}" aria-label="${esc(dayName(d) + ': ' + m.fmt(n))}"><span class="col-bar" style="height:${max > 0 && n > 0 ? Math.max(3, (n / max) * 100) : 0}%"></span></button>`;
    }).join('')}</div>
    <div class="col-axis"><span>${esc(shortDay(dates[0]))}</span><span>${live.has(dates[dates.length - 1]) ? 'Today' : esc(shortDay(dates[dates.length - 1]))}</span></div>`;
}
function renderHistory() {
  const box = $('hist');
  if (!box || !$('history').open) return;
  if (!hasHistory()) {
    box.innerHTML = '<p class="muted hist-empty">Past nights show here once venues send their daily history (needs the venue update).</p>';
    return;
  }
  const m = HIST_MEASURES[histMeasure];
  const dates = allDates().slice(-HIST_DAYS);
  const val = (v, d) => { const r = recordFor(v, d); return !r ? 0 : histMeasure === 'revenue' ? netOf(r, v) : Number(r[histMeasure]) || 0; };
  const fleetVal = (d) => lastVenues.filter(counts).reduce((s, v) => s + val(v, d), 0);
  const excl = lastVenues.filter(v => !counts(v)).map(shortName);
  const fleetMax = Math.max(0, ...dates.map(fleetVal));
  const venues = lastVenues.slice().sort((a, b) => dates.reduce((s, d) => s + val(b, d), 0) - dates.reduce((s, d) => s + val(a, d), 0) || byName(a, b));
  const venueMax = Math.max(0, ...venues.flatMap(v => dates.map(d => val(v, d))));
  const fleetTip = (d, n) => {
    const rows = lastVenues.filter(counts).map(v => [shortName(v), val(v, d)]).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
    return `<b>${esc(dayName(d))}</b> · ${esc(m.fmt(n))}` + rows.map(r => `<br>${esc(r[0])}: ${esc(m.fmt(r[1]))}`).join('');
  };
  const venueTip = (v) => (d, n) => {
    const r = recordFor(v, d) || {};
    return `<b>${esc(shortName(v))} · ${esc(dayName(d))}</b><br>${money(netOf(r, v))} before tax · ${num(r.orders)} orders · ${num(r.photos)} photos` + (r.event ? `<br>${esc(r.event)}` : '');
  };
  const total = (v) => dates.reduce((s, d) => s + val(v, d), 0);
  box.innerHTML = `
    <figure class="chart hist-fleet">
      <figcaption>${esc(m.label)} by night · whole fleet · <span class="muted">last ${dates.length} active date${dates.length === 1 ? '' : 's'}${excl.length ? ' · excl. ' + esc(excl.join(', ')) : ''}</span></figcaption>
      ${columns(dates, fleetVal, fleetMax, fleetTip, m.label + ' by night, whole fleet')}
    </figure>
    <div class="hist-grid">${venues.map(v => `
      <figure class="chart hist-venue">
        <figcaption><span>${esc(shortName(v))}</span><span class="hist-total">${esc(m.fmt(total(v)))}</span></figcaption>
        ${columns(dates, d => val(v, d), venueMax, venueTip(v), m.label + ' by night, ' + shortName(v))}
      </figure>`).join('')}
    </div>`;
}
$('history').addEventListener('toggle', () => renderHistory());
$('hist').addEventListener('click', (e) => {
  const c = e.target.closest('.col');
  if (!c) return;
  setView(liveDates().has(c.dataset.date) ? null : c.dataset.date);
  closeFlies();                        // show that night's cards
});
$('hist').addEventListener('pointerover', (e) => { const c = e.target.closest('.col'); if (c) showTip(c); });
$('hist').addEventListener('pointerleave', hideTip);
$('hist').addEventListener('focusin', (e) => { const c = e.target.closest('.col'); if (c) showTip(c); });
$('hist').addEventListener('focusout', hideTip);

// ── What's selling (fleet): packages vs à la carte, upsells, top items ──
// Fleet totals leave out TOTALS_EXCLUDE venues (inTotals false); the per-venue
// rows show everyone. Packages blue, à la carte orange, upsells aqua (validated).
let sellScope = store.get('fleet.sellScope', 'today');
function renderSellControls() {
  for (const b of document.querySelectorAll('[data-ss]')) b.setAttribute('aria-pressed', String(b.dataset.ss === sellScope));
}
document.querySelector('#selling .hist-controls').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ss]');
  if (!b) return;
  sellScope = b.dataset.ss;
  store.set('fleet.sellScope', sellScope);
  renderSellControls();
  renderSelling();
});
function renderSelling() {
  const box = $('selling-body');
  if (!box || !$('selling').open) return;
  const ev = sellScope === 'event';
  const period = ev ? 'this event' : (viewDate ? dayName(viewDate) : 'today');
  const rows = (ev ? lastVenues : shownVenues()).map(v => ({ v, m: salesOf(ev ? v.eventTotals : v.today) }));
  const have = rows.filter(r => r.m);
  if (!have.length) { box.innerHTML = '<p class="hist-empty">No venue has sent its sales mix yet.</p>'; return; }
  // Fleet totals (counted venues only)
  const fleet = { pkg: 0, cart: 0, upItems: 0, upAmount: 0, pkgWithExtras: 0, packages: new Map(), items: new Map() };
  const add = (map, k, q) => map.set(k, (map.get(k) || 0) + q);
  for (const { v, m } of have) {
    if (!counts(v)) continue;
    fleet.pkg += m.pkgOrders; fleet.cart += m.cartOrders; fleet.upItems += m.upItems; fleet.upAmount += m.upAmount; fleet.pkgWithExtras += m.pkgWithExtras;
    for (const r of m.packages) add(fleet.packages, r.name, r.qty);
    for (const r of m.prints) add(fleet.items, r.name, r.qty);
    if (m.digitals) add(fleet.items, 'Digital', m.digitals);
    if (m.bundles) add(fleet.items, 'Bundle', m.bundles);
  }
  const total = fleet.pkg + fleet.cart;
  const pct = (a) => total ? Math.round(a / total * 100) + '%' : '—';
  const excl = lastVenues.filter(v => !counts(v)).map(shortName);
  const exclNoteTxt = excl.length ? ` · excl. ${excl.join(', ')}` : '';
  const stat = (cls, label, value, sub) => `<div class="sell-stat"><div class="tile-label"><i class="sw ${cls}"></i>${label}</div><div class="sell-val">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`;
  // Per-venue split rows
  const venueRows = have.slice().sort((a, b) => (b.m.pkgOrders + b.m.cartOrders) - (a.m.pkgOrders + a.m.cartOrders) || byName(a.v, b.v));
  const missing = rows.filter(r => !r.m).map(r => shortName(r.v));
  const splitRow = ({ v, m }) => {
    const t = m.pkgOrders + m.cartOrders;
    const p = t ? Math.round(m.pkgOrders / t * 100) : 0;
    const tip = `${esc(v.venue)} · ${esc(period)}<br>Packages: ${num(m.pkgOrders)} orders${m.packages.length ? ' (' + m.packages.map(r => esc(r.name) + ' ×' + num(r.qty)).join(', ') + ')' : ''}<br>À la carte: ${num(m.cartOrders)} orders${cartText(m) ? ' (' + cartText(m) + ')' : ''}<br>Upsells: ${esc(upsellText(m))}${counts(v) ? '' : '<br>Not in fleet totals'}`;
    return `<li class="bar-row" tabindex="0" data-tip="${esc(tip)}">
            <span class="bar-name">${esc(shortName(v))}</span>
            <span class="stack">${t ? `${m.pkgOrders ? `<span class="mix-pkg" style="flex-grow:${m.pkgOrders}"></span>` : ''}${m.cartOrders ? `<span class="mix-cart" style="flex-grow:${m.cartOrders}"></span>` : ''}` : ''}</span>
            <span class="bar-val">${t ? `${p}% pkg` : 'no sales'}</span>
          </li>`;
  };
  const rankBars = (list, cls, fmt, tipOf) => {
    const max = Math.max(0, ...list.map(r => r.n));
    return list.map(r => `<li class="bar-row" tabindex="0" data-tip="${esc(tipOf(r))}">
            <span class="bar-name">${esc(r.name)}</span>
            <span class="bar-track"><span class="bar ${cls}" style="width:${max > 0 && r.n > 0 ? Math.max(1.5, r.n / max * 100) : 0}%"></span></span>
            <span class="bar-val">${esc(fmt(r))}</span>
          </li>`).join('');
  };
  const upRows = have.map(({ v, m }) => ({ name: shortName(v), n: m.upAmount, items: m.upItems, ex: m.pkgWithExtras, v }))
    .sort((a, b) => b.n - a.n || b.items - a.items || a.name.localeCompare(b.name));
  const topPk = [...fleet.packages].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  const topIt = [...fleet.items].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  box.innerHTML = `
    <div class="sell-stats">
      ${stat('sw-pkg', 'Package orders', num(fleet.pkg), `${pct(fleet.pkg)} of ${num(total)} orders`)}
      ${stat('sw-cart', 'À la carte orders', num(fleet.cart), `${pct(fleet.cart)} of orders`)}
      ${stat('sw-up', 'Upsells', money(fleet.upAmount).replace(/\.00$/, ''), `${num(fleet.upItems)} item${fleet.upItems === 1 ? '' : 's'}${fleet.pkgWithExtras ? ` · ${num(fleet.pkgWithExtras)} package orders added extras` : ''}`)}
    </div>
    <p class="sell-note">Fleet totals, ${esc(period)}${esc(exclNoteTxt)}${missing.length ? ` · not reporting: ${esc(missing.join(', '))}` : ''}</p>
    <div class="charts">
      <figure class="chart">
        <figcaption>Packages vs à la carte (orders)</figcaption>
        <div class="mix-legend chart-legend"><span><i class="sw sw-pkg"></i>Packages</span><span><i class="sw sw-cart"></i>À la carte</span></div>
        <ol class="bars">${venueRows.map(splitRow).join('')}</ol>
      </figure>
      <figure class="chart">
        <figcaption>Upsells by venue</figcaption>
        <ol class="bars">${rankBars(upRows, 'bar-up', r => r.n || r.items ? `${money(r.n).replace(/\.00$/, '')} · ${num(r.items)}` : '—',
          r => `${esc(r.v.venue)} · ${esc(period)}<br>Upsells: ${num(r.items)} items · ${money(r.n)}${r.ex ? `<br>${num(r.ex)} package orders added extras` : ''}`)}</ol>
      </figure>
      <figure class="chart">
        <figcaption>Top packages (fleet)</figcaption>
        <ol class="bars">${topPk.length ? rankBars(topPk, 'bar-pkg', r => num(r.n), r => `${esc(r.name)}: ${num(r.n)} sold, ${esc(period)}`) : '<li class="bar-row muted">No packages sold</li>'}</ol>
      </figure>
      <figure class="chart">
        <figcaption>À la carte items (fleet)</figcaption>
        <ol class="bars">${topIt.length ? rankBars(topIt, 'bar-cart', r => num(r.n), r => `${esc(r.name)}: ${num(r.n)} sold à la carte, ${esc(period)}`) : '<li class="bar-row muted">No à la carte items</li>'}</ol>
      </figure>
    </div>`;
}
$('selling').addEventListener('toggle', () => renderSelling());
$('selling-body').addEventListener('pointerover', (e) => { const row = e.target.closest('.bar-row[data-tip]'); if (row) showTip(row); });
$('selling-body').addEventListener('pointerleave', hideTip);
$('selling-body').addEventListener('focusin', (e) => { const row = e.target.closest('.bar-row[data-tip]'); if (row) showTip(row); });
$('selling-body').addEventListener('focusout', hideTip);

function renderView() {
  renderDaySelect();
  if (lastSummary) renderSummary(lastSummary);
  if (!dragging) renderGrid();
  renderCharts(shownVenues());
  renderSelling();
  renderHistory();
  $('empty').hidden = lastVenues.length > 0;
}

// ── RustDesk IDs (from /api/rustdesk, behind the board password) ──
// Each card gets a "RustDesk" note: tap an ID to open it in RustDesk, or copy it.
let rustdesk = [];
fetch('/api/rustdesk').then(r => r.ok ? r.json() : []).then(j => { rustdesk = Array.isArray(j) ? j : []; if (lastVenues.length && !dragging) renderGrid(); }).catch(() => {});
const rdFor = (v) => rustdesk.find(r => r && r.match && String(v.venue || '').toLowerCase().includes(String(r.match).toLowerCase()));
const rdId = (id) => String(id).replace(/\s+/g, '');
const rdShow = (id) => /^\d+$/.test(id) ? id.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : id;   // 461 541 652
// Time since the venue's last sale. lastSaleAt is the venue's UTC time
// ("YYYY-MM-DD HH:MM:SS"). Measured against the venue's own sentAt (same clock,
// so a drifting venue PC can't skew it) plus how old the heartbeat is.
function sinceLastSale(v) {
  if (!v.lastSaleAt) return null;
  const t = Date.parse(String(v.lastSaleAt).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v.lastSaleAt) ? '' : 'Z'));
  const sent = Date.parse(v.sentAt);
  if (!Number.isFinite(t)) return null;
  const ms = Number.isFinite(sent) ? (sent - t) + (Number(v.ageSec) || 0) * 1000 : Date.now() - t;
  return Math.max(0, ms);
}
function agoShort(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}
function lastSaleChip(v) {
  if (viewDate) return '';                          // live only
  const ms = sinceLastSale(v);
  const when = v.lastSaleAt ? new Date(String(v.lastSaleAt).replace(' ', 'T') + 'Z').toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  return `<span class="last-sale" title="${ms === null ? 'No sale reported' : 'Last sale ' + esc(when)}">Last sale <b>${ms === null ? '—' : esc(agoShort(ms))}</b></span>`;
}

function rustdeskBlock(v) {
  const r = rdFor(v);
  if (!r || !Array.isArray(r.machines) || !r.machines.length) return '';
  return `
      <details class="rd">
        <summary>🖥 RustDesk <span class="rd-count">${r.machines.length}</span></summary>
        ${r.note ? `<div class="rd-note">${esc(r.note)}</div>` : ''}
        <ul class="rd-list">${r.machines.map(m => { const id = rdId(m.id); return `
          <li><span class="rd-label">${esc(m.label)}</span>
            <a class="rd-id" href="rustdesk://${encodeURIComponent(id)}" title="Open in RustDesk">${esc(rdShow(id))}</a>
            <button type="button" class="rd-copy" data-copy="${esc(id)}" aria-label="Copy ${esc(m.label)} ID">Copy</button>
            ${m.note ? `<span class="rd-mnote">${esc(m.note)}</span>` : ''}</li>`; }).join('')}
        </ul>
      </details>`;
}
$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('.rd-copy');
  if (!b) return;
  const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done, () => {});
});

// Chart fly-outs: one open at a time; close with ×, the scrim, or Esc.
const flies = [...document.querySelectorAll('details.fly')];
function syncFly() {
  const any = flies.some(d => d.open);
  $('fly-scrim').hidden = !any;
  document.body.classList.toggle('fly-open', any);
}
flies.forEach(d => d.addEventListener('toggle', () => {
  if (d.open) flies.forEach(o => { if (o !== d && o.open) o.open = false; });
  syncFly();
}));
const closeFlies = () => flies.forEach(d => { d.open = false; });
document.addEventListener('click', (e) => { if (e.target.closest('.fly-close') || e.target.id === 'fly-scrim') closeFlies(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && flies.some(d => d.open)) closeFlies(); });

renderSortBar();
renderHistControls();
renderSellControls();
tick();
setInterval(tick, POLL_MS);
