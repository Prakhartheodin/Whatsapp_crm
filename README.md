# WhatsApp booking collector

Listens to 4 WhatsApp groups as a linked device (read-only) and stores every text
message in MongoDB. A dashboard shows the stored messages and the connection status.

What is built: group capture into `raw_messages`, the dashboard and its HTTP API, admin login.

**Not built yet:** booking detection, extraction and de-duplication; outputs to Google Sheets,
Telegram and WhatsApp; `POST /ingest`; heartbeat and session-down alerts; the retention purge.
Until alerts exist, check the dashboard Status screen or the logs yourself.

## Contents

- [Documentation](#documentation) · [How it works](#how-it-works) · [Project layout](#project-layout)
- [Build status](#build-status) · [Configuration](#configuration) · [HTTP API](#http-api) · [Safety rules](#safety-rules)
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
                    MongoDB  raw_messages ──(planned)──> detect ─> extract ─> dedupe ─> bookings
                        ^                                                          │
   spool file (if MongoDB is down, replayed later)                    (planned) Sheets / Telegram
                        │
                    Express HTTP API  <── session cookie (admin) or API token
                        │
                    frontend/  static dashboard: Bookings, Review, Raw, Status, Export
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
  whatsapp/         connection.js (session, reconnect), capture.js (store messages, spool)
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
| 4-6 | Booking detection, extraction, de-duplication | Not built; needs real message samples in `test/samples.json` |
| 7 | Outputs: Google Sheets, Telegram, WhatsApp send | Not built |
| 8 | HTTP API: health, export, bookings, raw | Built and tested with in-memory fakes; `POST /ingest` not built |
| 9 | Heartbeat alerts, retention purge | Not built |
| 10 | Dashboard | Built; verified against the preview server only |

Until step 5 exists the Bookings and Review screens stay empty on a real install; Raw messages
and Status show live data.

## Configuration

Copy `.env.example` to `.env`. The variables in use today:

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
| `HEARTBEAT_MINUTES` | no | Default 120; shown on Status (alerts not built yet) |

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

Dates are full ISO-8601 with a time zone, or a bare `YYYY-MM-DD` (a whole day in IST).
Details and response shapes are in [design.md](design.md) section 8.

## Safety rules

- The WhatsApp session is read-only: no messages sent, no read receipts, no presence, no
  joining groups, no contact or member fetching beyond the one call `npm run groups` needs.
- Baileys is an unofficial WhatsApp client. Using it carries some risk of the number being
  restricted even when read-only.
- The auth folder gives full access to the WhatsApp account. Never commit it, never keep it in a
  cloud-synced folder, back it up encrypted.
- Phone numbers are personal data: masked in logs, shown in full only in the logged-in dashboard
  and in exports.

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

The service stops connecting to WhatsApp and logs one `fatal` line naming the status
(`pm2 logs booking-collector`). The web dashboard keeps running; `/health` reports the status as
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
