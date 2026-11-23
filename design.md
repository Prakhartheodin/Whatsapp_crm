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
├── package.json               # the only one (monorepo); exact pinned versions
├── auth/                      # Baileys session (gitignored, back this up)
├── scripts/
│   ├── groups.js              # npm run groups
│   └── create-admin.js        # npm run create-admin [-- --reset]: the single admin
├── backend/
│   ├── index.js               # boot: config -> output/LLM factories (fail fast) -> mongo -> spool replay +
│   │                          #   re-feed unprocessed -> group names from mongo -> http (+ jobs) -> whatsapp
│   ├── config.js              # read + validate env, fail fast on bad values
│   ├── config-guard.js        # imported first by entry points: a bad value is one fatal line
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
│   │   └── common.js          # fetch with timeout/retry, IST formatting (WhatsApp send: whatsapp/send.js)
│   ├── http/
│   │   ├── server.js          # createApp(deps): express app, headers, static, errors
│   │   ├── auth.js            # API token + admin session + login rate limit
│   │   └── routes.js          # health, export, ingest, dashboard JSON
│   └── jobs/
│       ├── heartbeat.js
│       ├── outbox.js          # retries outputs not yet delivered
│       └── retention.js
├── frontend/                  # static dashboard served by the backend: index.html, login.html, JS, CSS
└── test/                      # one node:test file per module (in-memory fakes, no network), plus:
    ├── samples.json           # owner pastes real messages here (drives scorer/extractor/dedupe tests)
    └── boot.test.js           # spawns backend/index.js: fail-fast exits only
```

## 3. Data flow
```
WhatsApp group msg ──> raw_messages (every text msg, target groups only; processedAt set
                             │        once the pipeline decided, unprocessed rows re-fed on start)
POST /ingest ───────┐        │
                    └────────v
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
  (extra messages wait in an in-memory FIFO queue capped at 100; overflow is dropped
  with a warning). The caller cannot pass a recipient; sends are sequential and are
  skipped when the socket is not open. `test/send.test.js` fails if any other file in
  `backend/` or `scripts/` calls `sendMessage`, `readMessages`, presence or join functions.
- Auth state persisted in `AUTH_DIR` (default `./auth`, resolved from the project
  folder; multi-file auth state), created/chmod-ed to 0700. It must not live in a
  cloud-synced folder. If valid creds exist, no QR/pairing is ever requested.
- QR / pairing code only with an interactive terminal (`process.stdout.isTTY`).
  Without one (pm2): fatal log, state `needs_link`, no reconnect. Link with `npm run groups`.
- On every `open`, `creds.json` is copied to `creds.backup.json`. On start, a damaged
  `creds.json` is restored from the backup; if both are damaged the service stops
  (`logged_out`) instead of creating a new identity. `npm run groups` and SIGINT/SIGTERM
  wait for in-flight credential writes (`flushCreds()`) before exiting.
- libsignal's `console.info/warn/debug` (session objects with private keys) go to
  `logger.debug` with objects dropped (`quietConsole()`); `console.log` is untouched.
- Disconnect handling (one fatal log per stop status, pointing to the README section):
  - Logged out (`DisconnectReason.loggedOut`, or multidevice mismatch): send Telegram alert,
    set state `logged_out`, **stop reconnecting**. HTTP stays up so the dashboard shows it.
    The auth folder is not deleted automatically; README explains re-linking.
  - Connection replaced (another socket opened on this session): state `replaced`, alert
    and stop. No re-link needed. Two sockets fighting over one session is itself a ban risk.
  - Forbidden (403): state `blocked`, stop. Do not re-link.
  - Restart required (normal right after pairing): reconnect immediately.
  - Anything else: reconnect with exponential backoff 2 s -> 5 min cap, with jitter.
    The attempt counter resets only after the connection stayed open for 60 s.
    Telegram alert (from the heartbeat job) if still down after `SESSION_DOWN_ALERT_MINUTES`.
