// Venue sales report: the "Sales report" button on each card opens a panel from
// the right with everything that venue sold, built from the per-night `days`
// history (+ the live `today`). Loaded after app.js and uses its helpers
// (normSales, netOf, daysOf, liveDate, money, num, esc, showTip, ...).
//
//   • Scope: All dates | This event; tap a night (calendar or list) to narrow to it.
//   • Headline: sales (no tax), orders, avg order, nights with a sale.
//   • Sale nights: month calendar, each night shaded by its sales.
//   • By weekday: which nights of the week sell.
//   • What sold: packages vs à la carte, each package, à la carte items, upsells.
//   • Night by night: one row per night, newest first.
const rep = { key: null, scope: 'all', day: null };
const RP = $('vr'), RP_BODY = $('vr-body');

// Every night this venue reported, oldest first; the live date uses the fresher heartbeat `today`.
function venueNights(v) {
  const live = liveDate(v);
  const m = new Map(daysOf(v).map(d => [d.date, d]));
  if (v.today) m.set(live, { ...(m.get(live) || {}), ...v.today, date: live, event: (v.today && v.today.event) || (m.get(live) || {}).event || v.event });
  return [...m.values()].filter(d => d && d.date).sort((a, b) => a.date.localeCompare(b.date));
}

// Add several nights' sales mixes together (null when none of them carry one).
function sumMix(nights) {
  const t = { pkgOrders: 0, cartOrders: 0, orders: 0, pkgWithExtras: 0, digitals: 0, bundles: 0, upItems: 0, upAmount: 0, packages: new Map(), prints: new Map() };
  let any = false;
  const add = (map, k, q) => map.set(k, (map.get(k) || 0) + q);
  for (const d of nights) {
    const m = salesOf(d);
    if (!m) continue;
    any = true;
    for (const k of ['pkgOrders', 'cartOrders', 'orders', 'pkgWithExtras', 'digitals', 'bundles', 'upItems', 'upAmount']) t[k] += m[k];
    for (const r of m.packages) add(t.packages, r.name, r.qty);
    for (const r of m.prints) add(t.prints, r.name, r.qty);
  }
  if (!any) return null;
  const rows = (map) => [...map].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  return { ...t, packages: rows(t.packages), prints: rows(t.prints) };
}

const dollars = (n) => money(n).replace(/\.00$/, '');
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

function openReport(key) {
  rep.key = key; rep.scope = 'all';
  rep.day = viewDate || null;                 // opened while looking at a past night → start on that night
  closeFlies();
  RP.hidden = false;
  document.body.classList.add('vr-open');
  renderReport();
  RP.querySelector('.fly-close').focus({ preventScroll: true });
}
function closeReport() {
  if (RP.hidden) return;
  RP.hidden = true; rep.key = null;
  document.body.classList.remove('vr-open');
  hideTip();
}

