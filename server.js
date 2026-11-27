// Fotomentum Fleet Dashboard — ingest API + live status board.
//
// Venues POST aggregate heartbeats to /api/heartbeat (see the EventPhotos
// telemetryService). We keep the latest per venue and serve a live board.
//
// Storage is IN-MEMORY on purpose: the board shows *live* status and every venue
// re-reports ~every 45s, so an App Service restart repopulates within a minute.
// To persist history, swap `fleet` for Azure Table Storage (see README).

const express = require('express');
const fs = require('fs');
const path = require('path');
const APP_VERSION = require('./package.json').version;
const notifier = require('./notifier');   // texts on-call for critical alerts + dark venues
const updater = require('./updater');           // remote "update now" over the heartbeat reply
const mailEvents = require('./mailEvents');     // ACS email delivery results via Event Grid

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '512kb' }));   // room for the per-day history (days[])

// ── Config (all via env; sensible dev defaults) ──────────────────────────────
const INGEST_KEY  = process.env.INGEST_KEY || '';                 // shared venue key; '' = accept any (dev only)
const DASH_USER   = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS   = process.env.DASHBOARD_PASSWORD || '';          // '' = board is open (dev only)
const OFFLINE_AFTER_MS = (Number(process.env.OFFLINE_AFTER_SEC) || 150) * 1000; // stale => "offline"
// The "S" (server) dot on a venue card goes red once its last heartbeat is older
// than this. Measured from when THIS dashboard received the heartbeat, not the
// venue's own sentAt, so a venue PC with a drifting clock can't show a false red.
const SERVER_FRESH_MS = (Number(process.env.SERVER_FRESH_SEC) || 120) * 1000;
const PORT = process.env.PORT || 3000;
// Azure Communication Services email send limit, for the ACS gauge. It is an
// HOURLY limit (default 100 emails/hour). Change it here or with the
// ACS_HOURLY_EMAIL_CAP app setting (no code change needed).
const ACS_HOURLY_EMAIL_CAP = Number(process.env.ACS_HOURLY_EMAIL_CAP) > 0 ? Number(process.env.ACS_HOURLY_EMAIL_CAP) : 100;
// ACS meters a ROLLING hour. ACS_WINDOW_SEC exists only to test the roll-off locally.
const HOUR_MS = (Number(process.env.ACS_WINDOW_SEC) || 3600) * 1000;
const STARTED_AT = Date.now();
// Venues left out of the fleet money totals (their own card still shows their
// sales). Comma-separated, case-insensitive match on the venue name. Default:
// AJ's Waltz Photo, which gives prints/digitals away for toy donations.
const TOTALS_EXCLUDE = (process.env.TOTALS_EXCLUDE ?? 'Waltz Photo').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const inTotals = (v) => !TOTALS_EXCLUDE.some(x => String(v.venue || '').toLowerCase().includes(x));
// Digital-only venues (no printers at all). Their printer / print-agent alerts
// ("No active printers configured", "Print agent never started") are expected, so
// they're dropped at ingest: not shown on the board, never texted. Comma-separated,
// case-insensitive match on the venue name. Default: California.
const DIGITAL_ONLY = (process.env.DIGITAL_ONLY ?? 'California').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PRINT_ALERT_KEYS = new Set(['printers', 'printAgent']);
const isDigitalOnly = (v) => DIGITAL_ONLY.some(x => String(v.venue || '').toLowerCase().includes(x));

// Sales tax. Venue prices INCLUDE tax (Doug), so `revenue` is what customers paid.
// A venue sends its own rate as top-level `taxRate` (percent, e.g. 7 or 8.25) and,
// when it can, the actual tax dollars as `tax` next to each `revenue` (today,
// eventTotals, days[]). Prefer `tax`; else back it out of the rate:
// tax = revenue − revenue ÷ (1 + rate/100). null = this venue doesn't report tax yet.
// Same rule as taxOf() in public/app.js.
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
const round2 = (n) => Math.round(n * 100) / 100;

// Latest heartbeat per venue, keyed by machineId (stable per box) then venue name.
const fleet = new Map();
const venueKey = (p) => p.machineId || p.venue || 'unknown';

