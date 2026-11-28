// Sales reports, one look for a venue and for the whole fleet. They open in a panel
// from the right:
//   • a venue's report: the "📊 Sales report" button on its card;
//   • the fleet report: "Sales report" in the left rail (every venue added
//     together, minus TOTALS_EXCLUDE venues, as the fleet tiles do; plus a
//     By venue table, where tapping a venue opens its own report with a ← Fleet back button).
// Built from each venue's per-night `days` history (+ the live `today`). Loaded
// after app.js and uses its helpers (normSales, netOf, daysOf, liveDate, money, ...).
//
//   • Scope: All dates | This event (fleet: Current events); tap a night to narrow to it.
//   • Headline: sales (no tax), orders, nights with a sale, upsells.
//   • Sale nights: month calendar, each night shaded by its sales.
//   • By weekday: which nights of the week sell.
//   • What sold: packages vs à la carte, each package, à la carte items, upsells.
//   • Night by night: one row per night, newest first.
const FLEET = '__fleet__';
const rep = { key: null, scope: 'all', day: null, from: null };
const RP = $('vr'), RP_BODY = $('vr-body');

// One venue's nights, oldest first, normalised to
// { date, event, orders, photos, net, tax (null = not reported), mix (normSales shape|null), live }.
// The live date uses the fresher heartbeat `today`.
function venueNights(v) {
  const live = liveDate(v);
  const m = new Map(daysOf(v).map(d => [d.date, d]));
  if (v.today) m.set(live, { ...(m.get(live) || {}), ...v.today, date: live, event: (v.today && v.today.event) || (m.get(live) || {}).event || v.event });
  return [...m.values()].filter(d => d && d.date).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    date: d.date, event: d.event || '', orders: Number(d.orders) || 0, photos: Number(d.photos) || 0,
    net: netOf(d, v), tax: taxOf(d, v), mix: salesOf(d), live: d.date === live, wx: wxOf(v, d.date),
  }));
}

// Add several sales mixes together (null when none is present). Same shape as normSales().
function mergeMix(mixes) {
  const t = { pkgOrders: 0, cartOrders: 0, orders: 0, pkgWithExtras: 0, digitals: 0, bundles: 0, upItems: 0, upAmount: 0, packages: new Map(), prints: new Map() };
  let any = false;
  const add = (map, k, q) => map.set(k, (map.get(k) || 0) + q);
  for (const m of mixes) {
    if (!m) continue;
    any = true;
    for (const k of ['pkgOrders', 'cartOrders', 'orders', 'pkgWithExtras', 'digitals', 'bundles', 'upItems', 'upAmount']) t[k] += m[k];
    for (const r of m.packages) add(t.packages, r.name, r.qty);
    for (const r of m.prints) add(t.prints, r.name, r.qty);
  }
  if (!any) return null;
  const rows = (map) => [...map].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
  return { ...t, packages: rows(t.packages), prints: rows(t.prints) };
}

// Fleet nights: every counted venue's nights added together per date. `by` keeps
// each venue's share (for the tooltips and the By venue table). scope 'event' =
// each venue's nights for its current event only.
function fleetNights(scope) {
  const per = lastVenues.map(v => {
    let n = venueNights(v);
    if (scope === 'event') n = v.event ? n.filter(d => d.event === v.event) : [];
    return { v, nights: n };
  });
  const dates = new Map();
  for (const { v, nights } of per) {
    if (!counts(v)) continue;
    for (const d of nights) {
      const f = dates.get(d.date) || { date: d.date, event: '', orders: 0, photos: 0, net: 0, tax: 0, mixes: [], live: false, by: [] };
      f.orders += d.orders; f.photos += d.photos; f.net += d.net; f.tax += d.tax || 0;
      f.mixes.push(d.mix); f.live = f.live || d.live;
      f.by.push({ name: shortName(v), net: d.net, orders: d.orders, wx: d.wx });
      dates.set(d.date, f);
    }
  }
  const nights = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date)).map(f => ({ ...f, mix: mergeMix(f.mixes) }));
  return { nights, per };
}

