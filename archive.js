// Night archive: one saved record per venue per night, kept for good (Azure Table
// Storage), so past seasons stay on the board after venues stop sending them
// (venues send only their last ~120 days, and a replaced PC loses its database).
//
// Each heartbeat, every night row the venue sends (days[] + today) is compared
// with what's saved and written only if it changed: orders, revenue, tax, photos,
// emails, the sales mix, event name, and that night's open-hours weather (from
// weather.js; the live night's is updated as it changes). /api/history then adds
// saved nights the venue no longer sends.
//
// Config: ARCHIVE_TABLE_URL (https://<account>.table.core.windows.net) + optional
// ARCHIVE_TABLE (default "nights"). Signs in with the App Service's managed
// identity (role: Storage Table Data Contributor); no keys. ARCHIVE_FILE=<path>
// instead uses a local JSON file (dev). Neither set = archive off.
// Table row: PartitionKey = venue key (machineId, else name), RowKey = YYYY-MM-DD.

const fs = require('fs');

const URL = process.env.ARCHIVE_TABLE_URL || '';
const TABLE = process.env.ARCHIVE_TABLE || 'nights';
const FILE = process.env.ARCHIVE_FILE || '';
const FIELDS = ['event', 'orders', 'revenue', 'tax', 'photos', 'emails'];

const saved = new Map();      // venueKey -> Map(date -> record)
const sigs = new Map();       // `${venueKey}|${date}` -> JSON of the saved content
let client = null, loaded = false, lastError = null, lastWriteAt = null, writes = 0;
let chain = Promise.resolve();

const pk = (k) => String(k).replace(/[\/\\#?\u0000-\u001f\u007f-\u009f]/g, '_').slice(0, 512);
const json = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function remember(rec) {
  if (!saved.has(rec.venueKey)) saved.set(rec.venueKey, new Map());
  saved.get(rec.venueKey).set(rec.date, rec);
  sigs.set(rec.venueKey + '|' + rec.date, sigOf(rec));
}
const sigOf = (r) => JSON.stringify([r.venue, r.taxRate, ...FIELDS.map(f => r[f]), r.sales, r.weather]);

async function init() {
  try {
    if (URL) {
      const { TableClient } = require('@azure/data-tables');
      const { DefaultAzureCredential } = require('@azure/identity');
      client = new TableClient(URL, TABLE, new DefaultAzureCredential());
      await client.createTable().catch(e => { if (e.statusCode !== 409) throw e; });
      for await (const e of client.listEntities()) {
        remember({
          venueKey: e.venueKey || e.partitionKey, venue: e.venue, date: e.rowKey, taxRate: e.taxRate ?? null,
          ...Object.fromEntries(FIELDS.map(f => [f, e[f] ?? null])),
          sales: json(e.sales), weather: json(e.weather), savedAt: e.savedAt,
        });
      }
    } else if (FILE && fs.existsSync(FILE)) {
      for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) remember(r);
    }
    loaded = true;
    if (URL || FILE) console.log(`[archive] ${count()} saved nights loaded from ${URL ? 'table ' + TABLE : FILE}`);
  } catch (e) {
    lastError = e.message;
    console.error('[archive] load failed:', e.message);
    setTimeout(init, 5 * 60e3).unref();      // try again; nothing is written until loaded
  }
}
const enabled = () => !!(URL || FILE);
const count = () => [...saved.values()].reduce((s, m) => s + m.size, 0);

function write(rec) {
  chain = chain.then(async () => {
    if (client) {
      await client.upsertEntity({
        partitionKey: pk(rec.venueKey), rowKey: rec.date, venueKey: String(rec.venueKey), venue: rec.venue || '',
        ...Object.fromEntries(FIELDS.map(f => [f, rec[f] ?? null]).filter(([, x]) => x !== null)),
        ...(rec.taxRate != null ? { taxRate: rec.taxRate } : {}),
        sales: rec.sales ? JSON.stringify(rec.sales) : '', weather: rec.weather ? JSON.stringify(rec.weather) : '',
        savedAt: rec.savedAt,
      }, 'Replace');
    } else if (FILE) {
      fs.writeFileSync(FILE, JSON.stringify([...saved.values()].flatMap(m => [...m.values()]), null, 1));
    }
    lastWriteAt = new Date().toISOString(); writes++; lastError = null;
  }).catch(e => {
    lastError = e.message;
    sigs.delete(rec.venueKey + '|' + rec.date);   // retry on the next heartbeat
    console.error('[archive] write failed:', rec.venueKey, rec.date, e.message);
  });
}

// Save this venue's nights. rows = [{ date, event, orders, revenue, tax, photos, emails, sales }],
// wx = { date: weather summary } (may be partial).
function saveVenue(key, v, rows, wx) {
  if (!enabled() || !loaded) return;
  for (const d of rows) {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) continue;
    const old = (saved.get(key) || new Map()).get(d.date);
    const rec = {
      venueKey: key, venue: v.venue || '', date: d.date,
      taxRate: v.taxRate != null && Number.isFinite(Number(v.taxRate)) ? Number(v.taxRate) : (old ? old.taxRate : null),
      ...Object.fromEntries(FIELDS.map(f => [f, d[f] ?? (old ? old[f] : null)])),
      sales: d.sales || d.salesMix || (old ? old.sales : null),
      weather: (wx && wx[d.date]) || (old ? old.weather : null),
    };
    if (sigs.get(key + '|' + d.date) === sigOf(rec)) continue;   // unchanged
    rec.savedAt = new Date().toISOString();
    remember(rec);
    write(rec);
  }
}

// Saved nights for a venue, newest first, in the days[] row shape (+ weather).
const nightsOf = (key) => [...((saved.get(key) || new Map()).values())].sort((a, b) => b.date.localeCompare(a.date));

const status = () => ({ enabled: enabled(), loaded, nights: count(), venues: saved.size, writes, lastWriteAt, lastError });

init();
module.exports = { saveVenue, nightsOf, status };
