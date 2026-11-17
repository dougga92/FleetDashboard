// Live fleet board — polls /api/fleet and renders. Vanilla JS, no build step.
const POLL_MS = 10000;

const $ = (id) => document.getElementById(id);
// Average per order = revenue / orders. (Venues report every order as
// "unpaid" while revenue still includes it, so unpaid is NOT subtracted.)
// null when there are no orders.
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

function avgText(revenue, orders, whole = false) {
  const a = avgOrder(revenue, orders);
  if (a === null) return '—';
  return whole ? '$' + Math.round(a).toLocaleString() : money(a);
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
    { label: "Today's sessions", value: s.todaySessions, cls: '', sub: 'across the fleet' },
    { label: 'Printers down', value: s.printersDown, cls: s.printersDown ? 'bad' : 'ok',
      sub: s.printersDown ? 'needs attention' : 'all printing' },
  ];
  $('summary').innerHTML = tiles.map(t => `
    <div class="tile">
      <div class="tile-label">${t.label}</div>
      <div class="tile-value ${t.cls}">${esc(t.value)}</div>
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
        <span class="money-label">this event${esc(since)} · ${e.orders || 0} order${e.orders === 1 ? '' : 's'} · avg ${avgText(e.revenue, e.orders)} · ${e.sessions || 0} session${e.sessions === 1 ? '' : 's'}</span>
      </div>`;
}

function card(v) {
  const t = v.today || {};
  const printer = v.printerOnline === false
    ? '<span class="chip chip-bad">🖨 Printer offline</span>'
    : '<span class="chip chip-ok">🖨 Printer OK</span>';
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
        <span class="money-label">today${t.unpaid ? ` · ${t.unpaid} unpaid` : ''}</span>
      </div>

      ${eventBlock(v)}

      <div class="metrics">
        <div class="metric"><div class="metric-value">${t.orders || 0}</div><div class="metric-label">Orders</div></div>
        <div class="metric"><div class="metric-value">${avgText(t.revenue, t.orders, true)}</div><div class="metric-label">Avg order</div></div>
        <div class="metric"><div class="metric-value">${t.sessions || 0}</div><div class="metric-label">Sessions</div></div>
        <div class="metric"><div class="metric-value">${t.photos || 0}</div><div class="metric-label">Photos</div></div>
      </div>

      <div class="card-foot">
        ${printer}
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
