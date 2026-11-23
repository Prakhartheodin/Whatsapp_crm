# Design: WhatsApp Booking Collector

Technical design. Read `product.md` for the why and `ui-ux.md` for the screens.
Items marked **(call)** were decided by the builder, not the owner; change freely.

## 1. Stack
| Piece | Choice |
|---|---|
| Runtime | Node.js LTS (>= 20; dev machine has v24), plain JavaScript, ESM |
| WhatsApp | `baileys` (npm). Checked 2026-11-23: `latest` = `7.0.0-rc14`, `legacy` = `6.7.24`. Pin `7.0.0-rc14` exactly **(call)**; re-check the docs/migration guide before writing connection code |
| Database | MongoDB via Mongoose |
| HTTP | Express |
| Excel | exceljs (streaming writer) |
| Logging | pino |
| Config | dotenv |
| Process | pm2 (production) |
| Tests | `node:test` + `node:assert` (built in) |
| Dashboard | Plain HTML/CSS/JS served by Express static. No build step |
| Telegram, Google Sheets | Built-in `fetch` + `node:crypto` (service-account JWT signed by hand). No SDK **(call)** |
| Admin auth | `node:crypto` scrypt + HMAC-signed cookie. No library **(call)** |

### Dependencies that need the owner's OK before they are added
1. LLM pass (step 4b): the owner chose **OpenAI**. Called with built-in `fetch`, no SDK **(call)**.
2. `qrcode-terminal`: **approved by the owner.** QR is the default login. Old note: Baileys no longer prints
   the QR itself. Without it, login uses the **pairing code** only (no dependency).
   Pairing code stays available as a fallback when `PAIRING_PHONE_NUMBER` is set.

## 2. Folder structure
```
.
├── product.md / design.md / ui-ux.md / README.md
├── .env.example
├── .gitignore                 # auth/, .env, node_modules/, logs/
├── ecosystem.config.cjs       # pm2
├── package.json               # exact pinned versions
├── auth/                      # Baileys session (gitignored, back this up)
├── scripts/
│   ├── groups.js              # npm run groups
│   └── create-admin.js        # npm run create-admin [-- --reset]: the single admin
├── src/
│   ├── index.js               # boot: config -> mongo -> http -> whatsapp -> jobs
│   ├── config.js              # read + validate env, fail fast on bad values
│   ├── logger.js              # pino + phone masking
│   ├── models.js              # RawMessage, Booking, Admin
│   ├── auth/                  # password.js (scrypt), admin.js (createAdmin)
│   ├── whatsapp/
│   │   ├── connection.js      # socket, auth state, reconnect/backoff, state
│   │   ├── capture.js         # messages.upsert -> raw_messages -> pipeline
│   │   └── send.js            # gated sender (queue, delay, rate limit)
│   ├── pipeline/
│   │   ├── rules.js           # ALL keywords/regex/weights/thresholds
│   │   ├── scorer.js          # stage a: cheap score
│   │   ├── extractor.js       # regex field extraction + normalisation
│   │   ├── llm.js             # stage b: classify+extract (interface, can be off)
│   │   ├── dedupe.js          # field-based duplicate check
│   │   └── index.js           # processMessage(): detect -> extract -> dedupe -> output
│   ├── outputs/
│   │   ├── index.js           # fan-out to enabled outputs, isolate failures
│   │   ├── sheets.js
│   │   ├── telegram.js        # also used for alerts
│   │   └── whatsapp.js        # wraps whatsapp/send.js
│   ├── http/
│   │   ├── server.js          # express app
│   │   ├── auth.js            # API token + admin session
│   │   └── routes.js          # health, export, ingest, dashboard JSON
│   ├── jobs/
│   │   ├── heartbeat.js
│   │   └── retention.js
│   └── public/                # dashboard: index.html, login.html, app.js, app.css
└── test/
    ├── samples.json           # owner pastes real messages here
    ├── scorer.test.js
    ├── extractor.test.js
    └── dedupe.test.js
```

## 3. Data flow
```
WhatsApp group msg ─┐
                    ├─> raw_messages (every text msg, target groups only)
POST /ingest ───────┘        │
                             v
                    scorer (rules.js)
              score >= HIGH │ LOW < score < HIGH │ score <= LOW
                    │               │                  │
                    │        LLM enabled?              └─> stop (stays only in raw)
                    │        yes: classify+extract
                    │        no : status = review
                    v               v
                 extractor  ─>  booking candidate
                             │
                          dedupe ── duplicate ─> add source to existing booking, stop
                             │ new
                             v
                    bookings (status confirmed | review)
                             │ confirmed only
                             v
                 outputs: Sheets, Telegram, WhatsApp (each env-toggled)
```
- `POST /ingest` messages are not stored in `raw_messages`; `rawText` lives on the booking. **(call)**
- Outputs fire once, when a booking becomes `confirmed` (automatically or by the
  admin in Review). Review items do not trigger outputs. **(call)**