// ── ACS sends in the last hour ───────────────────────────────────────────────
// Venues only report a running "today" count (today.emailsAcs), but the ACS
// limit is per hour. So we watch each venue's count rise between heartbeats and
// keep those increments, timestamped, for an hour. A count that goes DOWN means
// the venue's day rolled over, so the new value is all new sends. The first
// heartbeat after a dashboard restart only sets the baseline, so for the first
// hour after a restart the gauge covers just the time since the restart.
// ACS counts a rolling hour, and so does this: each send drops off 60 minutes
// after it was seen, so the number falls as time passes. Approximation: sends
// are stamped when the heartbeat arrives (up to ~45 s after the actual send).
const acsSends = new Map(); // venueKey -> { last, events: [{ t, n }] }
const countOf = (n) => Math.max(0, Math.floor(Number(n) || 0));

function trackAcsSends(key, p) {
  const raw = p.today && p.today.emailsAcs;
  if (raw == null || !Number.isFinite(Number(raw))) return; // older build: nothing to track
  const now = Date.now();
  const cur = countOf(raw);
  const rec = acsSends.get(key) || { last: null, events: [] };
  if (rec.last !== null) {
    const inc = cur >= rec.last ? cur - rec.last : cur;
    if (inc > 0) rec.events.push({ t: now, n: inc });
  }
  rec.last = cur;
  rec.events = rec.events.filter(e => now - e.t < HOUR_MS);
  acsSends.set(key, rec);
}

function acsLastHour(now) {
  let total = 0;
  for (const rec of acsSends.values()) {
    for (const e of rec.events) if (now - e.t < HOUR_MS) total += e.n;
  }
  return total;
}

// ── Ingest: venues POST here ─────────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
  if (INGEST_KEY && req.get('x-venue-key') !== INGEST_KEY) {
    return res.status(401).json({ error: 'invalid venue key' });
  }
  const p = req.body || {};
  if (!p.machineId && !p.venue) return res.status(400).json({ error: 'missing venue identity' });
  const digitalOnly = isDigitalOnly(p);
  const alerts = digitalOnly && Array.isArray(p.alerts) ? p.alerts.filter(a => !(a && PRINT_ALERT_KEYS.has(a.key))) : p.alerts;
  fleet.set(venueKey(p), { ...p, alerts, digitalOnly, receivedAt: Date.now() });
  trackAcsSends(venueKey(p), p);
  const update = updater.onHeartbeat(venueKey(p), p);   // only while an update is pending for this venue
  res.json(update ? { ok: true, update } : { ok: true });
  notifier.check(fleet).catch(e => console.error('[alerts]', e));   // new critical alerts text right away
});