- MongoDB write failures: the message is appended to `spool/raw.jsonl` (0700 dir) and
  replayed (same idempotent upsert) at start and on every Mongoose `connected`/`reconnected`.
  Lines that fail stay; unreadable lines move to `spool/raw.rejected.jsonl`. Counts only in logs.
- A target-group upsert with no content (undecryptable, stub) is logged as a warning with
  group ID, message ID and stub/reason. Sender is the `@s.whatsapp.net` one of
  `participant`/`participantAlt`, else `participant`; `me` for own messages.
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
| processedAt | Date \| null | set when the booking pipeline has decided (any result); rows still null from the last 48 h are re-fed at start and on MongoDB reconnect, unless a booking already points to them |
| createdAt | Date | insert time |

Indexes: unique `{groupId, messageId}` (re-delivery safe), `{timestamp: -1}`, `{processedAt, timestamp}` (the re-feed), text
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

Indexes: `{status, receivedAt: -1}`, `{contact, receivedAt: -1}`, `{rawMessageId}` and `{otherSources.rawMessageId}` (the Raw tab's booking-status lookup, which also reports folded duplicates, and the re-feed), `{status, outputsSentAt}` (the outbox).
Output delivery: `outputsSentAt` is the claim time (set once, atomically, when the booking is first
confirmed); `wanted` = outputs enabled at the first attempt (the only ones ever sent);
`sending.{telegram,sheets,whatsappSend}` = write-ahead mark set before a send and cleared with its
result (set without a delivery = unknown outcome); `delivered.{...}` = when that output got it;
`givenUp.{...}` = when it was given up (7 days); `outputAttempts`, `lastAttemptAt` drive the schedule.

### ingest_keys
`{source, clientMessageId, result, createdAt}`: `/ingest` idempotency. Unique `{source, clientMessageId}`;
TTL index removes a row 7 days after `createdAt`. `result` is the first answer (null while processing).
A group's source is its last known name (from MongoDB at start, then from WhatsApp); bookings stored with `whatsapp:<groupId>` are renamed once the name is known.
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
Built: each group counts once; placeholders are `HIGH=6`, `LOW=2`; booking words
("cab", "gadi chahiye") weigh 3 so a terse request reaches Review. The
driver-availability group ("available", "khali", "free car") is a cap, not a
weight: when it hits, a score above `LOW` always goes to Review (never
rule-confirmed, never ignored, no LLM call), because customers also ask "car
available?". All keywords and patterns live only in `rules.js`, each group
marked `TODO(samples)`. Rule-decided bookings get `confidence = min(1, score / 12)`.

### Stage b: LLM (`pipeline/llm.js`)
Interface: `classifyAndExtract(text, receivedAt) -> { isBooking, confidence, fields } | null`.
- `LLM_ENABLED=false` -> returns `null`; ambiguous messages go to Review.
- Enabled -> one OpenAI API call with a strict JSON output; model from
  `OPENAI_MODEL`. Timeout or error -> treated as `null` (Review), never a crash.
- LLM says booking with confidence >= `LLM_CONFIRM_THRESHOLD` -> `confirmed`;
  booking with lower confidence -> `review`; not a booking -> dropped only when
  `1 - confidence >= LLM_CONFIRM_THRESHOLD` (sure it is not), otherwise `review`.
- Built: `createLlm(config, { fetch, logger })`, plain `fetch` to
  `/v1/chat/completions`, JSON-schema structured output, 15 s timeout, one retry
  on 429/5xx. The message goes in as JSON data; the system prompt says to ignore
  instructions inside it. The reply is validated strictly (types, confidence
  0-1, dates with an explicit offset); anything else -> `null` + a warning that
  holds neither the text nor the key. Enabled without key or model -> throws.
  Implausible values become empty fields: a contact not among the phone numbers
  in the message, a fare outside `FARE_MIN`-`FARE_MAX`, a trip time more than 1
  day before or 1 year after `receivedAt`, text over 100 characters, "".
- At most `LLM_MAX_IN_FLIGHT` (4) messages wait on the LLM at once; more go
  straight to Review. Deciding (rules, LLM) runs outside the serial section, so a
  slow LLM call never delays other messages; only dedupe + store are serial.

### Extractor (`pipeline/extractor.js`)
`extract(text, receivedAt) -> { pickup, drop, tripDateTime, carType, fare, contact }`.
Pure function, regex-based, used when the scorer is confident. Relative dates
("kal", "tomorrow", "aaj") resolve against `receivedAt` in IST.
**TODO (needs real samples):** field patterns.
A confident score (or a confident LLM answer) with missing pickup or drop is downgraded to `review`. **(call)**
Built rules: contact = last 10 digits of an Indian mobile number (+91 / 91 / 0
prefix, spaces or dashes); fare needs a currency or fare word (a bare number is
not a fare; a list or range of fares, "6000-7000", gives none; a per-km rate such as
"12/km" is not a fare); a time without a date is its next occurrence at or after
`receivedAt`; a date without a time gives no `tripDateTime`. Two different values
for a field, or an hour 1-12 without am/pm or a morning/evening word ("8 baje"),
give `null`: a field is never guessed. Dates: 21/11, 21/11/2026, 21-11-2026,
21.11.2026, 21 Nov (dashes and dots only with a year: "6-7 seater" is a count).
A slash pair after an address word ("flat 12/3") is not a date. Date-like text
the rules cannot read ("25-11", "Nov 25", "25 tarikh") leaves
`tripDateTime` empty instead of falling back to the next occurrence; so does
"kal"/"tomorrow" sent between 00:00 and 04:00 IST, and an explicit date up to 7
days in the past. Places: each cut field leaves a line break, so a place stops at
the next field or sentence end. The pickup may span commas ("Connaught Place, New
Delhi to ..."). The drop ends at a comma ("Agra, one way" gives "Agra"), except
once after a part with a number or locality word ("Sector 62, Noida"), and only
if what follows is more than trip qualifiers ("Sector 62, one way" gives "Sector 62").
Trip qualifiers ("one way", "round trip", "urgent", "AC", "toll", ...; list in
`rules.js`) are stripped from the end of a pickup or drop ("Jaipur one way" gives
"Jaipur"), unless the qualifier is the whole place. Every
pattern stays linear on 4000-character input; a timing test guards this.
Not handled yet: Devanagari script, "raat"/night times.

## 7. De-duplication (`pipeline/dedupe.js`)
A new candidate is a duplicate of an existing, non-rejected booking received
within +-24 h of its `receivedAt` when all of these hold:
- `contact` equal (last 10 digits), or both without a single contact (none, or
  several numbers in the message);
- `carType` and `fare` do not differ where both are present;
- `tripDateTime` is equal to the minute when both are present;
- and then either the `rawText` is identical after lowercasing and ignoring
  spacing, punctuation, emoji and WhatsApp formatting (an exact repost), or (contact present and both trip times present)
  `pickupNorm` and `dropNorm` each match fuzzily.
So a missing trip time or contact merges only an exact repost: a dispatcher's
"Delhi to Agra kal 8 baje" and "... 10 baje" stay two bookings.

Normalisation: lowercase, strip punctuation, collapse spaces, drop filler words
(list in `rules.js`). Fuzzy match: token-set overlap or small edit distance,
hand-written (no library). Query narrows by `contact` + time window first, then
compares in JS. Built: two places match, in any word order, when their number
tokens are identical ("sector 62" is not "sector 63", "T1" is not "T3"), every
word of the shorter place matches one in the longer (New and Old Delhi Railway
Station differ), and those are at least 75% of the longer place's words ("Noida"
is not "Noida Sector 62" or "Greater Noida"); words match when equal, or (letters only, 6+ letters, same
first letter) one edit apart (Connaught/Conaught yes, Jaipur/Raipur no). A
missing pickup or drop never matches. The window is +-24 h (an older copy
processed late still folds in); the earliest match wins. Dedupe and store run one
message at a time, so copies arriving together cannot both pass.
- Duplicate: keep the first booking; push `{source, rawMessageId, receivedAt}` to
  its `otherSources`; no outputs. Exception: a `confirmed` copy of a `review`
  booking (not one the admin put back in Review) confirms it, fills its empty
  fields from the copy, and fires the outputs once (same atomic claim).
- `rejected` bookings do not absorb duplicates.

## 8. HTTP
### Auth
Two ways in; every route except `/login` and static login assets needs one:
- **API token**: header `x-api-token` or query `?token=` equal to `API_TOKEN`
  (constant-time compare). For `/ingest`, scripts, monitoring.
- **Admin session**: `POST /login` with the username + password checked
  against the admin in the `admins` collection (scrypt hash; created with
  `npm run create-admin`, reset with `-- --reset`). Sets cookie
  `sid=<base64url {u, exp}>.<HMAC-SHA256 with SESSION_SECRET>`, `HttpOnly`,
  `SameSite=Strict`, `Path=/`, `Secure` in production, 7-day expiry; no session store.
  Unknown username and wrong password give the same 401 and both cost one scrypt.
  Rate limit: 5 failed logins per 15 min per IP (in memory, expired entries pruned,
  attempts counted before the password check so parallel guesses cannot exceed it;
  a success clears the count). Over the limit: `429 { error, retryAfterSec }`.
  State-changing routes accept JSON only (`415` otherwise); with `SameSite=Strict` that covers CSRF.
  Body limit 16 kB.

There is no user table and no registration route.

### Hardening
- Group members are untrusted authors. The dashboard inserts message text with
  `textContent` only, never `innerHTML`.
- Response headers on everything: `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `X-Powered-By` off.
- In production Express binds to `127.0.0.1` by default (`HOST`; only the reverse proxy reaches it)
  and sets `trust proxy` to 1 so the login rate limit sees the real client IP.
  This needs the proxy to send `X-Forwarded-For` (nginx: `proxy_set_header`, Caddy: by default);
  without it all visitors share one limit and 5 bad passwords from anyone lock the admin out for 15 min.
- `?token=` ends up in proxy logs and browser history. Prefer the header. There is
  no request logging; error logs carry method + path only (no query string).
- Errors: unknown `/api/*` -> JSON 404; unexpected errors are logged and answered
  `500 { error: 'Internal error' }` with no stack trace.
- Google Sheets append uses `valueInputOption=RAW` and the export writes plain
  string cells, so a message starting with `=` is never evaluated as a formula.
- `/api/raw` masks `sender` with `maskPhone` (the dashboard does not need it in full).
- LLM pass: message text is untrusted input. No tools, output validated against a
  fixed schema, anything else is treated as `null`.
- Logout clears the cookie only. To revoke every session, rotate `SESSION_SECRET`.
- `./auth` gives full access to the WhatsApp account: owner-only file permissions
  on the VPS, encrypted backups.

### Routes
| Method | Path | Purpose |
|---|---|---|
| POST | `/login`, `/logout` | admin session |
| GET | `/api/me` | `{ username }` |
| GET | `/health` | `{ whatsapp: {status, since}, lastMessageAt, perGroup: [{id, name, lastMessageAt, countToday}], counts: {rawToday, bookingsToday, reviewPending, duplicatesToday, outputsPending, outputsFailed}, heartbeat: {minutes, windowStart, windowEnd, quiet, lastAlertAt}, outputs: {sheets, telegram, whatsappSend} }`. `perGroup` falls back to the newest stored raw message after a restart |
| GET | `/export?from=&to=&source=` | streams `.xlsx` of `confirmed` bookings (cursor + streaming writer), `bookings-<from>-<to>.xlsx` (`all` when unset); times in IST |
| POST | `/ingest` | JSON body `{source, rawText, receivedAt}`: `source` 1-100 chars, `rawText` 1-4 000 chars, `receivedAt` ISO-8601 with a time zone, at most 5 min in the future and 7 days in the past (else `400`); runs the same pipeline; returns `{status: confirmed|review|duplicate|ignored, bookingId?, duplicateOf?}`. Optional `clientMessageId` (1-100 chars): a repeat of source + id within 7 days returns the stored answer (`409` while the first is in progress; a key without a result is a request still running: keys of the previous process are freed at start, and a key whose result cannot be stored is deleted). The key's source is trimmed and lower-cased; without `clientMessageId` a request is not idempotent. 60 requests per rolling minute per credential + IP, else `429 {error, retryAfterSec}` |
| GET | `/api/bookings?status=&from=&to=&source=&q=&page=` | paged list (50/page), returns `total`. `q` matches pickup, drop, contact or raw text (case-insensitive); `source` matches the primary source or any folded duplicate's (`otherSources`), here and in `/export` |
| POST | `/api/bookings/:id/confirm` | review -> confirmed; fires outputs once (claims `outputsSentAt` atomically) |
| POST | `/api/bookings/:id/reject` | review -> rejected |
| POST | `/api/bookings/:id/undo` | admin-decided confirmed/rejected -> review (the Undo toast); does not unsend outputs, returns `outputsAlreadySent` |
| GET | `/api/raw?group=&q=&from=&to=&page=` | paged raw messages |
| GET | `/` and static files | dashboard |

Transitions are one conditional `findOneAndUpdate` (expected status in the filter):
wrong state -> `409`, unknown or malformed id -> `404`.
Input validation on every query/body field, bad value -> `400` (dates must be ISO,
enums match, `page` 1-10 000, `q` max 100 chars and regex-escaped, other text
max 200 chars; `/ingest` text capped at 4 000 chars). TLS is terminated by a reverse proxy
(nginx or Caddy) on the VPS; README covers it.

## 9. Jobs
- **Heartbeat** (every 5 min): between 08:00 and 23:00 IST, if no message from
  any target group for `HEARTBEAT_MINUTES` (default 120) -> one Telegram alert,
  then silent until a message arrives (no repeat spam). Last-message time is read
  from `raw_messages`, so a restart does not reset it. The quiet period does not
  count the night: from 08:00 it counts from max(last message, 08:00 IST today).
  Session: WhatsApp status other than `open` for `SESSION_DOWN_ALERT_MINUTES`
  (default 10, counted from the first check that saw it down) -> one alert naming
  the status, and one "back online" alert when it returns. Stop statuses
  (`logged_out`, `replaced`, `blocked`, `needs_link`) alert at once (the connection's `onStop`
  runs a check; checks are serialized, so it is sent once). With Telegram off, alerts are logged once.
  An alert Telegram did not accept is retried at the next check.
- **Retention** (daily, and once at boot): delete `raw_messages` older than
  `RETENTION_DAYS` (default 30, max 3650). `0` disables purging; other values stop
  the service at start with one fatal line naming the variable (any malformed variable does). Logs the deleted count only. Bookings are kept.
- Outputs (`outputs/`): Telegram and Sheets use built-in `fetch` (10 s timeout, one
  retry on 429/5xx; failures logged without URL or token, never thrown). Sheets signs
  the service-account JWT (RS256) with `node:crypto` and caches the token; a 401 drops it, gets a
  new one and retries the append once. Every row ends with the booking id (column K); a retry reads
  that column first (`values.get` on `<tab>!K:K`) and never appends a row that is already there.
- **Outbox** (`jobs/outbox.js`, every 2 min and at boot). Guarantee: every output in `wanted` gets
  the booking, or after 7 days it is given up, logged once and counted (`counts.outputsFailed`); a
  second copy only follows a send with an unknown outcome, and is then labelled (Telegram/WhatsApp:
  first line "Possible repeat ...") or suppressed (Sheets finds its row by the Booking ID column).
  - The single `onConfirmed` (pipeline and dashboard confirm) snapshots `wanted`, counts the attempt,
    then per output: set `sending.<k>` (WhatsApp: in the sender's `onStart`, right before the socket
    call, so a message still queued is not "maybe sent"), send, record `delivered.<k>` (or clear the mark after a clean
    failure; leave it after an unknown outcome) as soon as that output settles. Recording is tried 3
    times with backoff, so a brief MongoDB blip does not become a repeat.
  - The job re-sends, oldest first, 10 per run, only the `wanted` and currently enabled outputs not
    yet delivered on `confirmed` bookings claimed 2 min-7 days ago: the first 5 attempts every run,
    then hourly (`lastAttemptAt`). One error line at the switch to hourly. Each retry re-checks the
    stored row in the same atomic update that counts the attempt, so a stale batch never re-sends;
    bookings being delivered right now are skipped. Retries of Sheets read column K first.
  - Older than 7 days: missing `wanted` outputs get `givenUp`, one error line per output and run.
  - A claim with no `wanted` and `outputAttempts: 0` (the first attempt's update never ran: crash or
    MongoDB error) counts as missing every enabled output: retried, counted pending, expired after 7
    days; the retry takes the snapshot. Bookings without `wanted` but with attempts (from before
    this design) are never retried.
  - `GOOGLE_SHEET_RANGE` must name the tab and start at column A (checked at start), so the id is K.
  - Telegram returns 'unknown' on a timeout/network error and is not retried inside the request;
    the WhatsApp sender returns 'unknown' when `sendMessage` throws. WhatsApp retries use the
    same sender queue. `/health` reports `counts.outputsPending` and `counts.outputsFailed`.

## 10. Logging and privacy
- pino JSON logs; pm2 handles files/rotation.
- A single `maskPhone()` helper: `98xxxxxx10`. Info level never contains full
  numbers, JIDs or message text; debug level may.
- Dashboard and exports show full numbers (behind login). **(call)**

## 11. Environment variables
All documented in `.env.example`.
```
# core
NODE_ENV, PORT=3000, HOST (127.0.0.1 in production, else 0.0.0.0), LOG_LEVEL, MONGODB_URI
# (no TZ variable: IST is hard-coded as UTC+5:30, the TZ env is unreliable on Windows)
# whatsapp
TARGET_GROUP_IDS (comma-separated, 4), PAIRING_PHONE_NUMBER, AUTH_DIR=./auth (outside cloud-synced folders),
WHATSAPP_SEND_ENABLED=false, TARGET_NUMBER, SESSION_DOWN_ALERT_MINUTES=10
# auth
API_TOKEN, SESSION_SECRET (required, >= 32 chars each; the service refuses to start otherwise)
# llm
LLM_ENABLED=false, OPENAI_API_KEY, OPENAI_MODEL, LLM_CONFIRM_THRESHOLD=0.8
# outputs
SHEETS_ENABLED=false, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (path), GOOGLE_SHEET_RANGE=Sheet1!A1,
TELEGRAM_ENABLED=false, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# (Telegram alerts and Sheets rows contain full phone numbers and leave this server)
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
  Replace them with real messages when the owner supplies them.
- Contract checked per sample: a booking scores above `LOW` (never silently
  dropped), a non-booking scores below `HIGH` (never auto-confirmed); each listed
  `expected` field must match `extract()`; each booking sample folds into exactly
  its `duplicateOf` (or nothing) against the earlier booking samples.
- `test/fake-booking.js` is an in-memory Booking model for the dedupe and pipeline tests.

## 13. Build order
| # | Step | Stop? | State |
|---|---|---|---|
| 1 | Connection: pairing login, saved session, reconnect | | Built |
| 2 | `npm run groups` | | Built |
| 3 | Raw capture into `raw_messages` | **Stop. Owner links number, confirms capture, supplies samples** | Built; owner has not linked or supplied samples yet |
| 4 | Detection: scorer, then LLM interface | needs samples | Built with placeholder rules |
| 5 | Extraction into `bookings` | needs samples | Built with placeholder rules |
| 6 | De-duplication | | Built |
| 7 | Outputs: Sheets, Telegram, WhatsApp send | | Built |
| 8 | HTTP API: health, export, ingest | | Built |
| 9 | Heartbeat + retention | | Built |
| 10 | Dashboard: login, Bookings, Review, Raw, Status, Export | | Built |
| 11 | README, `.env.example` final pass | | Done |

"Built" = covered by `npm test` with in-memory fakes. Nothing has run against a real WhatsApp
number, MongoDB, Telegram, Google or OpenAI yet. Rules in `pipeline/rules.js` stay placeholders
until real samples are in `test/samples.json`.

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
