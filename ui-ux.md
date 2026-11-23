# UI/UX: Dashboard

One admin, phone or laptop, watching and exporting. Plain and dense: a tool, not
a showcase. Built with plain HTML/CSS/JS (`frontend/`), no framework, no build.

## Principles
1. **Nothing missed.** New items are obvious; unclear ones are one tap away in Review.
2. **Is it working?** Connection state is visible on every screen.
3. **Dense, readable.** Many bookings per screen; original message always reachable.
4. **Phone and laptop equal.** Same features on both; layout changes, content doesn't.
5. **Read first.** Only two actions exist in the whole app: confirm/reject in
   Review, and Download in Export.

## Structure
```
/login
/            -> Bookings (default)
/#review
/#raw
/#status
/#export
```
Single page after login; tabs switch by URL hash so back/refresh/bookmark work.

### Navigation
- **Laptop (>= 768px):** top bar. Left: app name + connection pill. Middle: tabs
  `Bookings · Review (n) · Raw · Status · Export`. Right: Log out.
- **Phone (< 768px):** top bar holds app name + connection pill + Log out.
  Tabs move to a fixed bottom bar with 5 items (icon + label), 48px min height.
- **Review badge:** count of pending items; hidden when 0.
- **Connection pill** (always visible, tap goes to Status). Colour plus text,
  never colour alone:
  - `● Connected` green
  - `● Reconnecting` amber
  - `● Logged out` red
  - `● Quiet 2h+` amber (heartbeat tripped)

## Screens

### Login
Centered card: username, password, Log in button. Errors inline under the form:
"Wrong username or password" / "Too many attempts, try again in N minutes".
No register, no forgot-password link.

### Bookings (default)
Confirmed bookings, newest received first.

Filter row (sticky under the top bar): date range (default Last 24 hours, so late-night bookings don't vanish at midnight; presets Last 24 hours / Today /
Yesterday / 7 days / custom), source dropdown, search box (matches pickup, drop,
contact, raw text). On phone the filters collapse into one "Filters" button
opening a sheet; active filters show as removable chips.

Laptop: table.
```
Received | Trip time      | Route                     | Car   | Fare  | Contact    | Source
10:42    | 24 Nov, 06:00  | Delhi Airport T3 → Agra   | Sedan | ₹3500 | 9876543210 | Group A +2
```
Phone: one card per booking.
```
┌──────────────────────────────────────┐
│ Delhi Airport T3 → Agra       10:42  │
│ 24 Nov, 06:00 · Sedan · ₹3500        │
│ 9876543210            Group A  +2    │
└──────────────────────────────────────┘
```
- Missing field shows `—`, never blank or "null".
- `+2` = also seen in 2 other sources (duplicates folded in).
- Tap/click a row to expand in place: original message text (monospace,
  wrapping preserved), list of all sources with times, confidence, decided by
  (rules / LLM / admin).
- Contact is plain selectable text (no call/WhatsApp link; acting is a non-goal).
- Times shown in IST. Today shows time only; older shows date + time.
- **Freshness:** list re-fetches every 15 s while the tab is visible (paused when
  hidden). New rows get a highlight that fades after a few seconds, and the page
  title becomes `(3) Bookings` until viewed. If the user has scrolled down, new
  rows are not injected; a "3 new bookings ↑" bar appears instead.
- **Since last visit:** a divider "New since you last looked" sits above the
  first booking that was already there on the previous visit (timestamp kept in
  `localStorage`). This is how overnight bookings get noticed.
- Paging: "Load more" button (50 per page).

### Review
Unclear messages waiting for a decision, oldest first (work the queue top down).

Each item is a card on both phone and laptop (text needs the width):
```
┌──────────────────────────────────────────────┐
│ Group B · 10:15 · confidence 0.55            │
│ ┌──────────────────────────────────────────┐ │
│ │ original message text, in full           │ │
│ └──────────────────────────────────────────┘ │
│ Guess: Jaipur → Delhi · — · Innova · — · 98… │
│ [ It's a booking ]        [ Not a booking ]  │
└──────────────────────────────────────────────┘
```
- "Guess" line shows whatever was extracted, `—` for missing fields.
- Buttons act immediately (no confirm dialog); the card collapses and a toast
  appears for 6 s: "Marked as booking · Undo". Undo returns it to Review.
  Note: undo after "It's a booking" does not unsend alerts already fired; the
  toast says "Undo (alerts already sent)" in that case.
