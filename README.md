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

## Emails

Heartbeats carry `today.emails` (every send). The board shows the fleet sum of
`emails` today, an all-dates total (each venue's `days[]` sum, never below its
current-event count) and each venue's `emails`. Offline venues and older builds
without the fields count as 0. The fleet sends through one Microsoft 365 mailbox
(ACS was retired 2026-11-27); each venue paces itself with
`EMAIL_MIN_SEND_INTERVAL_MS=15000` so 7 venues stay under the mailbox's ~30/min.

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

## Venue sales report
Each card has a **📊 Sales report** button. It opens a panel from the right with
everything that venue sold, built from its `days` history (the live night uses
the heartbeat `today`): sales (no tax), orders, nights with a sale, upsells; a
month calendar with each night shaded by its sales (dashed = open, no sale); sales
by night of the week; packages vs à la carte, each package, à la carte items and
upsells; and a night-by-night table. Choose **All dates** or **This event**; tap
a night (calendar or table) to narrow everything to that night. Opened while the
board shows a past date, it starts on that night. Code: `public/report.js`.

**Sales report** in the left rail is the same report for the whole fleet: every
venue's nights added together (minus `TOTALS_EXCLUDE` venues, like the tiles),
**All dates** or **Current events** (each venue's current event), plus a **By
venue** table; tap a venue there to open its own report (← Fleet goes back).

**Weather per night** (`weather.js`): for each venue's reported nights the server
looks up the weather during its open hours (`operating.today`, else 5–10 pm) from
Open-Meteo's hourly history (last 92 days, venue time zone), using the venue's
heartbeat `weather.place` (EventPhotos 1.3.44+; same place and same service as the
live weather chip). Nothing is stored: cached in memory per place, refreshed every
3 h (hourly while open), re-fetched after a restart. `/api/history` adds
`weatherPlace` and `weather` {date: {category, icon, label, startF, loF, hiF,
precipIn, wetHours, windMph, rainBeforeIn, hours, rough, why}}. A night is
**rough** for storms, snow, ≥0.05" rain while open, ≤32°F, wind ≥25 mph or
≥0.25" rain earlier that day. Shown as a small icon on rough nights in the report
calendars, a Weather column in the night-by-night table (rough nights in amber), a
banner when one night is picked, in the tooltips, and on the cards' weather chip
when the board shows a past date.

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

## Alerts and texts

Venues on EventPhotos 1.3.43+ send `alerts: [{ key, severity: "warn"|"critical",
message, since }]` while something is wrong (absent = healthy). Each card's pill
reads Online (green), Warning (amber), Critical (red) or Offline, with the
messages and how long underneath. A venue with no heartbeat for `DARK_AFTER_MIN`
counts as a critical "offline" alert (its own stale alerts are ignored). The
**Alerts** tile counts them.

`notifier.js` texts the on-call numbers through Twilio:

- a venue's **critical** alert (warnings only if `ALERT_TEXT_WARN=true`), and
- a venue going **dark** (no heartbeat for 6 min).

One incident per venue + alert key: one text when it starts, a reminder at most
every `REPEAT_MIN` (60) up to `REPEAT_MAX` (3), and an all-clear once it has been
gone `CLEAR_AFTER_MIN` (5), so flapping isn't spammy. Everything found in one
check is one text; every line starts with the venue name. Texts go out only
within `ALERT_HOURS` (default `17-22`, i.e. 5 pm to 10 pm, Doug 2026-11-23) in **each venue's
local time** (`VENUE_TZ`, "name part=IANA zone" pairs; defaults cover the current
venues); outside it trouble only shows on the board. The board's Alerts tile has
a **Send test text** button once Twilio is set.

| App setting | |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio account |
| `TWILIO_FROM` | Twilio number, `+1XXXXXXXXXX` |
| `ALERT_TO` | on-call numbers, comma-separated, `+1XXXXXXXXXX` |
| `ALERT_HOURS`, `VENUE_TZ`, `ALERT_TEXT_WARN`, `DARK_AFTER_MIN`, `REPEAT_MIN`, `REPEAT_MAX`, `CLEAR_AFTER_MIN` | optional |

Limits: state is in memory, so after a restart a venue that was already dark is
unknown until it reports again. On the Free plan the app stays awake only while
venues post heartbeats; if every venue went dark at once, nothing would text
(B1 + Always On fixes that).

## Email delivery

The rail's **Email delivery** fly-out lists each email from every venue's heartbeat
field `mailLog` (EventPhotos, next patch after 1.3.6x):
`{ items: [{ at, orderId, to (MASKED, e.g. a***@me.com), provider,
status: sent|pending|retrying|failed|bounced, attempts, reason }] }`, last 24 h,
≤ 200 rows per venue. "Sent" = Microsoft 365 accepted it and no bounce (NDR) came
back. Times in Eastern; 24-hour customer counts on the launcher; our own copies
(`MAIL_COPY_DOMAINS`, default eventphotoprinters.com) hidden by default. Look up the
full address in the venue app by order #.

## FotoPrint version

Each card shows the venue's FotoPrint (print exe) version under its EventPhotos
version, from the heartbeat field `fotoprint` (EventPhotos 1.3.52+):

    fotoprint: { version: "0.5.2" | null, found: bool, runs: bool, supportsPage: bool | null }

Green = newest any venue reports; amber = behind it; red = missing, won't run, or too
old for `--page` (pre-0.5.0, every print fails). Dashed "FotoPrint ?" = the venue
doesn't report it yet. Hidden for digital-only venues.

## Open / Closed

Under each card's status pill: **Open · till 9:30 pm**, **Closed · opens 6 pm**, or
**Closed · opens Fri 6 pm**. Venues on EventPhotos 1.3.51+ send their own schedule
(Owner → Settings → Trouble Alerts → Operating hours, `alert_hours`) as:

    operating: { open, date: "YYYY-MM-DD", today: [open, close] | null,
                 next: { date, hours: [open, close] } | null, custom }

(venue-local date; hours 24h, may be fractional, 21.5 = 9:30 pm; `today` null =
closed today; `next` = next opening after today). The board checks `today` against
the venue's local clock now (time zone from `VENUE_TZ`), so a dark venue still
opens and closes on time. Older builds fall back to `ALERT_HOURS` (default `17-22`)
in the venue's time zone; the pill is dashed and the tooltip says so. The alert
texts use the same open/closed answer. Live view only.

## Digital-only venues

`DIGITAL_ONLY` (comma-separated, matched on part of the venue name; default
`California`) lists venues with no printers. Their `printers` and `printAgent`
alerts are dropped at ingest (not on the board, never texted), and the card shows
"Digital only" next to the event. All other alerts still show.

## Weather

Venues on EventPhotos 1.3.44+ with a weather location send `weather: { category,
label, icon, tempF, hiF, loF, precipPct, place, summary, at }` (refreshed about
hourly). Each card shows a chip under the event: `summary` (or icon + label +
temp), then `H/L` and the rain chance. Rain and snow get a blue tint, storms
amber; hover shows the place and when it was updated. Informational only.

## Remote update

Venues on EventPhotos 1.3.46+ obey an "update now" command that rides back on the
heartbeat reply: `{ ok: true, update: { id, target? } }`. The venue runs its own
Pull Updates (GitHub **main HEAD** → build → restart) once per `id`, unless its
local `remote_update_enabled` setting is `0`. **Push to GitHub first, then update.**

On the board, tap **Update** beside a venue's version pill, then **Tap to confirm** within 6 s. Only
online venues on 1.3.46+ get a button. Older venues must be Pull-Updated by hand once.
If the venue is behind the newest version on the board, that version is the target.
Otherwise there's no target, and the update is done when the venue's `commit` changes.
The pill shows `updating…` (tap twice to cancel) and the status says **Updating**
while the venue restarts. A pending update suppresses the VENUE OFFLINE text. If
nothing changes within `UPDATE_GIVE_UP_MIN` (default 30) after delivery, the board
stops sending and shows `· no change`, usually because the venue was already on HEAD.
State is in memory, so a dashboard restart forgets pending updates.
Rollout: update one venue → check it → update the rest.

## Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| POST | `/api/heartbeat` | venues | ingest a heartbeat (sends `x-venue-key`) |
| GET  | `/api/fleet` | board | latest snapshot + summary (behind Basic auth) |
| GET  | `/api/history` | board | each venue's `days` list (behind Basic auth) |
| GET  | `/` | board | the live status board (behind Basic auth) |
| POST / DELETE | `/api/update/:venueKey` | board | issue / cancel a remote update (JSON body; behind Basic auth) |
| POST | `/api/alerts/test` | board | send a test text to `ALERT_TO` (behind Basic auth) |
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
    "photos": 430, "emails": 46, "sales": { "...": "same shape as today.sales" } }
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
sales. Emails still count (real sends). Set `TOTALS_EXCLUDE=` (empty)
to count every venue.

## RustDesk IDs

Each card has a **RustDesk** note listing that venue's machine IDs: tap an ID to
open it in RustDesk (`rustdesk://<id>`), or **Copy** it. The list is
`private/rustdesk.json` (gitignored, since the repo is public), served only behind the board
password at `/api/rustdesk`, and must be added to the deploy zip like the sound
(see *Sale sound*). Format: `[{ "match": "<part of the venue name>", "note"?,
"machines": [{ "label", "id", "note"? }] }]`. Edit the file and redeploy to change it.
