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
    { label: 'ACS daily cap', value: `${num(s.todayEmailsAcs)} / ${num(s.acsCap)}`, cls: s.acsLevel === 'ok' ? '' : s.acsLevel,
      sub: `${s.acsPct}% used today`, meter: { pct: s.acsPct, level: s.acsLevel } },
    { label: 'Printers down', value: s.printersDown, cls: s.printersDown ? 'bad' : 'ok',
      sub: s.printersDown ? 'needs attention' : 'all printing' },
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
        <span class="money-label">this event${esc(since)} · ${e.orders || 0} order${e.orders === 1 ? '' : 's'} · avg ${avgText(e.revenue, e.orders)}</span>
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

function card(v) {
  const t = v.today || {};
  return `
    <div class="card ${v.online ? 'online' : 'offline'}">
      <div class="card-head">
        <div>
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
      </div>

      <div class="card-foot">
        ${machinesRow(v)}
        <span class="meta">${v.online ? 'updated ' + ago(v.ageSec) : 'last seen ' + ago(v.ageSec)}${v.version ? ' · v' + esc(v.version) : ''}</span>
      </div>
    </div>`;
}

async function tick() {
  try {
    const r = await fetch('/api/fleet', { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    renderSummary(data.summary);
    $('grid').innerHTML = data.venues.map(card).join('');
    $('empty').hidden = data.venues.length > 0;
    const when = new Date(data.generatedAt).toLocaleTimeString();
    $('updated').textContent = 'updated ' + when;
    $('live').style.background = 'var(--green)';
  } catch (e) {
    $('updated').textContent = 'reconnecting…';
    $('live').style.background = 'var(--amber)';
  }
}

tick();
setInterval(tick, POLL_MS);
