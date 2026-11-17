// Fotomentum Fleet Dashboard — ingest API + live status board.
//
// Venues POST aggregate heartbeats to /api/heartbeat (see the EventPhotos
// telemetryService). We keep the latest per venue and serve a live board.
//
// Storage is IN-MEMORY on purpose: the board shows *live* status and every venue
// re-reports ~every 45s, so an App Service restart repopulates within a minute.
// To persist history, swap `fleet` for Azure Table Storage (see README).

const express = require('express');
const path = require('path');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '64kb' }));

// ── Config (all via env; sensible dev defaults) ──────────────────────────────
const INGEST_KEY  = process.env.INGEST_KEY || '';                 // shared venue key; '' = accept any (dev only)
const DASH_USER   = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS   = process.env.DASHBOARD_PASSWORD || '';          // '' = board is open (dev only)
const OFFLINE_AFTER_MS = (Number(process.env.OFFLINE_AFTER_SEC) || 150) * 1000; // stale => "offline"
const PORT = process.env.PORT || 3000;

// Latest heartbeat per venue, keyed by machineId (stable per box) then venue name.
const fleet = new Map();
const venueKey = (p) => p.machineId || p.venue || 'unknown';

// ── Ingest: venues POST here ─────────────────────────────────────────────────
app.post('/api/heartbeat', (req, res) => {
  if (INGEST_KEY && req.get('x-venue-key') !== INGEST_KEY) {
    return res.status(401).json({ error: 'invalid venue key' });
  }
  const p = req.body || {};
  if (!p.machineId && !p.venue) return res.status(400).json({ error: 'missing venue identity' });
  fleet.set(venueKey(p), { ...p, receivedAt: Date.now() });
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
      return { ...v, ageSec, online: (now - v.receivedAt) < OFFLINE_AFTER_MS };
    })
    .sort((a, b) => String(a.venue || '').localeCompare(String(b.venue || '')));

  const sum = (f, list = venues) => list.reduce((s, v) => s + (Number(f(v)) || 0), 0);
  // Running event totals come from each venue (eventTotals in the heartbeat).
  // Demo / test-print events are left out of the combined total.
  const isDemo = (v) => /\(DEMO\)/i.test(v.event || '');
  const withEvent = venues.filter(v => v.eventTotals && !isDemo(v));
  res.json({
    venues,
    summary: {
      total:        venues.length,
      online:       venues.filter(v => v.online).length,
      offline:      venues.filter(v => !v.online).length,
      printersDown: venues.filter(v => v.online && v.printerOnline === false).length,
      todayRevenue: Math.round(sum(v => v.today && v.today.revenue) * 100) / 100,
      todayOrders:  sum(v => v.today && v.today.orders),
      eventRevenue:  Math.round(sum(v => v.eventTotals.revenue, withEvent) * 100) / 100,
      eventOrders:   sum(v => v.eventTotals.orders, withEvent),
      eventVenues:   withEvent.length,
    },
    offlineAfterSec: OFFLINE_AFTER_MS / 1000,
    generatedAt: new Date().toISOString(),
  });
});

// ── Static board ─────────────────────────────────────────────────────────────
app.get('/', dashAuth, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, venues: fleet.size }));

app.listen(PORT, () => console.log(`Fotomentum Fleet Dashboard listening on :${PORT}`));
