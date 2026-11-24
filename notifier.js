// Alert notifier: texts the on-call numbers (Twilio SMS) when a venue
//   a) newly reports a "critical" alert (heartbeat `alerts`, EventPhotos 1.3.43+), or
//   b) goes dark: no heartbeat for DARK_AFTER_MIN minutes (synthetic "offline").
// Never uses `alerts` to detect offline: a dark box sends nothing.
//
// One incident per (venue, alert key). An incident texts once when it starts,
// re-texts at most every REPEAT_MIN while it is still active, and sends an
// all-clear once it has been gone for CLEAR_AFTER_MIN (so a flapping alert is one
// incident, not a stream of texts). Repeats stop after REPEAT_MAX (default 3), so a
// venue closed for the season doesn't text every evening. Everything found in one check goes out as ONE
// text per recipient, each line starting with the venue name.
//
// Texts only go out inside ALERT_HOURS in the VENUE'S local time (venues close at
// night: stations and PCs switch off). Outside the window trouble still shows on
// the board; an incident still active when the window opens is texted then.
// All-clears for incidents that were texted are always sent.
//
// State is in memory. After a dashboard restart, a venue that was already dark is
// unknown until it reports again (the board has no list of venues to expect).

const env = process.env;
const updater = require('./updater');
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

const cfg = {
  sid:   env.TWILIO_ACCOUNT_SID || '',
  token: env.TWILIO_AUTH_TOKEN || '',
  from:  env.TWILIO_FROM || '',
  to:    (env.ALERT_TO || '').split(',').map(s => s.trim()).filter(Boolean),
  textWarn:   /^(1|true|yes)$/i.test(env.ALERT_TEXT_WARN || ''),     // default: warn shows on the board only
  darkMs:     num(env.DARK_AFTER_MIN, 6) * 60e3,
  repeatMs:   num(env.REPEAT_MIN, 60) * 60e3,
  maxRepeats: Number.isFinite(Number(env.REPEAT_MAX)) && env.REPEAT_MAX !== '' ? Number(env.REPEAT_MAX) : 3,   // then quiet until it clears
  clearMs:    num(env.CLEAR_AFTER_MIN, 5) * 60e3,
  hours:      parseHours(env.ALERT_HOURS || '17-22'),                 // local venue hours, start-end (24 = midnight)
  defaultTz:  env.ALERT_DEFAULT_TZ || 'America/New_York',
  // Venue time zones: "match=Zone" pairs, matched on part of the venue name.
  tz: parsePairs(env.VENUE_TZ || 'georgia=America/New_York,alabama=America/Chicago,california=America/Los_Angeles,' +
        'texas=America/Chicago,lexington=America/New_York,west virgin=America/New_York,waltz=America/Indiana/Indianapolis'),
};
const enabled = () => !!(cfg.sid && cfg.token && cfg.from && cfg.to.length);