// ── Dashboard auth (HTTP Basic; open if no password set) ─────────────────────
function dashAuth(req, res, next) {
  if (!DASH_PASS) return next();
  const [, b64] = (req.get('authorization') || '').split(' ');
  const [u, pw] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (u === DASH_USER && pw === DASH_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Fotomentum Fleet"').status(401).send('Authentication required.');
}

// ── Fleet snapshot for the board ─────────────────────────────────────────────
app.get('/api/fleet', dashAuth, (_req, res) => {
  const now = Date.now();
  const venues = [...fleet.values()]
    .map(({ days, ...v }) => {           // days[] is served by /api/history, not every 10 s poll
      const ageSec = Math.round((now - v.receivedAt) / 1000);
      // Emails across every date the venue reports (days[]: up to its last 120 days).
      const dd = Array.isArray(days) ? days : [];
      const allEmails = dd.length ? dd.reduce((t, d) => t + countOf(d && d.emails), 0) : null;
      const emailsSince = dd.reduce((m, d) => (d && d.date && (!m || d.date < m) ? d.date : m), null);
      return { ...v, ageSec, inTotals: inTotals(v), allEmails, emailsSince, dayCount: dd.length, online: (now - v.receivedAt) < OFFLINE_AFTER_MS,
               serverFresh: (now - v.receivedAt) <= SERVER_FRESH_MS,
               remoteUpdate: updater.statusFor(venueKey(v), now), canUpdate: updater.eligible(v),
               hours: notifier.venueHours(v, now) };
    })
    .sort((a, b) => String(a.venue || '').localeCompare(String(b.venue || '')));

  const sum = (f, list = venues) => list.reduce((s, v) => s + (Number(f(v)) || 0), 0);
  // Running event totals come from each venue (eventTotals in the heartbeat).
  // Demo / test-print events are left out of the combined total.
  const isDemo = (v) => /\(DEMO\)/i.test(v.event || '');
  const counted = venues.filter(v => v.inTotals);
  const withEvent = counted.filter(v => v.eventTotals && !isDemo(v));

  // Emails sent today. `emails` = every send (ACS + Microsoft 365); `emailsAcs` =
  // ACS sends only. Both are one per send-API call. Stale (offline) venues and
  // older builds that don't send the fields count as 0: a box that went quiet
  // keeps its last "today", which may be yesterday's by now. Each venue reports
  // its OWN local "today", so across US time zones the sum is an approximation.
  const reporting = venues.filter(v => v.online);
  const todayEmails    = sum(v => countOf(v.today && v.today.emails), reporting);
  const todayEmailsAcs = sum(v => countOf(v.today && v.today.emailsAcs), reporting);
  // Emails for each venue's current event (all days, eventTotals.emails), every
  // venue: emails are real sends whatever the money totals leave out.
  const withEventAll = venues.filter(v => v.eventTotals);
  const eventEmails  = sum(v => countOf(v.eventTotals.emails), withEventAll);
  // Every date added together: each venue's days[] sum, but never less than its
  // current-event count (days[] only counts the email_sends log, which venues
  // started keeping after some event emails had already gone out).
  const allEmails = sum(v => Math.max(v.allEmails || 0, countOf(v.eventTotals && v.eventTotals.emails)));
  const allEmailsSince = venues.reduce((m, v) => (v.emailsSince && (!m || v.emailsSince < m) ? v.emailsSince : m), null);

  // ACS hourly gauge: ACS sends across the whole fleet in the last 60 minutes
  // (demo venues included: their test sends use the real quota).
  const acsHour = acsLastHour(now);
  const acsPct = Math.round((acsHour / ACS_HOURLY_EMAIL_CAP) * 1000) / 10;
  // normal < 70% of cap, warn 70–89%, bad >= 90%
  const acsLevel = acsPct >= 90 ? 'bad' : acsPct >= 70 ? 'warn' : 'ok';
  // Less than an hour since a restart: the window only goes back to the restart.
  const acsSince = now - STARTED_AT < HOUR_MS ? new Date(STARTED_AT).toISOString() : null;
  // Fleet tax: venues that don't report tax yet count with tax in (listed in taxMissing).
  const taxSum = (pick, list) => round2(list.reduce((t, v) => t + (taxOf(pick(v), v) || 0), 0));
  const todayTax = taxSum(v => v.today, counted), eventTax = taxSum(v => v.eventTotals, withEvent);
  const todayRevenue = round2(sum(v => v.today && v.today.revenue, counted));
  const eventRevenue = round2(sum(v => v.eventTotals.revenue, withEvent));
  res.json({
    venues,
    summary: {
      total:        venues.length,
      online:       venues.filter(v => v.online).length,
      offline:      venues.filter(v => !v.online).length,
      todayRevenue,                                   // what customers paid (tax included)
      todayTax,
      todayNet:     round2(todayRevenue - todayTax),  // true revenue, before tax
      todayOrders:  sum(v => v.today && v.today.orders, counted),
      excluded:     venues.filter(v => !v.inTotals).map(v => v.venue),
      eventRevenue,
      eventTax,
      eventNet:      round2(eventRevenue - eventTax),
      taxMissing:    counted.filter(v => taxOf(v.today, v) === null).map(v => v.venue),
      eventOrders:   sum(v => v.eventTotals.orders, withEvent),
      eventVenues:   withEvent.length,
      todayEmails,
      todayEmailsAcs,
      eventEmails,
      allEmails,
      allEmailsSince,
      eventEmailVenues: withEventAll.length,
      acsHour,
      acsCap:        ACS_HOURLY_EMAIL_CAP,
      acsSince,
      acsPct,
      acsLevel,
    },
    offlineAfterSec: OFFLINE_AFTER_MS / 1000,
    generatedAt: new Date().toISOString(),
    dashboardVersion: APP_VERSION,
    remoteUpdateMin: updater.MIN_VERSION,
    notifier: notifier.status(),
  });
});

// ── Past days ────────────────────────────────────────────────────────────────
// Venues send `days`: their own per-day totals (one row per local date with any
// activity, newest first, today included). The board fetches it about once a
// minute for the date picker and the night-by-night charts. Nothing is stored
// here beyond the latest heartbeat: the venue's database is the record, and it
// resends the list every heartbeat, so a restart loses nothing once venues report.
const MAX_DAYS = 120;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Email delivery results pushed by Event Grid from ACS (see mailEvents.js).
app.post('/api/acs-events', express.json({ type: ['application/json', 'application/cloudevents+json'], limit: '1mb' }), mailEvents.handler);
app.get('/api/mail', dashAuth, (_req, res) => res.json(mailEvents.snapshot()));

app.get('/api/history', dashAuth, (_req, res) => {
  const venues = [...fleet.values()].map(v => ({
    key: venueKey(v),
    venue: v.venue,
    todayDate: v.today && DATE_RE.test(v.today.date || '') ? v.today.date : null,
    days: (Array.isArray(v.days) ? v.days : [])
      .filter(d => d && DATE_RE.test(d.date || ''))
      .slice(0, MAX_DAYS),
  }));
  res.json({ venues, generatedAt: new Date().toISOString() });
});

// ── Static board ─────────────────────────────────────────────────────────────
app.get('/', dashAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Sale sounds: sounds/sale-small.mp3 (a sale under BIG_SALE, default $100) and
// sounds/sale-big.mp3 ($100 or more); a missing file falls back to the built-in
// chime. Licensed audio (Epidemic Sound), so gitignored (public repo), deployed
// with the zip, and only served behind the board password.
const SOUNDS = { small: 'sale-small.mp3', big: 'sale-big.mp3' };
const soundPath = (k) => path.join(__dirname, 'sounds', SOUNDS[k]);
const BIG_SALE = Number(process.env.BIG_SALE) > 0 ? Number(process.env.BIG_SALE) : 100;
app.get('/api/sale-sound', dashAuth, (_req, res) => {
  res.json({ small: fs.existsSync(soundPath('small')), big: fs.existsSync(soundPath('big')), bigSale: BIG_SALE });
});
app.get('/api/sale-sound/:kind.mp3', dashAuth, (req, res) => {
  if (!SOUNDS[req.params.kind] || !fs.existsSync(soundPath(req.params.kind))) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600').type('audio/mpeg').sendFile(soundPath(req.params.kind));
});
// RustDesk IDs per venue: private/rustdesk.json (gitignored, public repo;
// deployed in the zip like the sound), only behind the board password.
// [{ match: "<venue name substring>", note?, machines: [{ label, id, note? }] }]
const RUSTDESK_FILE = path.join(__dirname, 'private', 'rustdesk.json');
app.get('/api/rustdesk', dashAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(JSON.parse(fs.readFileSync(RUSTDESK_FILE, 'utf8'))); }
  catch { res.json([]); }
});
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, venues: fleet.size }));