const dollars = (n) => money(n).replace(/\.00$/, '');
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;
// Rough weather during open hours: the night's own, or (fleet) any venue's. → { icon, why } | null
function roughOf(d) {
  const list = d.by ? d.by.map(x => x.wx && { ...x.wx, who: x.name }) : [d.wx];
  const bad = list.filter(w => w && w.rough);
  if (!bad.length) return null;
  const w = bad.sort((a, b) => (b.category === 'storm') - (a.category === 'storm') || b.precipIn - a.precipIn)[0];
  const icon = ['storm', 'snow', 'rain'].includes(w.category) ? w.icon : w.loF <= 32 ? '🥶' : w.windMph >= 25 ? '💨' : '🌧️';
  return { icon, why: bad.map(x => (x.who ? x.who + ': ' : '') + x.why).join('; ') };
}
const wxCell = (w) => w ? `<span class="vr-wxc${w.rough ? ' vr-rough' : ''}" title="${esc(wxLine(w, true))}">${esc(wxLine(w))}</span>` : '<span class="muted">—</span>';

function openReport(key, from = null) {
  rep.key = key; rep.scope = 'all'; rep.from = from;
  rep.day = viewDate || null;                 // opened while looking at a past night → start on that night
  closeFlies();
  RP.hidden = false;
  document.body.classList.add('vr-open');
  renderReport();
  RP.querySelector('.vr-panel').scrollTop = 0;
  RP.querySelector('.fly-close').focus({ preventScroll: true });
}
function closeReport() {
  if (RP.hidden) return;
  RP.hidden = true; rep.key = null; rep.from = null;
  document.body.classList.remove('vr-open');
  hideTip();
}

function nightTip(d) {
  const by = d.by ? d.by.filter(x => x.orders > 0).sort((a, b) => b.net - a.net) : [];
  return `<b>${esc(dayName(d.date))}</b>${d.live ? ' · live' : ''}<br>${d.orders ? `${money(d.net)} sales · ${plural(d.orders, 'order')}` : 'Open, no sales'} · ${plural(d.photos, 'photo')}` +
    (d.by ? d.by.slice().sort((a, b) => b.net - a.net).map(x => `<br>${esc(x.name)}: ${x.orders ? `${money(x.net)} · ${plural(x.orders, 'order')}` : 'no sales'}${x.wx ? ' · ' + esc(wxLine(x.wx)) : ''}`).join('')
      : (d.event ? '<br>' + esc(d.event) : '') + (d.wx ? `<br>${esc(wxLine(d.wx, true))}` : ''));
}

function calendar(nights, maxSales) {
  if (!nights.length) return '';
  const byDate = new Map(nights.map(d => [d.date, d]));
  const first = dateObj(nights[0].date), last = dateObj(nights[nights.length - 1].date);
  const months = [];
  for (let y = first.getFullYear(), mo = first.getMonth(); y < last.getFullYear() || (y === last.getFullYear() && mo <= last.getMonth()); mo === 11 ? (y++, mo = 0) : mo++) months.push([y, mo]);
  const level = (s) => s <= 0 ? 0 : Math.max(1, Math.ceil((s / maxSales) * 4));
  return `<div class="vr-cal">${months.map(([y, mo]) => {
    const lead = new Date(y, mo, 1).getDay(), dim = new Date(y, mo + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="vr-c vr-pad"></span>');
    for (let day = 1; day <= dim; day++) {
      const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const d = byDate.get(iso);
      if (!d) { cells.push(`<span class="vr-c vr-none">${day}</span>`); continue; }
      const lv = d.orders > 0 ? level(d.net) : 0;
      const bad = roughOf(d);
      cells.push(`<button type="button" class="vr-c vr-l${lv}${d.orders ? '' : ' vr-zero'}${iso === rep.day ? ' vr-sel' : ''}${d.live ? ' vr-today' : ''}" data-day="${iso}" data-tip="${esc(nightTip(d))}" aria-label="${esc(dayName(iso) + ': ' + (d.orders ? money(d.net) + ', ' + plural(d.orders, 'order') : 'no sales') + (bad ? ', ' + bad.why : ''))}">${day}${bad ? `<span class="vr-wx" aria-hidden="true">${bad.icon}</span>` : ''}</button>`);
    }
    return `<figure class="vr-month"><figcaption>${new Date(y, mo, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</figcaption>
      <div class="vr-wk">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => `<span>${w}</span>`).join('')}</div>
      <div class="vr-days">${cells.join('')}</div></figure>`;
  }).join('')}
  <div class="vr-key"><span>No report</span><i class="vr-c vr-none"></i><span>Open, no sale</span><i class="vr-c vr-zero"></i><span>Less</span><i class="vr-c vr-l1"></i><i class="vr-c vr-l2"></i><i class="vr-c vr-l3"></i><i class="vr-c vr-l4"></i><span>More sales</span><span class="vr-keywx">🌧️ ❄️ ⛈️ 🥶 = rough weather during open hours</span></div>
  </div>`;
}

