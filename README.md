# Fotomentum Fleet Dashboard

A live status board for the EventPhotos / Fotomentum venue fleet. Each venue
server POSTs an aggregate **heartbeat** (see `telemetryService.js` in the
EventPhotos repo); this app keeps the latest per venue and shows them live.

- **No customer data** ever reaches here — heartbeats are aggregates only
  (today's orders / revenue / sessions / photos / emails, printer-online, current event,
  venue name + machine id + version).
- **In-memory storage** (v1): the board is *live*; venues re-report ~every 45s,
  so a restart repopulates within a minute. See *Persisting history* below to add
  Azure Table Storage later.

## Emails and the ACS hourly cap

Heartbeats carry `today.emails` (every send, ACS + Microsoft 365) and
`today.emailsAcs` (ACS sends only). The board shows the fleet sum of `emails`
today and each venue's `emails`. Offline venues and older builds without the
fields count as 0.

The ACS limit is **per hour**, so the gauge shows ACS sends across the fleet in
the last 60 minutes against `ACS_HOURLY_EMAIL_CAP` (app setting, default 100):
amber from 70%, red from 90%. Venues only send a running daily count, so the
dashboard works out each hour's sends from how much `emailsAcs` rises between
heartbeats (in memory). For the first hour after a restart it covers only the
time since the restart, and says so.

Change the cap without a code change:

```bash
az webapp config appsettings set -n fotomentum-fleet -g dougga_rg_6763 --settings ACS_HOURLY_EMAIL_CAP=100
```

## Machine status row (S / P / K)

Each venue card shows **S** (server: last heartbeat received within 120 s,
`SERVER_FRESH_SEC`), **P** (photographer station, `machines.photographerOnline`)
and one **K** per kiosk seen in the last 5 min (`machines.kiosksRecent`): green
for the `kiosksOnline` ones, red for kiosks that just dropped. Grey = unknown:
no kiosks, a stale heartbeat, or an older venue build without `machines`
(S then falls back to the legacy `printerOnline` flag).

## Photo → sale and What's selling

**Photo → sale** = orders ÷ photos taken (today on the card, whole event on the
event line).

**What's selling** reads `today.sales` (or the older `today.salesMix`) and
`eventTotals.sales`, in the shape the venues send (EventPhotos 1.3.x):

```json
{
  "orders":   { "total": 27, "packages": 8, "alaCarte": 19 },
  "packages": [{ "name": "The Jingle", "count": 5 }],
  "prints":   [{ "size": "5x7", "qty": 28 }],
  "digitals": 10,
  "addOns":   { "items": 5, "amount": 60 },
  "packageOrdersWithExtras": 0
}
```

Packages with the same name are merged (event totals list one row per event
or series). The board also accepts the original spec's names
(`orders.package/cart`, `packages[].orders`, `digitals.qty`, `addons.qty/revenue`).
Each card shows packages vs à la carte orders, which packages, à la carte
items (print sizes + digitals) and upsells (`addOns`). The **What's selling**
section shows the same for the fleet (Today or This event; follows the
Showing date): fleet totals (minus `TOTALS_EXCLUDE` venues), packages vs à la
carte per venue, upsells per venue, top packages and à la carte items. Colours:
packages `#3987e5`, à la carte `#d95926`, upsells `#199e70` (validated on both
dark surfaces).

## Sales tax (true revenue)

Venue prices **include** sales tax, so `revenue` is what customers paid. The
board shows revenue **before tax** everywhere money appears (tiles, cards, event
line, avg order, Compare, Night by night, sort by $); each card has a small line
with what was paid and the tax in it. Venues send:

- `taxRate` (top level, percent, e.g. `7` or `8.25`): the venue's own rate;
- `tax` (optional) next to each `revenue` in `today`, `eventTotals` and each `days[]` row: the actual tax dollars.

The board uses `tax` when present, else backs it out of the rate:
`tax = revenue − revenue ÷ (1 + rate/100)`. A venue that sends neither shows
with tax still in, and the fleet tiles name it ("tax still in: …").
`/api/fleet` summary adds `todayTax`, `todayNet`, `eventTax`, `eventNet`, `taxMissing`.

## Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| POST | `/api/heartbeat` | venues | ingest a heartbeat (sends `x-venue-key`) |
| GET  | `/api/fleet` | board | latest snapshot + summary (behind Basic auth) |
| GET  | `/api/history` | board | each venue's `days` list (behind Basic auth) |
| GET  | `/` | board | the live status board (behind Basic auth) |
| GET  | `/healthz` | — | health check |

## Run locally

```bash
npm install
cp .env.example .env      # optional; blank values = open/dev
npm start                 # http://localhost:3000
```

Send a test heartbeat:

```bash
curl -X POST http://localhost:3000/api/heartbeat \
  -H "Content-Type: application/json" \
  -d '{"venue":"Test Venue","machineId":"abc","version":"1.0.0","event":"Light The Park","printerOnline":true,"today":{"orders":12,"unpaid":1,"revenue":340.50,"sessions":20,"photos":180}}'
```

## Deploy to Azure (App Service, Linux/Node)

Prereqs: an Azure subscription and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).

