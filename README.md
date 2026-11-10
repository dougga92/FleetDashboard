# Fotomentum Fleet Dashboard

A live status board for the EventPhotos / Fotomentum venue fleet. Each venue
server POSTs an aggregate **heartbeat** (see `telemetryService.js` in the
EventPhotos repo); this app keeps the latest per venue and shows them live.

- **No customer data** ever reaches here — heartbeats are aggregates only
  (today's orders / revenue / sessions / photos, printer-online, current event,
  venue name + machine id + version).
- **In-memory storage** (v1): the board is *live*; venues re-report ~every 45s,
  so a restart repopulates within a minute. See *Persisting history* below to add
  Azure Table Storage later.

## Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| POST | `/api/heartbeat` | venues | ingest a heartbeat (sends `x-venue-key`) |
| GET  | `/api/fleet` | board | latest snapshot + summary (behind Basic auth) |
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