function weekdays(nights) {
  const w = Array.from({ length: 7 }, () => ({ s: 0, n: 0, open: 0 }));
  for (const d of nights) {
    const i = dateObj(d.date).getDay();
    w[i].open++;
    if (d.orders > 0) { w[i].s += d.net; w[i].n++; }
  }
  const max = Math.max(0, ...w.map(x => x.s));
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `<div class="vr-wd">${[1, 2, 3, 4, 5, 6, 0].map(i => {
    const x = w[i];
    const tip = `<b>${names[i]}</b><br>${x.open ? `${money(x.s)} sales on ${x.n} of ${x.open} ${names[i]}${x.open === 1 ? '' : 's'}${x.n ? `<br>avg ${money(x.s / x.n)} a night` : ''}` : 'Not open'}`;
    return `<div class="vr-wdc" tabindex="0" data-tip="${esc(tip)}"><span class="vr-wdv">${x.s ? dollars(Math.round(x.s)) : '—'}</span><span class="vr-wdt"><span class="vr-wdb" style="height:${max > 0 && x.s > 0 ? Math.max(4, x.s / max * 100) : 0}%"></span></span><span class="vr-wdn">${names[i]}</span></div>`;
  }).join('')}</div>`;
}

function rankList(rows, cls, unit) {
  if (!rows.length) return '<p class="vr-none-txt">None sold</p>';
  const max = Math.max(...rows.map(r => r.qty));
  return `<ol class="bars">${rows.map(r => `<li class="bar-row vr-rank"><span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar-track"><span class="bar ${cls}" style="width:${Math.max(1.5, r.qty / max * 100)}%"></span></span><span class="bar-val">${num(r.qty)}${unit ? ' ' + unit : ''}</span></li>`).join('')}</ol>`;
}

const mixStack = (m) => m && (m.pkgOrders + m.cartOrders)
  ? `<span class="stack" title="${m.pkgOrders} package, ${m.cartOrders} à la carte">${m.pkgOrders ? `<span class="mix-pkg" style="flex-grow:${m.pkgOrders}"></span>` : ''}${m.cartOrders ? `<span class="mix-cart" style="flex-grow:${m.cartOrders}"></span>` : ''}</span><span class="vr-mixn">${m.pkgOrders} / ${m.cartOrders}</span>`
  : '<span class="muted">—</span>';

