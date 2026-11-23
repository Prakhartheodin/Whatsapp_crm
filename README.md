# WhatsApp booking collector

Listens to 4 WhatsApp groups as a linked device (read-only), stores every text message in
MongoDB, picks out car/taxi bookings, removes duplicates and sends each confirmed booking to the
outputs you turn on (Telegram, Google Sheets, WhatsApp to one number). Unclear messages go to a
Review queue. A dashboard shows bookings, the review queue, raw messages and the connection
status, with Excel export. Other collectors can push messages in through `POST /ingest`.
Telegram also gets an alert when the groups go quiet or the WhatsApp session drops.

**What is verified and what is not.**

- Tested by `npm test` with in-memory fakes (fake models, fake `fetch`, fake socket, fake clock):
  the HTTP API and login, capture into `raw_messages` and the hand-over to the pipeline (once per
  message, re-fed after a restart), detection, extraction and de-duplication against the sample
  file, the LLM wrapper, the Telegram/Sheets/WhatsApp-send outputs, heartbeat and retention, and
  the ban-risk rule that only `whatsapp/send.js` may send.
- The start-up in `backend/index.js` is tested only up to its failure exits (a misconfigured output,
  MongoDB unreachable): the full start has never run.
- **Never run for real:** nothing has touched a real WhatsApp number, MongoDB, Telegram, Google
  Sheets or OpenAI yet. The dashboard was checked against the preview server only.