// Dark venues send nothing, so check on a timer too. (On the Free plan the app
// stays awake only while venues keep posting; see README, Alerts.)
setInterval(() => notifier.check(fleet).catch(e => console.error('[alerts]', e)), 30e3).unref();
// Test text to the on-call numbers, from the board's Alerts tile.
app.post('/api/alerts/test', dashAuth, async (_req, res) => {
  if (!notifier.enabled()) return res.status(400).json({ ok: false, error: 'Twilio not set up: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM and ALERT_TO.' });
  await notifier.sendText(['Fotomentum Fleet: test text. Alerts for critical trouble and offline venues will come to this number.']);
  const last = notifier.status().recent[0];
  res.status(last && last.ok ? 200 : 502).json({ ok: !!(last && last.ok), error: last && last.error });
});

// Remote update: the board's version pill → confirm. JSON body only (a cross-site
// form can't send JSON without a preflight, so the board password can't be ridden).
app.post('/api/update/:key', dashAuth, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'JSON only' });
  const v = fleet.get(req.params.key);
  if (!v) return res.status(404).json({ ok: false, error: 'Unknown venue' });
  if (Date.now() - v.receivedAt >= OFFLINE_AFTER_MS) return res.status(409).json({ ok: false, error: 'Venue is offline' });
  if (!updater.eligible(v)) return res.status(409).json({ ok: false, error: `Needs EventPhotos ${updater.MIN_VERSION}+ (Pull-Update it by hand once)` });
  try {
    const cmd = updater.issue(req.params.key, v, req.body && req.body.target);
    console.log(`[update] ${v.venue}: issued ${cmd.id} target ${cmd.target || 'main HEAD'} (from ${cmd.fromVersion} ${cmd.fromCommit || ''})`);
    res.json({ ok: true, update: updater.statusFor(req.params.key) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete('/api/update/:key', dashAuth, (req, res) => {
  if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'JSON only' });
  res.json({ ok: updater.cancel(req.params.key) });
});

app.listen(PORT, () => console.log(`Fotomentum Fleet Dashboard listening on :${PORT}`));
