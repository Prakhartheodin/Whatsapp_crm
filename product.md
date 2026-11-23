# Product: WhatsApp Booking Collector

## What it is
A small Node.js service that listens (read-only) to 4 WhatsApp groups, picks out
car/taxi booking messages, turns them into structured rows, removes duplicates,
and shows them in one web dashboard with Excel export.

## Why
Bookings are posted free-form (English, Hindi, Hinglish) across 4 busy groups.
Following all four by hand means bookings get missed. The goal is **one clean,
de-duplicated list so no booking is missed.**

## Who uses it
- One admin (the owner), on phone or laptop.
- Single admin account. No registration, no other users, no roles.
- Later: a separate collector (Android emulator screen reader) will push
  messages in through `POST /ingest`. Not built now.

## What the user does
Watch and export. Nothing else.
- Read the live Bookings list.
- Check the Review tab and mark unclear messages "It's a booking" / "Not a booking".
- Search Raw messages to see what was captured.
- Glance at Status to know capture is working.
- Download Excel for a date range.

## Goals
1. Capture every text message from the 4 target groups.
2. Detect bookings and extract: pickup, drop, trip date/time, car type, fare, contact.
3. One row per real booking, even when it is posted in several groups.
4. Unclear messages are never silently dropped; they go to Review.
5. Tell the owner (Telegram) when capture stops working.
6. Keep the linked WhatsApp number safe from bans.

## Non-goals (not in this version)
- Calling, messaging or replying to the poster from the dashboard.
- Assigning bookings to drivers, status tracking (taken/skipped), CRM features.
- Editing extracted fields in the dashboard.
- Multiple users, registration, password reset flows.
- Editing configuration from the dashboard (config lives in `.env`).
- Images, voice notes, documents (only their type is logged).
- The Android collector.
- Price/route analytics.

## Anti-goals (would make it a failure even if it "works")
- The linked number gets banned or restricted because the service behaved like a bot
  (read receipts, presence, bulk fetches, sending).
- A real booking is hidden from the user with no trace (not in Bookings, not in Review).
- The same booking shows up 4 times.
- Full phone numbers end up in log files.
- The service silently stops capturing and nobody is told.

## Success looks like
- After linking, messages from the 4 groups appear in Raw messages within seconds.
- A booking posted in 3 groups shows once, with the 3 sources listed on it.
- The owner can leave it running on the VPS for weeks; a logout or silence
  produces a Telegram alert, not a crash loop.

## Outputs (each toggled by env)
- Web dashboard (always on)
- Excel export
- Google Sheets append
- Telegram alert
- WhatsApp send to one target number (off by default, strict limits)

## Privacy
- Phone numbers are personal data: masked in logs at info level, shown in full
  only inside the logged-in dashboard and in exports.
- Raw messages older than `RETENTION_DAYS` are purged.

## Delivery order
Steps 1-3 (connection, `npm run groups`, raw capture) are built first, then work
stops so the owner can link the number and confirm capture. Detection rules
depend on real message samples supplied by the owner. Full order is in `design.md`.
