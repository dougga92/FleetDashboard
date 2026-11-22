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

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

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
  fleet.set(venueKey(p), { ...p, receivedAt: Date.now() });
  trackAcsSends(venueKey(p), p);
  res.json({ ok: true });
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
    .map(v => {
      const ageSec = Math.round((now - v.receivedAt) / 1000);
      return { ...v, ageSec, online: (now - v.receivedAt) < OFFLINE_AFTER_MS,
               serverFresh: (now - v.receivedAt) <= SERVER_FRESH_MS };
    })
    .sort((a, b) => String(a.venue || '').localeCompare(String(b.venue || '')));

  const sum = (f, list = venues) => list.reduce((s, v) => s + (Number(f(v)) || 0), 0);
  // Running event totals come from each venue (eventTotals in the heartbeat).
  // Demo / test-print events are left out of the combined total.
  const isDemo = (v) => /\(DEMO\)/i.test(v.event || '');
  const withEvent = venues.filter(v => v.eventTotals && !isDemo(v));

  // Emails sent today. `emails` = every send (ACS + Microsoft 365); `emailsAcs` =
  // ACS sends only. Both are one per send-API call. Stale (offline) venues and
  // older builds that don't send the fields count as 0: a box that went quiet
  // keeps its last "today", which may be yesterday's by now. Each venue reports
  // its OWN local "today", so across US time zones the sum is an approximation.
  const reporting = venues.filter(v => v.online);
  const todayEmails    = sum(v => countOf(v.today && v.today.emails), reporting);
  const todayEmailsAcs = sum(v => countOf(v.today && v.today.emailsAcs), reporting);

  // ACS hourly gauge: ACS sends across the whole fleet in the last 60 minutes
  // (demo venues included: their test sends use the real quota).
  const acsHour = acsLastHour(now);
  const acsPct = Math.round((acsHour / ACS_HOURLY_EMAIL_CAP) * 1000) / 10;
  // normal < 70% of cap, warn 70–89%, bad >= 90%
  const acsLevel = acsPct >= 90 ? 'bad' : acsPct >= 70 ? 'warn' : 'ok';
  // Less than an hour since a restart: the window only goes back to the restart.
  const acsSince = now - STARTED_AT < HOUR_MS ? new Date(STARTED_AT).toISOString() : null;
  res.json({
    venues,
    summary: {
      total:        venues.length,
      online:       venues.filter(v => v.online).length,
      offline:      venues.filter(v => !v.online).length,
      todayRevenue: Math.round(sum(v => v.today && v.today.revenue) * 100) / 100,
      todayOrders:  sum(v => v.today && v.today.orders),
      eventRevenue:  Math.round(sum(v => v.eventTotals.revenue, withEvent) * 100) / 100,
      eventOrders:   sum(v => v.eventTotals.orders, withEvent),
      eventVenues:   withEvent.length,
      todayEmails,
      todayEmailsAcs,
      acsHour,
      acsCap:        ACS_HOURLY_EMAIL_CAP,
      acsSince,
      acsPct,
      acsLevel,
    },
    offlineAfterSec: OFFLINE_AFTER_MS / 1000,
    generatedAt: new Date().toISOString(),
  });
});

// ── Static board ─────────────────────────────────────────────────────────────
app.get('/', dashAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
// Optional custom sale sound: drop public/sale-sound.mp3 in to replace the built-in chime.
app.get('/api/sale-sound', dashAuth, (_req, res) => {
  res.json({ custom: fs.existsSync(path.join(__dirname, 'public', 'sale-sound.mp3')) });
});
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, venues: fleet.size }));

app.listen(PORT, () => console.log(`Fotomentum Fleet Dashboard listening on :${PORT}`));