// Fleet only: one row per venue for the period shown; tap a row for that venue's report.
function byVenue(per, day) {
  const rows = per.map(({ v, nights }) => {
    const f = day ? nights.filter(d => d.date === day) : nights;
    const net = f.reduce((s, d) => s + d.net, 0), orders = f.reduce((s, d) => s + d.orders, 0);
    return { v, net, orders, sold: f.filter(d => d.orders > 0).length, open: f.length, mix: mergeMix(f.map(d => d.mix)), wx: day && f[0] ? f[0].wx : null };
  }).filter(r => r.open).sort((a, b) => (counts(b.v) - counts(a.v)) || b.net - a.net || byName(a.v, b.v));
  if (!rows.length) return '<p class="vr-none-txt">No venue reported this night.</p>';
  const max = Math.max(0, ...rows.filter(r => counts(r.v)).map(r => r.net));
  return `<div class="vr-table-wrap"><table class="vr-table vr-venues">
    <thead><tr><th>Venue</th><th>Sales</th><th>Orders</th><th>Avg</th>${day ? '' : '<th>Nights sold</th>'}<th class="vr-mixh">Packages / à la carte</th><th>Upsells</th>${day ? '<th>Weather (open hours)</th>' : ''}</tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.orders ? '' : 'vr-dim'}" data-venue="${esc(keyOf(r.v))}" tabindex="0" title="Open ${esc(r.v.venue)}'s report">
      <td><span class="vr-vname">${esc(shortName(r.v))}</span>${counts(r.v) ? '' : ' <span class="vr-excl">not in totals</span>'}
        ${counts(r.v) && max > 0 ? `<span class="vr-share"><span style="width:${Math.max(1, r.net / max * 100)}%"></span></span>` : ''}</td>
      <td class="nowrap">${r.orders ? money(r.net) : '—'}</td>
      <td>${num(r.orders)}</td>
      <td class="nowrap">${avgText(r.net, r.orders, true)}</td>
      ${day ? '' : `<td>${r.sold} of ${r.open}</td>`}
      <td><div class="vr-mixc">${mixStack(r.mix)}</div></td>
      <td>${r.mix && r.mix.upAmount ? dollars(r.mix.upAmount) : '—'}</td>${day ? `<td class="vr-wxtd">${wxCell(r.wx)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

// Is every night being saved for next season?
function archiveNote() {
  const a = archiveStatus;
  if (!a || !a.enabled) return ' · <span class="vr-arch vr-arch-off">nights not being saved</span>';
  if (a.lastError) return ` · <span class="vr-arch vr-arch-off" title="${esc(a.lastError)}">saving nights failed: retrying</span>`;
  if (!a.loaded) return ' · <span class="vr-arch">connecting to the archive…</span>';
  return ` · <span class="vr-arch" title="Every venue's nights, sales mix and weather are kept in Azure for future seasons${a.lastWriteAt ? '. Last saved ' + esc(new Date(a.lastWriteAt).toLocaleString()) : ''}">💾 ${num(a.nights)} nights saved</span>`;
}

function weatherNote(v) {
  const h = venueHistory.get(keyOf(v)) || {};
  return h.weatherPlace ? 'loading… (looked up from Open-Meteo for ' + esc(h.weatherPlace) + ')' : 'not available: this venue doesn\'t send its weather location yet (needs EventPhotos 1.3.44+)';
}

function renderReport() {
  if (RP.hidden || !rep.key) return;
  const fleet = rep.key === FLEET;
  const v = fleet ? null : lastVenues.find(x => keyOf(x) === rep.key);
  $('vr-title').textContent = fleet ? 'Fleet sales report' : v ? v.venue : 'Venue';
  if (!fleet && !v) { RP_BODY.innerHTML = '<p class="vr-none-txt">This venue isn\'t reporting right now.</p>'; return; }

  let all, inScope, per = null;
  if (fleet) {
    all = fleetNights('all').nights;
    const f = fleetNights(rep.scope);
    inScope = f.nights; per = f.per;
  } else {
    all = venueNights(v);
    inScope = rep.scope === 'event' && v.event ? all.filter(d => d.event === v.event) : all;
  }
  if (rep.day && !inScope.some(d => d.date === rep.day)) rep.day = null;
  const focus = rep.day ? inScope.filter(d => d.date === rep.day) : inScope;
  const sum = (k) => focus.reduce((s, d) => s + (d[k] || 0), 0);
  const sales = sum('net'), tax = sum('tax'), orders = sum('orders'), photos = sum('photos');
  const soldNights = inScope.filter(d => d.orders > 0);
  const best = soldNights.slice().sort((a, b) => b.net - a.net)[0];
  const mix = mergeMix(focus.map(d => d.mix));
  const scopeName = rep.scope === 'event' ? (fleet ? 'current events' : 'this event') : 'all reported dates';
  const period = rep.day ? dayName(rep.day) : scopeName;
  const maxNight = Math.max(0, ...inScope.map(d => d.net));
  const excluded = lastVenues.filter(x => !counts(x)).map(shortName);
  const taxMissing = fleet ? lastVenues.filter(x => counts(x) && taxOf(x.today, x) === null).map(shortName) : [];
  const noTax = fleet ? taxMissing.length > 0 : taxOf(v.today, v) === null;
  const stat = (label, value, sub) => `<div class="vr-stat"><div class="tile-label">${label}</div><div class="vr-val">${esc(value)}</div><div class="tile-sub">${sub}</div></div>`;
  const totalMixOrders = mix ? mix.pkgOrders + mix.cartOrders : 0;
  const cartRows = mix ? mix.prints.map(r => ({ name: r.name + ' print', qty: r.qty })).concat(mix.digitals ? [{ name: 'Digital', qty: mix.digitals }] : [], mix.bundles ? [{ name: 'Bundle', qty: mix.bundles }] : []).sort((a, b) => b.qty - a.qty) : [];
  const nightsRows = inScope.slice().reverse();
  const meta = fleet
    ? `${plural(lastVenues.filter(counts).length, 'venue')} added together${excluded.length ? ` · excl. ${esc(excluded.join(', '))}` : ''}${all.length ? ` · reports from ${esc(shortDay(all[0].date))}` : ''}${archiveNote()}`
    : `${v.event ? esc(v.event) + ' · ' : ''}${all.length ? `reports from ${esc(shortDay(all[0].date))}` : 'no history yet'}${counts(v) ? '' : ' · <span class="not-total">not in fleet totals</span>'}`;

  RP_BODY.innerHTML = `
    ${rep.from === FLEET && !fleet ? '<button type="button" class="vr-back" data-back>← Fleet sales report</button>' : ''}
    <div class="vr-meta">${meta}</div>
    <div class="vr-bar">
      <div class="hist-controls" role="group" aria-label="Period">
        <button type="button" data-vs="all" aria-pressed="${rep.scope === 'all'}">All dates</button>
        <button type="button" data-vs="event" aria-pressed="${rep.scope === 'event'}"${fleet || v.event ? '' : ' disabled'}>${fleet ? 'Current events' : 'This event'}</button>
      </div>
      ${rep.day ? `<button type="button" class="vr-chip" data-vday="">${esc(dayName(rep.day))} <span aria-hidden="true">×</span><span class="sr">show all nights</span></button>` : '<span class="vr-hint">Tap a night to see just that night</span>'}
    </div>

    <div class="vr-stats">
      ${stat('Sales', money(sales), `no tax · ${money(tax)} tax${noTax ? (fleet ? ` · tax still in: ${esc(taxMissing.join(', '))}` : ' (venue not sending tax yet)') : ''}`)}
      ${stat('Orders', num(orders), `avg ${avgText(sales, orders)} · ${saleRate(orders, photos)} photo→sale`)}
      ${rep.day ? stat('Photos', num(photos), fleet ? plural(focus[0] ? focus[0].by.filter(x => x.orders > 0).length : 0, 'venue') + ' with sales' : esc(focus[0] && focus[0].event || ''))
        : stat('Nights with a sale', `${soldNights.length} of ${inScope.length}`, best ? `best ${esc(shortDay(best.date))} · ${dollars(best.net)}` : 'no sales yet')}
      ${stat('Upsells', mix ? dollars(mix.upAmount) : '—', mix ? `${plural(mix.upItems, 'item')}${mix.pkgWithExtras ? ` · ${num(mix.pkgWithExtras)} pkg orders added extras` : ''}` : 'not reported')}
    </div>

    ${!fleet && rep.day && focus[0] ? `<div class="vr-daywx${focus[0].wx && focus[0].wx.rough ? ' vr-rough' : ''}">${focus[0].wx ? `<b>Weather</b> ${esc(wxLine(focus[0].wx, true))}${focus[0].wx.rough ? ' · <b>rough night</b>' : ''}` : `<b>Weather</b> ${weatherNote(v)}`}</div>` : ''}

    ${fleet ? `<section class="vr-sec">
      <h3>By venue <span class="vr-sub">${esc(period)} · tap a venue for its report</span></h3>
      ${byVenue(per, rep.day)}
    </section>` : ''}

    <section class="vr-sec">
      <h3>Sale nights <span class="vr-sub">${esc(scopeName)}${fleet ? ' · whole fleet' : ''}</span></h3>
      ${inScope.length ? calendar(inScope, maxNight) + `<h4>By night of the week</h4>${weekdays(inScope)}` : '<p class="vr-none-txt">No nights reported yet. Past nights appear once venues send their daily history.</p>'}
    </section>

    <section class="vr-sec">
      <h3>What sold <span class="vr-sub">${esc(period)}</span></h3>
      ${!mix ? `<p class="vr-none-txt">${fleet ? 'No venue has' : 'This venue hasn\'t'} sent its sales mix for these nights.</p>` : !totalMixOrders ? '<p class="vr-none-txt">No sales.</p>' : `
        ${splitBar(mix.pkgOrders, mix.cartOrders)}
        <div class="vr-cols">
          <figure class="chart"><figcaption><i class="sw sw-pkg"></i>Packages <span class="vr-sub">${plural(mix.pkgOrders, 'order')}</span></figcaption>${rankList(mix.packages, 'bar-pkg', 'sold')}</figure>
          <figure class="chart"><figcaption><i class="sw sw-cart"></i>À la carte <span class="vr-sub">${plural(mix.cartOrders, 'order')}</span></figcaption>${rankList(cartRows, 'bar-cart', '')}</figure>
        </div>
        <div class="vr-up"><i class="sw sw-up"></i><b>Upsells</b> ${mix.upItems || mix.upAmount ? `${plural(mix.upItems, 'extra item')} added for ${money(mix.upAmount)}${mix.pkgWithExtras ? `, on ${plural(mix.pkgWithExtras, 'package order')}` : ''}` : 'none'}</div>`}
    </section>

    <section class="vr-sec">
      <h3>Night by night</h3>
      ${nightsRows.length ? `<div class="vr-table-wrap"><table class="vr-table">
        <thead><tr><th>Night</th>${fleet ? '<th>Venues</th>' : ''}<th>Orders</th><th class="vr-mixh">Packages / à la carte</th><th>Sales</th><th>Upsells</th><th>Photos</th>${fleet ? '<th>Rough weather</th>' : '<th>Weather (open hours)</th>'}</tr></thead>
        <tbody>${nightsRows.map(d => `<tr class="${d.orders ? '' : 'vr-dim'}${d.date === rep.day ? ' vr-row-sel' : ''}" data-day="${d.date}" tabindex="0"${fleet ? ` data-tip="${esc(nightTip(d))}"` : ''}>
            <td class="nowrap">${esc(dayName(d.date))}${d.live ? ' <span class="vr-live">live</span>' : ''}</td>
            ${fleet ? `<td>${d.by.filter(x => x.orders > 0).length}</td>` : ''}
            <td>${num(d.orders)}</td>
            <td><div class="vr-mixc">${mixStack(d.mix)}</div></td>
            <td class="nowrap">${d.orders ? money(d.net) : '—'}</td>
            <td>${d.mix && d.mix.upAmount ? dollars(d.mix.upAmount) : '—'}</td>
            <td>${num(d.photos)}</td>
            <td class="vr-wxtd">${fleet ? (roughOf(d) ? `<span class="vr-wxc vr-rough">${esc(roughOf(d).icon + ' ' + roughOf(d).why)}</span>` : '<span class="muted">—</span>') : wxCell(d.wx)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="vr-none-txt">Nothing yet.</p>'}
    </section>`;
}

// Open: card button (one venue) or the rail launcher (fleet)
$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('.vr-btn');
  if (!b) return;
  const card = b.closest('.card');
  if (card) openReport(card.dataset.key);
});
$('fleet-report').addEventListener('click', () => openReport(FLEET));
RP.addEventListener('click', (e) => {
  if (e.target.closest('.fly-close') || e.target === RP) return closeReport();
  if (e.target.closest('[data-back]')) return openReport(FLEET);
  const vr = e.target.closest('[data-venue]');
  if (vr) { const day = rep.day; openReport(vr.dataset.venue, FLEET); if (day) { rep.day = day; renderReport(); } return; }
  const s = e.target.closest('[data-vs]');
  if (s && !s.disabled) { rep.scope = s.dataset.vs; rep.day = null; return renderReport(); }
  const d = e.target.closest('[data-day], [data-vday]');
  if (d) {
    const day = d.dataset.day ?? d.dataset.vday;
    rep.day = day && rep.day !== day ? day : null;   // tap again to clear
    hideTip();
    renderReport();
  }
});
RP.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('tr[data-day], tr[data-venue]')) e.target.click();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReport(); });
RP_BODY.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-tip]'); if (c) showTip(c); });
RP_BODY.addEventListener('pointerleave', hideTip);
RP_BODY.addEventListener('focusin', (e) => { const c = e.target.closest('[data-tip]'); if (c) showTip(c); });
RP_BODY.addEventListener('focusout', hideTip);
RP.querySelector('.vr-panel').addEventListener('scroll', hideTip, { passive: true });