```bash
az login

# From this folder — creates the resource group + app and deploys the code:
az webapp up \
  --name fotomentum-fleet \
  --runtime "NODE:20-lts" \
  --sku B1 \
  --location eastus

# Lock it down + set the shared ingest key (use your own strong values):
az webapp config appsettings set --name fotomentum-fleet --settings \
  INGEST_KEY="<long-random-shared-key>" \
  DASHBOARD_USER="admin" \
  DASHBOARD_PASSWORD="<a-strong-password>" \
  OFFLINE_AFTER_SEC="150"
```

Your board is then at `https://fotomentum-fleet.azurewebsites.net` (prompts for
the dashboard user/password). `B1` is ~\$13/mo; `az webapp up` can also target the
Free (`F1`) tier for a trial.

## Point the venues at it

On each venue (Owner → Settings, or `deploy-defaults.env` for the whole fleet):

```
TELEMETRY_URL = https://fotomentum-fleet.azurewebsites.net/api/heartbeat
TELEMETRY_KEY = <the same INGEST_KEY you set above>
```

Within a minute each venue appears on the board. Use the venue's
**Owner → Settings → "Send test heartbeat"** (test-telemetry endpoint) to verify
immediately.

## Persisting history (optional, later)

v1 keeps only the latest heartbeat in memory. To keep history / survive restarts,
replace the `fleet` Map in `server.js` with **Azure Table Storage**
(`@azure/data-tables`): upsert each heartbeat keyed by `machineId`, and have
`/api/fleet` read the latest rows. The payload and board need no changes.

## Sale sound

Each viewer turns sound on with the **Sound** button (saved per browser; after a
reload, tap anywhere once so the browser allows audio). New sales play one sound
per refresh: `sounds/sale-small.mp3` (Epidemic Sound "User Interface, Alert,
Notification 13") for a sale under $100, `sounds/sale-big.mp3` (Epidemic Sound
"Shout Woo Hoo") for $100 or more (`BIG_SALE` app setting; the amount is the new
dollars ÷ new orders since the last refresh, tax included). Doug's Epidemic
licence; served behind the board password; a missing file plays a built-in
chime. `sounds/` is gitignored (licensed audio, public repo), so deploy with the
files added to the zip:

```bash
git archive -o fleet.zip HEAD && zip -q fleet.zip sounds/sale-small.mp3 sounds/sale-big.mp3 private/rustdesk.json
az webapp deploy -n fotomentum-fleet -g dougga_rg_6763 --src-path fleet.zip --type zip
```

## Version

The board shows its own version next to "Fleet" (from `package.json`, sent as
`dashboardVersion` in `/api/fleet`). Bump `version` in `package.json` with each
release and tag it (`git tag vX.Y.Z`).

## Compare venues

A collapsible "Compare venues" section above the cards: ranked horizontal bars
(one hue, `#3987e5`, validated on the card surface) for today's revenue, orders
today, photo → sale today, this event revenue and avg order this event. Hover,
focus or tap a row for the venue's detail. Open/closed is saved per browser
(phones start collapsed). For past dates and trends see *Past days*.

## Past days

Venues send `days` in the heartbeat: one row per venue-local date that had any
photos or orders, newest first, **today included**, up to 120 rows (the venue
also sends `today.date`, its own local date). Same money rules as `today`
(non-voided orders):

```json
"today": { "date": "2026-11-22", "orders": 20, "...": "..." },
"days": [
  { "date": "2026-11-21", "event": "Light The Park", "orders": 43, "revenue": 1697.69,
    "photos": 430, "emails": 46, "emailsAcs": 43, "sales": { "...": "same shape as today.sales" } }
]
```

`/api/fleet` leaves `days` out (it only reports `dayCount`), and the board loads
`/api/history` about once a minute. The **Showing** picker (‹ › and a date list)
switches the tiles, cards, What's selling and Compare charts to that date; sales
pulses and the sound stay live. **Night by night** shows the last 21 active
dates as columns (fleet total, then one small chart per venue on a shared scale;
Revenue / Orders / Photos); tap a column to open that date. Nothing is stored
here: the venue database is the record, so a restart loses no history, but a
venue whose PC is off shows no history until it reports again.

## Venues left out of the totals

`TOTALS_EXCLUDE` (app setting, comma-separated, case-insensitive match on the
venue name; default `Waltz Photo`) keeps a venue out of the fleet money totals:
All events to date, Avg per order, Today's revenue, the past-day tiles and the
Night by night fleet chart. AJ's Waltz Photo gives prints and digitals away for
toy donations, so its numbers would skew the totals. Its own card (marked "not in fleet
totals"), its Compare bars and its night-by-night mini chart still show its
sales. Emails still count (the ACS quota is shared). Set `TOTALS_EXCLUDE=` (empty)
to count every venue.

## RustDesk IDs

Each card has a **RustDesk** note listing that venue's machine IDs: tap an ID to
open it in RustDesk (`rustdesk://<id>`), or **Copy** it. The list is
`private/rustdesk.json` (gitignored, since the repo is public), served only behind the board
password at `/api/rustdesk`, and must be added to the deploy zip like the sound
(see *Sale sound*). Format: `[{ "match": "<part of the venue name>", "note"?,
"machines": [{ "label", "id", "note"? }] }]`. Edit the file and redeploy to change it.