- Buttons are full-width side by side on phone, min 44px tall.
- Empty state: "Nothing to review."

### Raw messages
Every captured text message, newest first. Filters: group, date range, search text.

Row: time · group · sender (masked: `98xxxxxx10`) · text (2 lines, expand on tap).
A small tag on the row when the message produced a booking (`booking` / `review`
/ `rejected`). This screen answers "did the service see this message?".
Empty state when filtered: "No messages match." Empty with no data at all:
"No messages captured yet. Check Status."

### Status
One glance: is capture working?
- Big line: connection state + since when ("Connected since 08:12").
- Table, one row per target group: name · last message time · messages today.
  A group silent for longer than the heartbeat window is marked amber.
- Counts today: raw messages · bookings · pending review · duplicates folded.
- Heartbeat: window (08:00-23:00 IST), threshold minutes, last alert time.
- Outputs: Sheets / Telegram / WhatsApp send, each shown On or Off (read-only).
- When logged out: red panel "WhatsApp session logged out. Capture is stopped.
  Re-link from the server (see README: Re-linking)."

### Export
Form: From date, To date (default: last 7 days), Source (All or one), and a
"Download Excel" button. Below the button: "N bookings match" (live count as the
form changes). Zero matches disables the button. Download uses a normal link to
`/export` so the browser streams the file. Only confirmed bookings are exported.

## States (every list screen)
| State | Behaviour |
|---|---|
| Loading (first) | Skeleton rows, not a spinner |
| Refreshing | Silent; existing rows stay |
| Empty | One plain sentence, as written per screen |
| Fetch error | Inline bar "Couldn't refresh. Retrying…" with last-updated time; old data stays visible |
| Session expired (401) | Redirect to `/login`, return to the same tab after login |

## Visual system
- **Theme:** follows `prefers-color-scheme`; no manual toggle.
- **Type:** system font stack; monospace stack for raw message text.
  Base 15px on laptop, 16px on phone (prevents iOS input zoom). Tabular numerals
  for times, fares, phone numbers.
- **Spacing:** 4px base; table rows 36px, cards 12px padding, page gutter 16px.
- **Colour tokens** (CSS variables, light / dark values):

| Token | Use |
|---|---|
| `--bg`, `--surface`, `--border` | page, cards/table, dividers |
| `--text`, `--text-muted` | primary, secondary text |
| `--accent` | active tab, primary button, links |
| `--ok`, `--warn`, `--danger` | connection pill, status marks |
| `--highlight` | new-row flash |

  One accent colour; status colours are used only for status.
- **No** shadows-as-decoration, gradients, illustrations or animation beyond the
  new-row fade and toast (both disabled under `prefers-reduced-motion`).

## Responsive rules
- Breakpoint: 768px. Below: cards + bottom tabs + filter sheet. Above: tables + top tabs.
- No horizontal page scroll at 360px width. Long place names wrap; they are not truncated in cards.
- Tables never scroll sideways on laptop; the Route column flexes.
- Bottom tab bar respects the phone safe-area inset.

## Accessibility
- Semantic HTML: `<nav>`, `<main>`, real `<table>` with `<th scope>`, `<button>` for actions.
- Everything reachable and operable by keyboard; visible focus ring.
- Text contrast >= 4.5:1 in both themes; status never conveyed by colour alone.
- Tap targets >= 44px on phone.
- New-booking bar and toasts use `aria-live="polite"`.
- Form fields have visible labels (no placeholder-only labels).

## Copy
Plain words, sentence case. Buttons say what happens: "It's a booking",
"Not a booking", "Download Excel", "Log out". Dates as `24 Nov, 06:00`. Money as `₹3500`.

## Out of scope for the dashboard
Editing fields, calling/messaging contacts, assigning or status-tracking
bookings, settings screens, user management, charts.
