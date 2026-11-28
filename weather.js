// Weather for each night a venue reported, so a slow night can be read against
// the weather. Looked up here (not sent by venues), so every past night gets it,
// with no venue update:
//   • place = the venue's heartbeat weather.place ("Lexington, Kentucky"), the
//     same place EventPhotos already uses for its live weather chip;
//   • geocoded and fetched from Open-Meteo (same free service EventPhotos uses):
//     hourly history for the last 92 days, in the venue's own time zone;
//   • summarised over the venue's open hours (heartbeat operating.today, else 5–10 pm).
// Nothing is written to disk: the history is Open-Meteo's, re-fetched after a
// restart. Cached per place; refreshed every 3 h (hourly while a venue is open).

// Azure App Service: prefer IPv4 (no IPv6 egress; a v6-first lookup fails as "fetch failed").
require('dns').setDefaultResultOrder('ipv4first');

const GEO_URL = (name) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
const HIST_URL = (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
  '&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m&past_days=92&forecast_days=1' +
  '&temperature_unit=fahrenheit&precipitation_unit=inch&wind_speed_unit=mph&timezone=auto';
const STALE_MS = 3 * 3600e3, STALE_OPEN_MS = 3600e3, RETRY_MS = 10 * 60e3;
const DEFAULT_HOURS = [17, 22];

const geo = new Map();      // place -> { lat, lon } | null (not found)
const cache = new Map();    // place -> { at, hourly } ; hourly = { time[], temperature_2m[], ... }
const busy = new Set(), failedAt = new Map(), lastError = new Map();   // place -> 'msg (code)'

// WMO weather codes → our categories, worst first.
const RANK = { storm: 6, snow: 5, rain: 4, fog: 3, clouds: 2, clear: 1 };
const LOOK = {
  storm: ['⛈️', 'Storms'], snow: ['❄️', 'Snow'], rain: ['🌧️', 'Rain'], fog: ['🌫️', 'Fog'],
  clouds: ['☁️', 'Cloudy'], clear: ['🌙', 'Clear'],
};
function category(code) {
  const c = Number(code);
  if (c >= 95) return 'storm';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if (c === 45 || c === 48) return 'fog';
  if (c === 2 || c === 3) return 'clouds';
  return 'clear';
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'fleet-dashboard' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function refresh(place) {
  if (busy.has(place) || Date.now() - (failedAt.get(place) || 0) < RETRY_MS) return;
  busy.add(place);
  try {
    if (!geo.has(place)) {
      const m = place.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);   // "lat,lon"
      if (m) geo.set(place, { lat: +m[1], lon: +m[2] });
      else {
        const j = await getJson(GEO_URL(place.split(',')[0].trim()));
        // Prefer the result in the named state ("Sugar Land, Texas").
        const want = (place.split(',')[1] || '').trim().toLowerCase();
        const hit = (j.results || []).find(r => !want || String(r.admin1 || '').toLowerCase() === want) || (j.results || [])[0];
        geo.set(place, hit ? { lat: hit.latitude, lon: hit.longitude } : null);
      }
    }
    const ll = geo.get(place);
    if (!ll) return;
    const j = await getJson(HIST_URL(ll.lat, ll.lon));
    if (j && j.hourly && Array.isArray(j.hourly.time)) { cache.set(place, { at: Date.now(), hourly: j.hourly }); lastError.delete(place); }
  } catch (e) {
    failedAt.set(place, Date.now());
    const why = `${e.message}${e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''}`;
    lastError.set(place, why);
    console.error('[weather]', place, why);
  } finally { busy.delete(place); }
}

const placeOf = (v) => v && v.weather && typeof v.weather.place === 'string' && v.weather.place.trim() ? v.weather.place.trim() : null;
function hoursOf(v) {
  const t = v && v.operating && Array.isArray(v.operating.today) ? v.operating.today : null;
  return t && t.length === 2 && Number.isFinite(+t[0]) && Number.isFinite(+t[1]) && +t[1] > +t[0] ? [+t[0], +t[1]] : DEFAULT_HOURS;
}

// One night: open-hours summary + rain earlier that day.
function summarise(h, date, [open, close]) {
  const rows = [];
  let before = 0;
  for (let i = 0; i < h.time.length; i++) {
    const t = h.time[i];                       // "YYYY-MM-DDTHH:MM", venue-local
    if (!t.startsWith(date)) continue;
    const hr = Number(t.slice(11, 13));
    if (hr >= open && hr < close) rows.push(i);
    else if (hr >= 8 && hr < open) before += Number(h.precipitation[i]) || 0;
  }
  if (!rows.length) return null;
  const vals = (k) => rows.map(i => Number(h[k][i])).filter(Number.isFinite);
  const temps = vals('temperature_2m'), precip = vals('precipitation'), wind = vals('wind_speed_10m');
  if (!temps.length) return null;
  let cat = 'clear';
  for (const i of rows) { const c = category(h.weather_code[i]); if (RANK[c] > RANK[cat]) cat = c; }
  const rain = Math.round(precip.reduce((s, x) => s + x, 0) * 100) / 100;
  const wetHours = precip.filter(x => x >= 0.01).length;
  // A wet code with no measurable precipitation (drizzle in the forecast) reads as cloudy.
  if ((cat === 'rain' || cat === 'snow') && rain < 0.01) cat = 'clouds';
  const lo = Math.round(Math.min(...temps)), hi = Math.round(Math.max(...temps)), windMax = Math.round(Math.max(0, ...wind));
  const reasons = [];
  if (cat === 'storm') reasons.push('storms');
  if (cat === 'snow') reasons.push('snow');
  if (rain >= 0.05) reasons.push(`${rain}" rain`);
  if (lo <= 32) reasons.push(`${lo}°F`);
  if (windMax >= 25) reasons.push(`wind ${windMax} mph`);
  if (before >= 0.25) reasons.push('rain earlier');
  return {
    category: cat, icon: LOOK[cat][0], label: LOOK[cat][1],
    startF: Math.round(temps[0]), loF: lo, hiF: hi, precipIn: rain, wetHours, windMph: windMax,
    rainBeforeIn: Math.round(before * 100) / 100, hours: [open, close],
    rough: reasons.length > 0, why: reasons.join(', '),
  };
}

// date -> summary for each of this venue's reported dates (only what's cached
// now; a stale or missing cache starts a background refresh).
function nightsFor(v, dates) {
  const place = placeOf(v);
  if (!place) return null;
  const c = cache.get(place);
  const openNow = v.operating && v.operating.open;
  if (!c || Date.now() - c.at > (openNow ? STALE_OPEN_MS : STALE_MS)) refresh(place);
  if (!c) return {};
  const hours = hoursOf(v), out = {};
  for (const d of dates) { const s = summarise(c.hourly, d, hours); if (s) out[d] = s; }
  return out;
}

const errorFor = (v) => { const p = placeOf(v); return p && !cache.has(p) ? lastError.get(p) || null : null; };

module.exports = { nightsFor, placeOf, errorFor };