- An output failing is logged and never blocks storage or other outputs.
- The pipeline handles one message at a time (in-process queue). Otherwise the
  same booking posted to two groups in the same second slips past dedupe.
- pm2 runs exactly one instance in fork mode. Cluster mode would open two
  WhatsApp sockets on one session.

## 4. WhatsApp connection (ban-risk rules)
Hard rules, enforced in code, not by convention:
- Socket options: `markOnlineOnConnect: false`, `syncFullHistory: false`.
- The codebase never calls `readMessages`, `sendPresenceUpdate`,
  `presenceSubscribe`, `groupAcceptInvite`, or any contact/member bulk fetch.
- Only one sending function exists (`whatsapp/send.js`). It throws unless
  `WHATSAPP_SEND_ENABLED=true`, sends only to `TARGET_NUMBER`, waits a random
  3-8 s before each send, and allows at most 10 messages per rolling minute
  (extra messages wait in an in-memory queue).
- Auth state persisted in `./auth` (multi-file auth state). If valid creds exist,
  no QR/pairing is ever requested.
- Disconnect handling:
  - Logged out (`DisconnectReason.loggedOut`): send Telegram alert, set state
    `logged_out`, **stop reconnecting**. HTTP stays up so the dashboard shows it.
    `./auth` is not deleted automatically; README explains re-linking.
  - Connection replaced (another socket opened on this session): alert and stop,
    same as logged out. Two sockets fighting over one session is itself a ban risk.
  - Restart required (normal right after pairing): reconnect immediately.
  - Anything else: reconnect with exponential backoff 2 s -> 5 min cap, with jitter.
    Telegram alert if still down after `SESSION_DOWN_ALERT_MINUTES`.
- Messages handled: `messages.upsert` of type `notify` and `append` (`append` covers messages that arrived while offline; the unique index drops repeats; confirm behaviour during step 3), only JIDs in
  `TARGET_GROUP_IDS`. Everything else is ignored without logging content.
- Group names: one `groupMetadata` call per target group per process start, not per reconnect (4 calls),
  cached in memory. **(call)**
- `npm run groups`: connects with the saved session, makes one
  `groupFetchAllParticipating` call, prints `name | id`, exits. The call also returns member lists; they are discarded, never stored or logged (there is no lighter way to list groups). Run it with the
  main service stopped (two sockets on one session conflict).

Login: QR drawn in the terminal with `qrcode-terminal` (default). If
`PAIRING_PHONE_NUMBER` is set, a pairing code is printed instead.

## 5. Data models
### raw_messages
| Field | Type | Notes |
|---|---|---|
| messageId | String | WhatsApp message key id |
| groupId | String | JID |
| groupName | String | |
| sender | String | participant JID (phone or LID) |
| text | String | conversation, extendedText, and image/video captions (a booking posted as a photo with a caption still counts) **(call)** |
| timestamp | Date | message time |
| createdAt | Date | insert time |

Indexes: unique `{groupId, messageId}` (re-delivery safe), `{timestamp: -1}`, text
search is a case-insensitive regex on `text` (volume is small) **(call)**.
Non-text messages: not stored; logged at info as `{groupId, type}`.

### admins
One document, fixed `_id: 'admin'` (so a second admin is impossible at the DB level).
Fields: `username`, `passwordHash` (`scrypt$<salt>$<hash>`), `createdAt`, `updatedAt`.

### bookings
| Field | Type | Notes |
|---|---|---|
| source | String | `whatsapp:<groupName>` or `app` (or whatever `/ingest` sends) |
| rawText | String | |
| pickup, drop | String | as extracted |
| pickupNorm, dropNorm | String | normalised, used by dedupe |
| tripDateTime | Date \| null | parsed in IST, stored UTC |
| carType | String \| null | |
| fare | Number \| null | rupees |
| contact | String \| null | last 10 digits |
| receivedAt | Date | |
| confidence | Number 0-1 | |
| rawMessageId | ObjectId \| null | ref raw_messages |
| status | `confirmed` \| `review` \| `rejected` | |
| decidedBy | `rules` \| `llm` \| `admin` | |
| decidedAt | Date | |
| otherSources | [{source, rawMessageId, receivedAt}] | duplicates folded into this row |
| outputsSentAt | Date \| null | guards against double output |

Indexes: `{status, receivedAt: -1}`, `{contact, receivedAt: -1}`.
`rejected` rows are kept: together with admin-confirmed rows they are labelled
examples for tuning the rules. Bookings are not purged by retention **(call)**;
only raw messages are.