function calendar(nights, maxSales, v) {
  if (!nights.length) return '';
  const byDate = new Map(nights.map(d => [d.date, d]));
  const live = liveDate(v);
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
      const s = netOf(d, v), o = Number(d.orders) || 0, lv = o > 0 ? level(s) : 0;
      const tip = `<b>${esc(dayName(iso))}</b>${iso === live ? ' · live' : ''}<br>${o ? `${money(s)} sales · ${plural(o, 'order')}` : 'Open, no sales'} · ${plural(Number(d.photos) || 0, 'photo')}${d.event ? '<br>' + esc(d.event) : ''}`;
      cells.push(`<button type="button" class="vr-c vr-l${lv}${o ? '' : ' vr-zero'}${iso === rep.day ? ' vr-sel' : ''}${iso === live ? ' vr-today' : ''}" data-day="${iso}" data-tip="${esc(tip)}" aria-label="${esc(dayName(iso) + ': ' + (o ? money(s) + ', ' + plural(o, 'order') : 'no sales'))}">${day}</button>`);
    }
    return `<figure class="vr-month"><figcaption>${new Date(y, mo, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</figcaption>
      <div class="vr-wk">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => `<span>${w}</span>`).join('')}</div>
      <div class="vr-days">${cells.join('')}</div></figure>`;
  }).join('')}
  <div class="vr-key"><span>No report</span><i class="vr-c vr-none"></i><span>Open, no sale</span><i class="vr-c vr-zero"></i><span>Less</span><i class="vr-c vr-l1"></i><i class="vr-c vr-l2"></i><i class="vr-c vr-l3"></i><i class="vr-c vr-l4"></i><span>More sales</span></div>
  </div>`;
}

function weekdays(nights, v) {
  const w = Array.from({ length: 7 }, () => ({ s: 0, n: 0, open: 0 }));
  for (const d of nights) {
    const i = dateObj(d.date).getDay();
    w[i].open++;
    if ((Number(d.orders) || 0) > 0) { w[i].s += netOf(d, v); w[i].n++; }
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
  const max = Math.max(...rows.map(r => r.n));
  return `<ol class="bars">${rows.map(r => `<li class="bar-row vr-rank"><span class="bar-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar-track"><span class="bar ${cls}" style="width:${Math.max(1.5, r.n / max * 100)}%"></span></span><span class="bar-val">${num(r.n)}${unit ? ' ' + unit : ''}</span></li>`).join('')}</ol>`;
}

function renderReport() {
  if (RP.hidden || !rep.key) return;
  const v = lastVenues.find(x => keyOf(x) === rep.key);
  $('vr-title').textContent = v ? v.venue : 'Venue';
  if (!v) { RP_BODY.innerHTML = '<p class="vr-none-txt">This venue isn\'t reporting right now.</p>'; return; }
  const all = venueNights(v);
  const inScope = rep.scope === 'event' && v.event ? all.filter(d => d.event === v.event) : all;
  if (rep.day && !inScope.some(d => d.date === rep.day)) rep.day = null;
  const focus = rep.day ? inScope.filter(d => d.date === rep.day) : inScope;
  const sold = (d) => (Number(d.orders) || 0) > 0;
  const sales = focus.reduce((s, d) => s + netOf(d, v), 0), tax = focus.reduce((s, d) => s + (taxOf(d, v) || 0), 0);
  const orders = focus.reduce((s, d) => s + (Number(d.orders) || 0), 0), photos = focus.reduce((s, d) => s + (Number(d.photos) || 0), 0);
  const soldNights = inScope.filter(sold);
  const best = soldNights.slice().sort((a, b) => netOf(b, v) - netOf(a, v))[0];
  const mix = sumMix(focus);
  const period = rep.day ? dayName(rep.day) : rep.scope === 'event' ? 'this event' : 'all reported dates';
  const noTax = taxOf(v.today, v) === null;
  const maxNight = Math.max(0, ...inScope.map(d => netOf(d, v)));
  const stat = (label, value, sub) => `<div class="vr-stat"><div class="tile-label">${label}</div><div class="vr-val">${esc(value)}</div><div class="tile-sub">${sub}</div></div>`;
  const totalMixOrders = mix ? mix.pkgOrders + mix.cartOrders : 0;
  const cartRows = mix ? mix.prints.map(r => ({ name: r.name + ' print', n: r.n })).concat(mix.digitals ? [{ name: 'Digital', n: mix.digitals }] : [], mix.bundles ? [{ name: 'Bundle', n: mix.bundles }] : []).sort((a, b) => b.n - a.n) : [];
  const nightsRows = inScope.slice().reverse();

  RP_BODY.innerHTML = `
    <div class="vr-meta">${v.event ? esc(v.event) + ' · ' : ''}${all.length ? `reports from ${esc(shortDay(all[0].date))}` : 'no history yet'}${counts(v) ? '' : ' · <span class="not-total">not in fleet totals</span>'}</div>
    <div class="vr-bar">
      <div class="hist-controls" role="group" aria-label="Period">
        <button type="button" data-vs="all" aria-pressed="${rep.scope === 'all'}">All dates</button>
        <button type="button" data-vs="event" aria-pressed="${rep.scope === 'event'}"${v.event ? '' : ' disabled'}>This event</button>
      </div>
      ${rep.day ? `<button type="button" class="vr-chip" data-vday="">${esc(dayName(rep.day))} <span aria-hidden="true">×</span><span class="sr">show all nights</span></button>` : '<span class="vr-hint">Tap a night to see just that night</span>'}
    </div>

    <div class="vr-stats">
      ${stat('Sales', money(sales), `no tax${noTax ? ' (venue not sending tax yet)' : ` · ${money(tax)} tax`}`)}
      ${stat('Orders', num(orders), `avg ${avgText(sales, orders)} · ${saleRate(orders, photos)} photo→sale`)}
      ${rep.day ? stat('Photos', num(photos), esc(focus[0] && focus[0].event || '')) : stat('Nights with a sale', `${soldNights.length} of ${inScope.length}`, best ? `best ${esc(shortDay(best.date))} · ${dollars(netOf(best, v))}` : 'no sales yet')}
      ${stat('Upsells', mix ? dollars(mix.upAmount) : '—', mix ? `${plural(mix.upItems, 'item')}${mix.pkgWithExtras ? ` · ${num(mix.pkgWithExtras)} pkg orders added extras` : ''}` : 'not reported')}
    </div>

    <section class="vr-sec">
      <h3>Sale nights <span class="vr-sub">${esc(rep.scope === 'event' ? 'this event' : 'all reported dates')}</span></h3>
      ${inScope.length ? calendar(inScope, maxNight, v) + `<h4>By night of the week</h4>${weekdays(inScope, v)}` : '<p class="vr-none-txt">No nights reported yet. Past nights appear once the venue sends its daily history.</p>'}
    </section>

    <section class="vr-sec">
      <h3>What sold <span class="vr-sub">${esc(period)}</span></h3>
      ${!mix ? '<p class="vr-none-txt">This venue hasn\'t sent its sales mix for these nights.</p>' : !totalMixOrders ? '<p class="vr-none-txt">No sales.</p>' : `
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
        <thead><tr><th>Night</th><th>Orders</th><th class="vr-mixh">Packages / à la carte</th><th>Sales</th><th>Upsells</th><th>Photos</th></tr></thead>
        <tbody>${nightsRows.map(d => {
          const m = salesOf(d), o = Number(d.orders) || 0;
          return `<tr class="${o ? '' : 'vr-dim'}${d.date === rep.day ? ' vr-row-sel' : ''}" data-day="${d.date}" tabindex="0">
            <td class="nowrap">${esc(dayName(d.date))}${d.date === liveDate(v) ? ' <span class="vr-live">live</span>' : ''}</td>
            <td>${num(o)}</td>
            <td><div class="vr-mixc">${m && (m.pkgOrders + m.cartOrders) ? `<span class="stack" title="${m.pkgOrders} package, ${m.cartOrders} à la carte">${m.pkgOrders ? `<span class="mix-pkg" style="flex-grow:${m.pkgOrders}"></span>` : ''}${m.cartOrders ? `<span class="mix-cart" style="flex-grow:${m.cartOrders}"></span>` : ''}</span><span class="vr-mixn">${m.pkgOrders} / ${m.cartOrders}</span>` : '<span class="muted">—</span>'}</div></td>
            <td class="nowrap">${o ? money(netOf(d, v)) : '—'}</td>
            <td>${m && m.upAmount ? dollars(m.upAmount) : '—'}</td>
            <td>${num(d.photos)}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="vr-none-txt">Nothing yet.</p>'}
    </section>`;
}

// Open from the card button
$('grid').addEventListener('click', (e) => {
  const b = e.target.closest('.vr-btn');
  if (!b) return;
  const card = b.closest('.card');
  if (card) openReport(card.dataset.key);
});
RP.addEventListener('click', (e) => {
  if (e.target.closest('.fly-close') || e.target === RP) return closeReport();
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
  if (e.key === 'Enter' && e.target.matches('tr[data-day]')) e.target.click();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReport(); });
RP_BODY.addEventListener('pointerover', (e) => { const c = e.target.closest('[data-tip]'); if (c) showTip(c); });
RP_BODY.addEventListener('pointerleave', hideTip);
RP_BODY.addEventListener('focusin', (e) => { const c = e.target.closest('[data-tip]'); if (c) showTip(c); });
RP_BODY.addEventListener('focusout', hideTip);
RP.querySelector('.vr-panel').addEventListener('scroll', hideTip, { passive: true });
