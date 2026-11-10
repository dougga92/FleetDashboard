// Live fleet board — polls /api/fleet and renders. Vanilla JS, no build step.
const POLL_MS = 10000;

const $ = (id) => document.getElementById(id);
const money = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ago(sec) {
  if (sec == null) return '—';
  if (sec < 60) return sec + 's ago';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm ago';
  return Math.floor(m / 60) + 'h ago';
}

function renderSummary(s) {
  const tiles = [
    { label: 'Venues online', value: `${s.online}/${s.total}`, cls: s.offline ? 'warn' : 'ok',
      sub: s.offline ? `${s.offline} offline` : 'all reporting' },
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

      <div class="metrics">
        <div class="metric"><div class="metric-value">${t.orders || 0}</div><div class="metric-label">Orders</div></div>
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
