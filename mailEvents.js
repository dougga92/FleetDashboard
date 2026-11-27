// Email delivery results from Azure Communication Services, pushed by Event Grid.
//
// ACS (eventphotos-com-service) raises Microsoft.Communication.EmailDeliveryReportReceived
// for every recipient of every email the venues send. An Event Grid subscription
// (Event Grid schema, webhook) posts them to POST /api/acs-events, so the board sees
// delivered / failed / bounced / suppressed per recipient without needing access to
// the Log Analytics workspace (which lives in another Azure account).
//
// Auth: if ACS_EVENTS_KEY is set, the webhook URL must carry ?key=<it>. Events must
// also come from a topic containing ACS_RESOURCE_NAME (default eventphotos-com-service).
// State is in memory (last MAX rows, KEEP_MS): a dashboard restart starts it empty.

const MAX = 2000;
const KEEP_MS = 7 * 24 * 3600e3;
const RESOURCE = (process.env.ACS_RESOURCE_NAME || 'eventphotos-com-service').toLowerCase();
const KEY = process.env.ACS_EVENTS_KEY || '';
const COPY_DOMAINS = (process.env.MAIL_COPY_DOMAINS || 'eventphotoprinters.com')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

// messageId|recipient -> latest row
const rows = new Map();
let receivedTotal = 0, lastEventAt = null;

const isCopy = (addr) => { const d = String(addr || '').toLowerCase().split('@')[1] || ''; return COPY_DOMAINS.includes(d); };

function ingest(ev) {
  if (!ev || ev.eventType !== 'Microsoft.Communication.EmailDeliveryReportReceived') return false;
  if (!String(ev.topic || '').toLowerCase().includes(RESOURCE)) return false;
  const d = ev.data || {};
  const recipient = String(d.recipient || '').trim();
  if (!recipient) return false;
  if (d.status === 'Expanded') return true;           // a distribution list fanned out; not a result
  const at = Date.parse(d.deliveryAttemptTimeStamp || ev.eventTime) || Date.now();
  const k = (d.messageId || ev.id) + '|' + recipient.toLowerCase();
  const prev = rows.get(k);
  if (prev && prev.at > at) return true;              // an older, out-of-order update
  const det = d.deliveryStatusDetails || {};
  rows.set(k, {
    at, messageId: d.messageId || null, recipient, sender: d.sender || null,
    status: d.status || 'Unknown', ok: d.status === 'Delivered',
    reason: det.statusMessage || null, server: det.recipientMailServerHostName || null,
    copy: isCopy(recipient),
  });
  receivedTotal++; lastEventAt = Date.now();
  return true;
}

function prune(now = Date.now()) {
  for (const [k, r] of rows) if (now - r.at > KEEP_MS) rows.delete(k);
  if (rows.size > MAX) {
    const old = [...rows.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, rows.size - MAX);
    for (const [k] of old) rows.delete(k);
  }
}

// Express handler for POST /api/acs-events (Event Grid schema: an array of events).
function handler(req, res) {
  if (KEY && req.query.key !== KEY) return res.status(401).json({ error: 'bad key' });
  const events = Array.isArray(req.body) ? req.body : [req.body];
  // Subscription handshake: echo the validation code back.
  const v = events.find(e => e && e.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent');
  if (v && v.data && v.data.validationCode) {
    if (!String(v.topic || '').toLowerCase().includes(RESOURCE)) return res.status(403).json({ error: 'wrong topic' });
    return res.json({ validationResponse: v.data.validationCode });
  }
  let n = 0;
  for (const e of events) if (ingest(e)) n++;
  prune();
  res.json({ ok: true, accepted: n });
}

function snapshot(now = Date.now()) {
  prune(now);
  const list = [...rows.values()].sort((a, b) => b.at - a.at);
  const day = list.filter(r => now - r.at <= 24 * 3600e3);
  const count = (arr, f) => arr.filter(f).length;
  return {
    rows: list.slice(0, 500),
    last24: {
      delivered: count(day, r => r.ok), failed: count(day, r => !r.ok),
      customerDelivered: count(day, r => r.ok && !r.copy), customerFailed: count(day, r => !r.ok && !r.copy),
    },
    total: list.length, receivedTotal, lastEventAt, keyRequired: !!KEY,
  };
}

module.exports = { handler, snapshot, ingest };