- The booking detection rules are placeholders until real messages are in `test/samples.json`
  (see [Booking detection and samples](#booking-detection-and-samples)), so expect misses and false
  positives until then.

On the first real run, watch the Status screen and `pm2 logs` yourself rather than relying only on
the alerts.

## Contents

- [Documentation](#documentation) · [How it works](#how-it-works) · [Project layout](#project-layout)
- [Build status](#build-status) · [Configuration](#configuration) · [HTTP API](#http-api) · [Safety rules](#safety-rules)
- [Outputs](#outputs) · [Booking detection and samples](#booking-detection-and-samples) · [Alerts and retention](#alerts-and-retention)
- [Setup on Windows](#setup-on-windows) · [Link the WhatsApp number](#link-the-whatsapp-number) · [Find the group IDs](#find-the-group-ids)
- [Create the admin login](#create-the-admin-login) · [Run](#run) · [Tests](#tests) · [Preview the dashboard](#preview-the-dashboard-without-whatsapp-or-mongodb)
- [Deploy to Ubuntu with pm2](#deploy-to-ubuntu-with-pm2) · [Back up the auth folder](#back-up-the-auth-folder) · [Re-link after a logout](#re-link-after-a-logout)
- [What each stop status means](#what-each-stop-status-means) · [Known gaps](#known-gaps)

## Documentation

| File | What it covers |
|---|---|
| [product.md](product.md) | What the product is and why: the user, goals, non-goals, what would make it a failure, privacy, delivery order. |
| [design.md](design.md) | Technical design: stack, folder structure, data flow, WhatsApp ban-risk rules, data models, detection/extraction/dedupe plan, HTTP routes and auth, hardening, jobs, environment variables, `test/samples.json` format, build order, open questions. |
| [ui-ux.md](ui-ux.md) | Dashboard spec: navigation, the Login, Bookings, Review, Raw messages, Status and Export screens, states, visual system, responsive rules, accessibility. |
| [.env.example](.env.example) | Every environment variable, with comments. |

`design.md` is the source of truth for behaviour; this README is the how-to.

## How it works

```
WhatsApp groups ──> backend (Baileys linked device, read-only)
                        │  every text message / caption from the 4 target groups
                        v
                    MongoDB  raw_messages ──> detect ─> extract ─> dedupe ─> bookings
                        ^                       ^                               │ confirmed only
   spool file (if MongoDB is down, replayed later)                  Telegram / Sheets / WhatsApp send
                                                │
                    Express HTTP API ─ POST /ingest   <── session cookie (admin) or API token
                        │
                    frontend/  static dashboard: Bookings, Review, Raw, Status, Export

   jobs: heartbeat (quiet groups, session down -> Telegram), retention (purges old raw messages)
```

- One Node.js process runs the WhatsApp connection and the HTTP server.
- The dashboard is plain HTML/CSS/JS served by the same process; there is no build step.
- One admin account exists, stored in MongoDB (`admins`). There is no registration.

## Project layout

```
backend/            the service
  index.js          start-up: MongoDB -> HTTP -> WhatsApp
  config.js         environment variables
  logger.js         pino logger with phone-number masking
  models.js         RawMessage, Admin, Booking
  whatsapp/         connection.js (session, reconnect), capture.js (store messages, spool),
                    send.js (the only sending code; off by default)
  pipeline/         rules.js (placeholder keywords), scorer.js, extractor.js, llm.js, dedupe.js, index.js
  outputs/          telegram.js, sheets.js, index.js (fan-out per confirmed booking)
  jobs/             heartbeat.js, retention.js
  auth/             password.js (scrypt), admin.js (single admin account)
  http/             server.js, auth.js (session + token), routes.js
frontend/           dashboard (login.html, index.html, app.js, api.js, format.js, app.css)
scripts/            groups.js, create-admin.js, mock-api.js (dashboard preview, made-up data)
test/               node:test suites (npm test)
ecosystem.config.cjs  pm2 config
product.md, design.md, ui-ux.md   project docs
```

One `package.json` at the root covers backend and frontend.

## Build status

| # | Step | State |
|---|---|---|
| 1 | WhatsApp connection: QR or pairing-code login, saved session, reconnect with backoff | Built; not yet run against a linked number |
| 2 | `npm run groups` | Built; not yet run against a linked number |
| 3 | Raw capture into `raw_messages` | Built; not yet run against a real MongoDB |
| 4-6 | Booking detection, extraction, de-duplication | Built and tested with fakes; rules are **placeholders** until real samples are supplied |
| 7 | Outputs: Google Sheets, Telegram, WhatsApp send | Built and tested with a fake `fetch` / socket; not yet run against Telegram or Google |
| 8 | HTTP API: health, export, bookings, raw, `POST /ingest` | Built and tested with in-memory fakes |
| 9 | Heartbeat alerts, retention purge | Built and tested with a fake clock |
| 10 | Dashboard | Built; verified against the preview server only |

The optional LLM pass (OpenAI) is built and tested with a fake `fetch` only.

## Configuration

Copy `.env.example` to `.env`; its comments explain each value. Booleans are `true` or `false`.

| Variable | Required | Meaning |
|---|---|---|
| `MONGODB_URI` | yes | MongoDB connection string |
| `API_TOKEN` | yes | 32+ characters; for scripts and monitoring (`x-api-token` header) |
| `SESSION_SECRET` | yes | 32+ characters; signs the dashboard login cookie |
| `TARGET_GROUP_IDS` | yes, to capture | The 4 group IDs, comma-separated (from `npm run groups`) |
| `AUTH_DIR` | recommended on Windows | Where the WhatsApp session keys live. Keep it outside OneDrive/Dropbox |
| `PAIRING_PHONE_NUMBER` | no | Set to link by pairing code instead of QR |
| `NODE_ENV`, `PORT`, `HOST` | no | `production` binds to 127.0.0.1 and marks the cookie `Secure` |
| `LOG_LEVEL` | no | Default `info`; phone numbers are masked at `info` and above |
| `HEARTBEAT_MINUTES` | no | Default 120. Telegram alert after this long without any group message (08:00-23:00 IST) |
| `SESSION_DOWN_ALERT_MINUTES` | no | Default 10. Telegram alert when WhatsApp is not connected this long |
| `RETENTION_DAYS` | no | Default 30. Raw messages older than this are deleted daily; `0` keeps them forever |
| `TELEGRAM_ENABLED` | no | Default `false`. Booking and heartbeat alerts to Telegram |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | when Telegram is on | Bot token from @BotFather; the chat or group to post to |
| `SHEETS_ENABLED` | no | Default `false`. One Google Sheets row per confirmed booking |
| `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` | when Sheets is on | The id from the sheet URL; path to the service-account key file |
| `GOOGLE_SHEET_RANGE` | no | Default `Sheet1!A1`; the tab the rows are appended to |
| `WHATSAPP_SEND_ENABLED` | no | Default `false`. Ban risk; see [Outputs](#outputs) |
| `TARGET_NUMBER` | when WhatsApp send is on | The one number that receives the messages (digits with country code) |
| `LLM_ENABLED` | no | Default `false`. Ask OpenAI about messages the rules are unsure of |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | when the LLM is on | API key, and a model that supports JSON-schema output |
| `LLM_CONFIRM_THRESHOLD` | no | Default 0.8. LLM confidence needed to confirm; lower goes to Review |

An enabled output or LLM with a missing setting stops the service at start with one `fatal` log
line naming the variable. A malformed value (e.g. `TELEGRAM_ENABLED=yes`, `RETENTION_DAYS=-1`)
stops it with an error naming the variable.

## HTTP API

Every route except `POST /login` and the static dashboard files needs the admin session cookie
or the API token (`x-api-token` header, or `?token=`).

| Method | Path | Purpose |
|---|---|---|
| POST | `/login`, `/logout` | Admin session |
| GET | `/api/me` | Who is logged in |
| GET | `/health` | WhatsApp state, last message time per group, today's counts |
| GET | `/api/bookings` | Paged bookings; `status`, `from`, `to`, `source`, `q`, `page` |
| POST | `/api/bookings/:id/confirm` \| `reject` \| `undo` | Review decisions |
| GET | `/api/raw` | Paged raw messages; `group`, `q`, `from`, `to`, `page` |
| GET | `/export` | Excel file of confirmed bookings; `from`, `to`, `source` |
| POST | `/ingest` | Run one message from another collector through the booking pipeline |

Dates are full ISO-8601 with a time zone, or a bare `YYYY-MM-DD` (a whole day in IST).

`POST /ingest` takes JSON `{ source, rawText, receivedAt }`: `source` 1-100 characters
(e.g. `app`), `rawText` 1-4000 characters, `receivedAt` a full ISO-8601 timestamp with a time
zone, at most 5 minutes in the future and 7 days in the past. It answers `{ status, bookingId?, duplicateOf? }` with
`status` one of `confirmed`, `review`, `duplicate`, `ignored`, or `400 { error }` for a bad
body. The text is kept on the booking only, not in raw messages.

```
curl -X POST http://localhost:3000/ingest \
  -H "content-type: application/json" \
  -H "x-api-token: $API_TOKEN" \
  -d '{"source":"app","rawText":"Cab needed Delhi to Agra tomorrow 6 am, 9876543210","receivedAt":"2026-11-23T09:15:00+05:30"}'
```
Details and response shapes are in [design.md](design.md) section 8.

## Safety rules

- The WhatsApp session is read-only: no read receipts, no presence, no joining groups, no
  contact or member fetching beyond the one call `npm run groups` needs. Nothing is sent
  unless you set `WHATSAPP_SEND_ENABLED=true` (see [Outputs](#outputs)).
- Baileys is an unofficial WhatsApp client. Using it carries some risk of the number being
  restricted even when read-only.
- The auth folder gives full access to the WhatsApp account. Never commit it, never keep it in a
  cloud-synced folder, back it up encrypted.
- Phone numbers are personal data: masked in logs, shown in full in the logged-in dashboard and
  in exports. Enabled outputs (Telegram, Sheets, WhatsApp send) and the LLM receive full numbers
  and message text, and those leave this server.

## Outputs

Each confirmed booking (confirmed by the rules, the LLM, or you in Review) is sent once to every
enabled output. Review items are not sent. One output failing is logged and does not stop the
others; a failed send is not retried later.

**Telegram.** Create a bot with @BotFather and copy its token into `TELEGRAM_BOT_TOKEN`. Send the
bot a message (or add it to a group and post there), open
`https://api.telegram.org/bot<token>/getUpdates` in a browser and copy `chat.id` into
`TELEGRAM_CHAT_ID`. Set `TELEGRAM_ENABLED=true`. Telegram also gets the heartbeat alerts.

**Google Sheets** (one row per booking: received, trip time, pickup, drop, car, fare, contact,
source, confidence, original message):

1. In Google Cloud Console create a project and enable the **Google Sheets API**.
2. IAM & Admin > Service accounts > create one (no roles needed) > Keys > Add key > JSON.
   Save the file outside OneDrive, e.g. `C:\secrets\sheets-sa.json`.
3. Open the sheet and Share it with the service account's email
   (`...@...iam.gserviceaccount.com`) as Editor.
4. In `.env`: `GOOGLE_SHEET_ID` = the long id in the sheet URL, `GOOGLE_SERVICE_ACCOUNT_JSON` =
   the key file path, `GOOGLE_SHEET_RANGE` if the tab is not `Sheet1`, `SHEETS_ENABLED=true`.
5. Restart. A missing or bad key file stops the service at start with a clear message.

Values are written as plain text, so a message starting with `=` is never run as a formula.

**WhatsApp send** (`WHATSAPP_SEND_ENABLED`, default `false`). Sending from the linked number is
the main ban risk; leave it off unless you need it. When on, it sends the booking alert only to
`TARGET_NUMBER` (the code cannot send anywhere else), waits a random 3-8 s before each message,
sends at most 10 per minute, queues up to 100 more (extras are dropped with a warning) and skips
a message while the session is not connected. The queue is in memory: a restart loses it.

## Booking detection and samples

Each new message (from the groups or `/ingest`) is scored against keyword rules: a high score is
confirmed, a low score ignored, anything between goes to the LLM if enabled, otherwise to Review.
A booking the rules confirm but that lacks pickup or drop goes to Review. Duplicates (same
contact, matching pickup and drop, same trip time, within 24 h) are folded into the first booking
as an extra source.

**The rules in `backend/pipeline/rules.js` are placeholders.** They were written without any real
messages. Paste real ones (anonymise the numbers if you like) into `test/samples.json`, then
tune `rules.js` until the tests pass. One object per message:

```json
{
  "id": "s1",
  "note": "optional free text",
  "text": "the message exactly as posted",
  "receivedAt": "2026-11-20T09:15:00+05:30",
  "expected": { "isBooking": true, "pickup": "Delhi Airport T3", "drop": "Agra",
    "tripDateTime": "2026-11-21T06:00:00+05:30", "carType": "Sedan", "fare": 3500, "contact": "9876543210" },
  "duplicateOf": null
}
```

`isBooking` is required; leave out any other `expected` field you don't care about.
`duplicateOf` is the `id` of an earlier sample this one repeats. Include non-bookings too
(driver "car available" posts, chat). Run the sample-driven tests with:

```
node --test test/scorer.test.js test/extractor.test.js test/dedupe.test.js test/pipeline.test.js
```

## Alerts and retention

With Telegram enabled, the heartbeat (every 5 minutes) sends:

- one alert when no message has arrived from any target group for `HEARTBEAT_MINUTES` between
  08:00 and 23:00 IST (the night does not count), then nothing until a message arrives;
- one alert when WhatsApp has not been connected for `SESSION_DOWN_ALERT_MINUTES`, and one when
  it is back;
- an immediate alert for a stop status (`logged_out`, `replaced`, `blocked`, `needs_link`).

An alert Telegram did not accept is retried at the next check. With Telegram off, each alert
appears once as a `warn` line in the log and is not retried. The Status screen shows whether the groups are quiet and when
the last alert went out.

Retention deletes raw messages older than `RETENTION_DAYS` (default 30) at start and once a day;
`0` keeps them forever. Bookings are never deleted.

## Setup on Windows

1. Install Node.js 20 or newer (`node --version`).
2. MongoDB: either install MongoDB Community locally (connection string
   `mongodb://127.0.0.1:27017/bookings`) or create a free MongoDB Atlas cluster and copy its
   connection string.
3. In the project folder: `npm install`
4. Copy `.env.example` to `.env` and fill it in. The comments in it explain each value.
   - `API_TOKEN` and `SESSION_SECRET`: generate each with
     `node -p "require('crypto').randomBytes(32).toString('hex')"`.
   - **`AUTH_DIR`: set it to a folder outside OneDrive**, for example `AUTH_DIR=C:\wa-auth`.
     The auth folder gives full access to the WhatsApp account. This project lives in
     `OneDrive\Desktop`, so the default `./auth` would be uploaded to OneDrive.

Run every command from the project folder, in PowerShell or cmd (Git Bash may echo passwords).

## Link the WhatsApp number

Linking needs a real terminal. The service under pm2 never shows a QR code.

1. Make sure the service is not running (two connections on one session knock each other out).
2. Run `npm run groups`.
3. A QR code appears. On the phone: WhatsApp > Linked devices > Link a device, and scan it.
   - Pairing code instead of a QR: set `PAIRING_PHONE_NUMBER=919876543210` (digits only,
     with country code) in `.env`, run `npm run groups` again, and enter the printed code under
     WhatsApp > Linked devices > Link a device > Link with phone number instead.
4. After linking, the same command prints every group the number is in (next section) and exits.

## Find the group IDs

`npm run groups` prints `name | id` for every group. Copy the 4 IDs you want into `.env`:

```
TARGET_GROUP_IDS=120363...@g.us,120363...@g.us,120363...@g.us,120363...@g.us
```

## Create the admin login

```
npm run create-admin
```

It asks for a username and password (needs MongoDB). There is exactly one admin.
To replace it (forgotten password): `npm run create-admin -- --reset`.

## Run

```
npm start
```

Then open `http://localhost:3000` (or your `PORT`) and log in.

## Tests

```
npm test
```

## Preview the dashboard without WhatsApp or MongoDB

```
node scripts/mock-api.js
```

Opens on `http://localhost:4000` with made-up data. Login: `admin` / `admin-password-123`.
Nothing in it is real.

## Deploy to Ubuntu with pm2

1. Install Node.js 20+, MongoDB, and pm2 (`npm install -g pm2`).
2. MongoDB: keep it bound to localhost (`bindIp: 127.0.0.1` in `/etc/mongod.conf`) and turn on
   authentication (`security.authorization: enabled`) with a user for this app. Put that user
   in `MONGODB_URI`.
3. Copy the project, run `npm install`, create `.env` with `NODE_ENV=production`.
4. Link the number in a terminal on the server: `npm run groups` (see above). Or copy a backed-up
   auth folder (see below) to `AUTH_DIR`.
5. Create the admin: `npm run create-admin`.
6. Start from the project folder: `pm2 start ecosystem.config.cjs`, then `pm2 save` and
   `pm2 startup` so it survives reboots. It runs exactly one instance in fork mode. Never scale
   it up: a second instance opens a second WhatsApp connection on the same session.
7. Put nginx or Caddy in front for HTTPS. The app listens on `127.0.0.1:PORT` only.

Caddy (`/etc/caddy/Caddyfile`) gets the certificate itself and sends the client IP by default:

```
bookings.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx (certificate from certbot):

```
server {
    listen 443 ssl;
    server_name bookings.example.com;
    ssl_certificate     /etc/letsencrypt/live/bookings.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bookings.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`POST /ingest` answers once the message has been through the pipeline. With the LLM on and a
backlog queued, that can take longer than nginx's default 60 s `proxy_read_timeout`; the client
then gets a 504 although the booking is still stored. Raise the timeout or retry with care (a
retry of a booking without a phone number is not recognised as a duplicate).

The `X-Forwarded-For` line matters. The login limit counts failed passwords per client IP.
Without that header every visitor looks like the same IP, so 5 bad passwords from anyone lock
the admin out for 15 minutes.

Logs: `pm2 logs booking-collector`. At the default `LOG_LEVEL=info`, phone numbers are masked
and message text is not logged.

## Back up the auth folder

The auth folder (`AUTH_DIR`) is the linked session. Losing it means linking again; anyone who
copies it can read the groups as you.

- Back it up while the service is stopped (`pm2 stop booking-collector`), then start it again.
- Store the backup encrypted (for example `tar czf - wa-auth | gpg -c > wa-auth.tgz.gpg`).
  Never put it in a cloud-synced folder unencrypted.
- The service keeps `creds.backup.json` next to `creds.json` itself and uses it if `creds.json`
  is damaged. That is not a replacement for an off-machine backup.

If MongoDB is down when a message arrives, the message is saved to `spool/raw.jsonl` and stored
automatically once MongoDB is back. Lines that can't be read are moved to
`spool/raw.rejected.jsonl` for you to look at.

## Re-link after a logout

1. `pm2 stop booking-collector` (or stop `npm start`).
2. Rename the auth folder, e.g. `wa-auth` to `wa-auth.old` (don't delete it until the new link works).
3. `npm run groups` in a terminal and scan the QR.
4. Start the service again.

## What each stop status means

The service stops connecting to WhatsApp, logs one `fatal` line naming the status
(`pm2 logs booking-collector`) and sends a Telegram alert if Telegram is enabled. The web dashboard keeps running; `/health` reports the status as
`whatsapp.status`.

### logged_out

WhatsApp unlinked this device (removed from Linked devices on the phone, or the session expired).
Restarting does not help, the saved session is dead. Follow "Re-link after a logout".
Also used when `creds.json` and `creds.backup.json` are both damaged: same fix.

### replaced

Another process or device opened this same session: a second copy of the service, or
`npm run groups` while the service was running. Stop the other one, then restart the service.
No re-link needed.

### blocked

WhatsApp refused the account (403). Do **not** re-link; the account is restricted. Open WhatsApp
on the phone and check what it says. Restart the service only once the phone works normally.

### needs_link

There is no linked session, and the service runs without a terminal (pm2), so it cannot show a QR
or pairing code. Stop pm2 (`pm2 stop booking-collector`), run `npm run groups` in a terminal to
link, then start pm2 again.

## Known gaps

- If the connection drops while WhatsApp is handing over a batch of messages, the library can
  drop that batch. The window is short; it is library behaviour.
- A message that cannot be decrypted is logged as a warning (`no readable content`) with its group
  and message ID. WhatsApp usually resends it; if not, it is missing.
- Outputs are sent at most once: a send that fails, or a crash between confirming a booking and
  sending, is logged and not retried.
- A stored message that did not finish the booking pipeline (restart, MongoDB error) is fed again
  at the next start or MongoDB reconnect, but only for 48 hours; older ones stay in Raw messages only.
- Messages longer than 4000 characters are classified from their first 4000 (the full text stays in
  Raw messages). A group name longer than 91 characters is cut in the booking source.
- The WhatsApp send queue and the pipeline queue live in memory; the send queue is lost on restart.