## 6. Detection and extraction
### Stage a: scorer (`pipeline/scorer.js`, rules in `pipeline/rules.js`)
`score(text) -> { score, hits }`. Rules file holds weighted signal groups:
pickup/drop words, cab types, dates, times, phone numbers, fare, plus negative
signals. Two thresholds, `HIGH` and `LOW`, also in `rules.js`.

**TODO (needs real samples):** the actual keywords, Hindi/Hinglish variants,
weights and thresholds. The first version ships with a minimal, clearly marked
placeholder rule set. No booking formats are invented.

### Stage b: LLM (`pipeline/llm.js`)
Interface: `classifyAndExtract(text, receivedAt) -> { isBooking, confidence, fields } | null`.
- `LLM_ENABLED=false` -> returns `null`; ambiguous messages go to Review.
- Enabled -> one OpenAI API call with a strict JSON output; model from
  `OPENAI_MODEL`. Timeout or error -> treated as `null` (Review), never a crash.
- LLM says booking with confidence >= `LLM_CONFIRM_THRESHOLD` -> `confirmed`;
  booking with lower confidence -> `review`; not a booking -> dropped.

### Extractor (`pipeline/extractor.js`)
`extract(text, receivedAt) -> { pickup, drop, tripDateTime, carType, fare, contact }`.
Pure function, regex-based, used when the scorer is confident. Relative dates
("kal", "tomorrow", "aaj") resolve against `receivedAt` in IST.
**TODO (needs real samples):** field patterns.
A confident score with missing pickup or drop is downgraded to `review`. **(call)**

## 7. De-duplication (`pipeline/dedupe.js`)
A new candidate is a duplicate of an existing booking when, within 24 h of
`receivedAt`:
- `contact` equal (last 10 digits), and
- `pickupNorm` and `dropNorm` each match fuzzily, and
- `tripDateTime` equal to the minute, or both null.

Normalisation: lowercase, strip punctuation, collapse spaces, drop filler words
(list in `rules.js`). Fuzzy match: token-set overlap or small edit distance,
hand-written (no library). Query narrows by `contact` + time window first, then
compares in JS.
- Duplicate: keep the first booking; push `{source, rawMessageId, receivedAt}` to
  its `otherSources`; no outputs.
- Candidate without a contact is never de-duplicated. **(call; revisit with samples)**
- `rejected` bookings do not absorb duplicates.

## 8. HTTP
### Auth
Two ways in; every route except `/login` and static login assets needs one:
- **API token**: header `x-api-token` or query `?token=` equal to `API_TOKEN`
  (constant-time compare). For `/ingest`, scripts, monitoring.
- **Admin session**: `POST /login` with the username + password checked
  against the admin in the `admins` collection (scrypt hash; created with
  `npm run create-admin`, reset with `-- --reset`). Sets an HMAC-signed cookie
  (`SESSION_SECRET`), `HttpOnly`, `SameSite=Strict`, `Secure` in production,
  7-day expiry. Login attempts limited to 5 per 15 min per IP (in memory).
  State-changing routes accept JSON only; with `SameSite=Strict` that covers CSRF.

There is no user table and no registration route.

### Hardening
- Group members are untrusted authors. The dashboard inserts message text with
  `textContent` only, never `innerHTML`.
