// Per-email delivery log for the board's "Email delivery" fly-out.
//
// Each venue (EventPhotos, Microsoft 365 sending) reports its last 24 hours of emails
// in the heartbeat field `mailLog`:
//   { items: [{ at, orderId, to (MASKED, e.g. a***@me.com), provider,
//               status: sent|pending|retrying|failed|bounced, attempts, reason }] }
// "sent" = Microsoft 365 accepted it and no bounce (NDR) has come back, which nearly
// always means delivered. Nothing is stored here: rows come from the latest heartbeats.

const KEEP_MS = 7 * 24 * 3600e3;
const COPY_DOMAINS = (process.env.MAIL_COPY_DOMAINS || 'eventphotoprinters.com')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const isCopy = (addr) => { const d = String(addr || '').toLowerCase().split('@')[1] || ''; return COPY_DOMAINS.includes(d); };

const STATUS = { sent: 'Sent', pending: 'Pending', retrying: 'Retrying', failed: 'Failed', bounced: 'Bounced' };

function venueRows(venues, now) {
  const out = [];
  for (const v of venues || []) {
    const items = v && v.mailLog && Array.isArray(v.mailLog.items) ? v.mailLog.items : [];
    for (const it of items.slice(0, 300)) {
      if (!it || typeof it !== 'object') continue;
      const at = Date.parse(it.at) || null;
      if (!at || now - at > KEEP_MS) continue;
      const st = String(it.status || '').toLowerCase();
      if (!STATUS[st]) continue;
      const to = String(it.to || '').slice(0, 120);
      out.push({
        at, venue: v.venue || null, orderId: it.orderId ?? null, recipient: to,
        status: STATUS[st], ok: st === 'sent', waiting: st === 'pending' || st === 'retrying',
        reason: it.reason ? String(it.reason).slice(0, 200) : null,
        attempts: Number(it.attempts) || 0, provider: it.provider || null, copy: isCopy(to),
      });
    }
  }
  return out;
}

function snapshot(now = Date.now(), venues = []) {
  const list = venueRows(venues, now).sort((a, b) => b.at - a.at);
  const day = list.filter(r => now - r.at <= 24 * 3600e3);
  const cust = day.filter(r => !r.copy);
  const count = (arr, f) => arr.filter(f).length;
  return {
    rows: list.slice(0, 500),
    last24: {
      delivered: count(day, r => r.ok), failed: count(day, r => !r.ok && !r.waiting), waiting: count(day, r => r.waiting),
      customerDelivered: count(cust, r => r.ok), customerFailed: count(cust, r => !r.ok && !r.waiting), customerWaiting: count(cust, r => r.waiting),
    },
    total: list.length,
    venuesReporting: (venues || []).filter(v => v && v.mailLog && Array.isArray(v.mailLog.items)).length,
  };
}

module.exports = { snapshot };