function parseHours(s) {
  const m = String(s).match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return { start: 17, end: 22 };
  return { start: Math.min(24, +m[1]), end: Math.min(24, +m[2]) };
}
function parsePairs(s) {
  return String(s).split(',').map(x => x.split('=')).filter(x => x.length === 2)
    .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]).filter(([k, v]) => k && v);
}
const tzFor = (venue) => {
  const name = String(venue || '').toLowerCase();
  const hit = cfg.tz.find(([k]) => name.includes(k));
  return hit ? hit[1] : cfg.defaultTz;
};
function localHour(venue, now) {
  try {
    const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tzFor(venue) }).format(now);
    return Number(h) % 24;
  } catch { return new Date(now).getHours(); }
}
// start < end: same day (16-24). start > end: wraps midnight (16-2). start == end: always.
function inWindow(venue, now) {
  const { start, end } = cfg.hours, h = localHour(venue, now);
  if (start === end) return true;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

const mins = (ms) => Math.max(1, Math.round(ms / 60e3));
const venueName = (v) => String(v.venue || v.machineId || 'Unknown venue');

// key -> { venueKey, venue, alertKey, severity, message, since, lastSeen, notifiedAt, texted }
const incidents = new Map();
const sent = [];            // recent outbound texts for the board: { at, lines, ok, error }
let ticking = false;

// Active trouble for one venue right now: its own textable alerts + offline.
function activeFor(v, now, vKey) {
  const out = [];
  const age = now - v.receivedAt;
  if (age > cfg.darkMs) {
    if (vKey && updater.quiet(vKey, now)) return out;   // an update restart: the gap is expected
    out.push({ key: 'offline', severity: 'critical', since: v.receivedAt,
               message: `VENUE OFFLINE — no heartbeat in ${mins(age)} min` });
    return out;                       // its last alerts are stale; offline says it all
  }
  for (const a of Array.isArray(v.alerts) ? v.alerts : []) {
    if (!a || !a.key) continue;
    out.push({ key: String(a.key), severity: a.severity === 'critical' ? 'critical' : 'warn',
               message: String(a.message || a.key), since: Number(a.since) || now });
  }
  return out;
}
const textable = (a) => a.severity === 'critical' || cfg.textWarn;

async function sendText(lines) {
  const body = lines.join('\n').slice(0, 1500);
  const entry = { at: Date.now(), lines, ok: false, error: null };
  sent.unshift(entry); sent.length = Math.min(sent.length, 50);
  if (!enabled()) { entry.error = 'Twilio not set up (texts not sent)'; console.log('[alerts] would text:', body); return; }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`;
  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64');
  const errors = [];
  for (const to of cfg.to) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: cfg.from, To: to, Body: body }) });
      if (!r.ok) errors.push(`${r.status} ${(await r.text()).slice(0, 200)}`);
    } catch (e) { errors.push(e.message); }
  }
  entry.ok = errors.length === 0;
  entry.error = errors.length ? errors.join('; ') : null;
  if (errors.length) console.error('[alerts] Twilio error:', entry.error);
}

// One pass over the fleet. Safe to call often (it is idempotent).
async function check(fleet, now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    const lines = [];
    const seen = new Set();
    for (const [vKey, v] of fleet) {
      const name = venueName(v);
      const open = isOpen(v, now);
      for (const a of activeFor(v, now, vKey)) {
        if (!textable(a)) continue;
        const id = `${vKey}|${a.key}`;
        seen.add(id);
        let inc = incidents.get(id);
        if (!inc) { inc = { venueKey: vKey, venue: name, alertKey: a.key, since: a.since, notifiedAt: 0, texted: false, repeats: 0 }; incidents.set(id, inc); }
        Object.assign(inc, { severity: a.severity, message: a.message, lastSeen: now, venue: name });
        if (!open) continue;
        if (!inc.texted) {
          lines.push(`${name}: ${a.severity === 'critical' ? 'CRITICAL' : 'Warning'} — ${a.message}`);
          inc.texted = true; inc.notifiedAt = now;
        } else if (inc.repeats < cfg.maxRepeats && now - inc.notifiedAt >= cfg.repeatMs) {
          inc.repeats++;
          const last = inc.repeats === cfg.maxRepeats ? ' (last reminder)' : '';
          lines.push(`${name}: still ${a.severity === 'critical' ? 'CRITICAL' : 'warning'} (${mins(now - inc.since)} min)${last} — ${a.message}`);
          inc.notifiedAt = now;
        }
      }
    }
    for (const [id, inc] of incidents) {
      if (seen.has(id)) continue;
      if (now - inc.lastSeen < cfg.clearMs) continue;          // wait out a flap
      if (inc.texted) lines.push(inc.alertKey === 'offline'
        ? `${inc.venue}: back online (was offline ${mins(inc.lastSeen - inc.since)} min)`
        : `${inc.venue}: cleared — ${inc.message}`);
      incidents.delete(id);
    }
    if (lines.length) await sendText(lines);
  } finally { ticking = false; }
}

function status() {
  return {
    texting: enabled(),
    recipients: cfg.to.length,
    textWarn: cfg.textWarn,
    hours: cfg.hours,
    darkAfterMin: cfg.darkMs / 60e3,
    repeatMin: cfg.repeatMs / 60e3,
    maxRepeats: cfg.maxRepeats,
    open: [...incidents.values()].map(i => ({ venueKey: i.venueKey, key: i.alertKey, texted: i.texted, notifiedAt: i.notifiedAt || null })),
    recent: sent.slice(0, 10),
  };
}

// Venue-local date + fractional hour (e.g. 21.5 = 9:30 pm) in the venue's time zone.
function localParts(venue, now) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tzFor(venue), year: 'numeric', month: '2-digit',
      day: '2-digit', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hour: (Number(p.hour) % 24) + Number(p.minute) / 60 };
  } catch { const d = new Date(now); return { date: d.toISOString().slice(0, 10), hour: d.getHours() + d.getMinutes() / 60 }; }
}
const validHours = (h) => Array.isArray(h) && h.length === 2 && Number.isFinite(Number(h[0])) && Number.isFinite(Number(h[1])) && Number(h[1]) > Number(h[0]);

// Is the venue open, and what are its hours? Prefers the venue's own schedule
// (heartbeat `operating`, EventPhotos alert_hours, 1.3.51+):
//   { open, date:"YYYY-MM-DD", today:[open,close]|null, next:{date,hours}|null, custom }
// `today` is checked against the venue's local clock NOW (so a venue that has gone
// dark still opens/closes on time); if its `date` is no longer today we fall back
// to `next` (when it is today) or the last `open` it sent while still fresh.
// No `operating` (older builds): ALERT_HOURS in VENUE_TZ, the old rule.
const FRESH_MS = 10 * 60e3;
function venueHours(v, now = Date.now()) {
  const name = String(v.venue || v.machineId || '');
  const op = v.operating && typeof v.operating === 'object' ? v.operating : null;
  const tz = tzFor(name);
  if (op && typeof op.date === 'string') {
    const { date, hour } = localParts(name, now);
    let today;
    if (op.date === date) today = validHours(op.today) ? op.today.map(Number) : null;
    else if (op.next && op.next.date === date && validHours(op.next.hours)) today = op.next.hours.map(Number);
    else if (now - v.receivedAt <= FRESH_MS && typeof op.open === 'boolean') {
      return { source: 'venue', open: op.open, today: null, next: op.next || null, custom: !!op.custom, tz };
    } else today = undefined;   // stale and unknown: fall through to the default window
    if (today !== undefined) {
      const open = !!today && hour >= today[0] && hour < today[1];
      const later = today && hour < today[0];
      return { source: 'venue', open, today, later: !!later, next: open || later ? null : (op.next && op.next.date > date ? op.next : null), custom: !!op.custom, tz };
    }
  }
  const { start, end } = cfg.hours;
  return { source: 'default', open: inWindow(name, now), today: [start, end], later: localHour(name, now) < start, next: null, custom: false, tz };
}
const isOpen = (v, now) => venueHours(v, now).open;

module.exports = { check, status, sendText, inWindow, venueHours, isOpen, activeFor, enabled, cfg };