- Response headers: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`.
- In production Express binds to `127.0.0.1` (only the reverse proxy reaches it)
  and sets `trust proxy` to 1 so the login rate limit sees the real client IP.
- `?token=` ends up in proxy logs and browser history. Prefer the header; our own
  request logs drop the query string.
- Google Sheets append uses `valueInputOption=RAW` so a message starting with `=`
  is never evaluated as a formula.
- LLM pass: message text is untrusted input. No tools, output validated against a
  fixed schema, anything else is treated as `null`.
- Logout clears the cookie only. To revoke every session, rotate `SESSION_SECRET`.
- `./auth` gives full access to the WhatsApp account: owner-only file permissions
  on the VPS, encrypted backups.

### Routes
| Method | Path | Purpose |
|---|---|---|
| POST | `/login`, `/logout` | admin session |
| GET | `/health` | `{ whatsapp: state, lastMessageAt, perGroup: [{id, name, lastMessageAt, countToday}], counts: {rawToday, bookingsToday, reviewPending, duplicatesToday}, heartbeat }` |
| GET | `/export?from=&to=&source=` | streams `.xlsx` of `confirmed` bookings |
| POST | `/ingest` | body `{source, rawText, receivedAt}`; validated; runs the same pipeline; returns `{status, bookingId?, duplicateOf?}` |
| GET | `/api/bookings?status=&from=&to=&source=&q=&page=` | paged list (50/page), returns `total` |
| POST | `/api/bookings/:id/confirm` | review -> confirmed, fires outputs |
| POST | `/api/bookings/:id/reject` | review -> rejected |
| POST | `/api/bookings/:id/undo` | back to review (the Undo toast); does not unsend outputs |
| GET | `/api/raw?group=&q=&from=&to=&page=` | paged raw messages |
| GET | `/` and static files | dashboard |

Input validation on every query/body field (dates parse, enums match, text length
capped at 4 000 chars, `q` regex-escaped). TLS is terminated by a reverse proxy
(nginx or Caddy) on the VPS; README covers it.

## 9. Jobs
- **Heartbeat** (every 5 min): between 08:00 and 23:00 IST, if no message from
  any target group for `HEARTBEAT_MINUTES` (default 120) -> one Telegram alert,
  then silent until a message arrives (no repeat spam). Last-message time is read
  from `raw_messages`, so a restart does not reset it. Session-drop alerts come
  from the connection module.
- **Retention** (daily, and once at boot): delete `raw_messages` older than
  `RETENTION_DAYS`. `0` disables purging.

## 10. Logging and privacy
- pino JSON logs; pm2 handles files/rotation.
- A single `maskPhone()` helper: `98xxxxxx10`. Info level never contains full
  numbers, JIDs or message text; debug level may.
- Dashboard and exports show full numbers (behind login). **(call)**

## 11. Environment variables
All documented in `.env.example`.
```
# core
NODE_ENV, PORT, LOG_LEVEL, MONGODB_URI
# (no TZ variable: IST is hard-coded as UTC+5:30, the TZ env is unreliable on Windows)
# whatsapp
TARGET_GROUP_IDS (comma-separated, 4), PAIRING_PHONE_NUMBER,
WHATSAPP_SEND_ENABLED=false, TARGET_NUMBER, SESSION_DOWN_ALERT_MINUTES=10
# auth
API_TOKEN, SESSION_SECRET
# llm
LLM_ENABLED=false, OPENAI_API_KEY, OPENAI_MODEL, LLM_CONFIRM_THRESHOLD=0.8
# outputs
SHEETS_ENABLED=false, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (path),
TELEGRAM_ENABLED=false, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# housekeeping
HEARTBEAT_MINUTES=120, RETENTION_DAYS=30
```

## 12. Tests and the samples file
`npm test` runs `node --test`. Scorer, extractor and dedupe tests are driven by
`test/samples.json`:
```json
[
  {
    "id": "s1",
    "note": "optional free text",
    "text": "the message exactly as posted",
    "receivedAt": "2026-11-20T09:15:00+05:30",
    "expected": {
      "isBooking": true,
      "pickup": "Delhi Airport T3",
      "drop": "Agra",
      "tripDateTime": "2026-11-21T06:00:00+05:30",
      "carType": "Sedan",
      "fare": 3500,
      "contact": "9876543210"
    },
    "duplicateOf": null
  }
]
```
- `isBooking` is required; omit any other `expected` field you don't care about.
- `duplicateOf` holds the `id` of an earlier sample this should be folded into.
- The file starts with a few placeholder examples, clearly marked as placeholders.

## 13. Build order
| # | Step | Stop? |
|---|---|---|
| 1 | Connection: pairing login, saved session, reconnect | |
| 2 | `npm run groups` | |
| 3 | Raw capture into `raw_messages` | **Stop. Owner links number, confirms capture, supplies samples** |
| 4 | Detection: scorer, then LLM interface | needs samples |
| 5 | Extraction into `bookings` | needs samples |
| 6 | De-duplication | |
| 7 | Outputs: Sheets, Telegram, WhatsApp send | |
| 8 | HTTP API: health, export, ingest | |
| 9 | Heartbeat + retention | |
| 10 | Dashboard: login, Bookings, Review, Raw, Status, Export | |
| 11 | README, `.env.example` final pass | |

`.env.example`, `.gitignore`, logger and config land with step 1.

## 14. Open questions for the owner
1. Answered: LLM is OpenAI, via `fetch`.
2. Answered: `qrcode-terminal` approved.
3. Real message samples for `test/samples.json` (after step 3).
4. Is `RETENTION_DAYS=30` a good default?
5. Is there a domain name for the VPS? The dashboard login needs HTTPS.
6. With the LLM and Telegram on, message text including phone numbers goes to
   OpenAI and Telegram. Acceptable?
7. Bookings (with contact numbers) are kept forever; only raw messages are purged.
   Should bookings expire too?
8. Baileys `7.0.0-rc14` (current `latest`, release candidate) or `6.7.24` (stable `legacy`)?
