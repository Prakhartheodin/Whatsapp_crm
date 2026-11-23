import { api, qs } from './api.js'
import {
  DASH, dash, fmtWhen, fmtFare, sourceLabel, istToday, addDays, dayRange, presetRange, quietLabel, isDay, PRESETS, istDayChanged,
  isGroupQuiet, outputsNote,
} from './format.js'

const POLL_MS = 15000
const FRESH_MS = 4000
const SCREENS = { bookings: 'Bookings', review: 'Review', raw: 'Raw messages', status: 'Status', export: 'Export' }
const DECIDED = { rules: 'Rules', llm: 'LLM', admin: 'Admin' }
const TAG = { confirmed: 'booking', review: 'review', rejected: 'rejected' }
const $ = (sel, root = document) => root.querySelector(sel)

// The only way server values reach the DOM: text nodes and attributes, never HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (v === true) node.setAttribute(k, '')
    else if (v != null && v !== false) node.setAttribute(k, v)
  }
  node.append(...children.filter((c) => c != null && c !== false))
  return node
}
// A run of values separated by spacing (no joining dots).
const run = (tag, cls, values) => el(tag, { class: `run ${cls}` }, ...values.map((v) => el('span', { text: v })))

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) } catch { return fallback }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode or full: the setting just isn't kept */ }
  },
}

const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

function errorBar(section, failed, lastOk) {
  const bar = $('.error-bar', section)
  bar.hidden = !failed
  if (failed) bar.textContent = lastOk ? `Couldn't refresh. Retrying… Last updated ${fmtWhen(lastOk)}.` : "Couldn't load. Retrying…"
}

// ---------- Health: pill, review badge, filter options, Status screen ----------
let health = null
let healthOk = null

// WhatsApp connection states. `panel` marks the "capture is stopped" states shown on Status.
const WA_STATES = {
  connecting: { tone: 'warn', text: 'Connecting' },
  open: { tone: 'ok', text: 'Connected' },
  reconnecting: { tone: 'warn', text: 'Reconnecting' },
  logged_out: { tone: 'danger', text: 'Logged out', panel: 'WhatsApp session logged out. Capture is stopped. Re-link from the server (see README: Re-link after a logout).' },
  needs_link: { tone: 'danger', text: 'Not linked', panel: 'No WhatsApp session on the server. Capture is stopped. Link the number from a terminal (see README: Link the WhatsApp number).' },
  replaced: { tone: 'danger', text: 'Session taken over', panel: 'Another process or device took over this WhatsApp session. Capture is stopped. Stop the other one and restart the service; no re-link needed (see README: What each stop status means).' },
  blocked: { tone: 'danger', text: 'Account restricted', panel: 'WhatsApp restricted this account. Capture is stopped. Do not re-link; check WhatsApp on the phone (see README: What each stop status means).' },
}
// Unknown values show the raw status in warn, never a guessed label.
const waState = (h) => (Object.hasOwn(WA_STATES, h.whatsapp?.status) ? WA_STATES[h.whatsapp.status] : { tone: 'warn', text: dash(h.whatsapp?.status) })

function connection(h) {
  const s = waState(h)
  if (h.whatsapp?.status === 'open' && h.heartbeat?.quiet) return { tone: 'warn', text: quietLabel(h.heartbeat.minutes) }
  return s
}

// The pill is aria-live: only touch it when the state really changes, so it is announced once.
function setPill({ tone, text }) {
  const pill = $('#pill')
  const label = $('#pill-text')
  if (label.textContent === text && pill.dataset.tone === tone) return
  pill.dataset.tone = tone
  label.textContent = text
}

async function loadHealth() {
  try {
    health = await api('/health')
    healthOk = new Date().toISOString()
  } catch {
    errorBar($('#screen-status'), true, healthOk)
    setPill({ tone: 'warn', text: 'No server' }) // never keep showing "Connected" while unreachable
    return
  }
  errorBar($('#screen-status'), false)
  setPill(connection(health))
  setBadge(health.counts?.reviewPending || 0)
  const groups = health.perGroup || []
  const sources = [...groups.map((g) => [`whatsapp:${g.name}`, g.name]), ['app', 'App']]
  for (const sel of document.querySelectorAll('select[name="source"]')) setOptions(sel, sources)
  setOptions($('#raw-filters').group, groups.map((g) => [g.id, g.name]))
  bookings.dropStaleOption()
  raw.dropStaleOption()
  if (current === 'status') renderStatus()
}

let pendingCount = 0
function setBadge(n) {
  pendingCount = n
  const badge = $('#review-badge')
  badge.hidden = n <= 0
  badge.replaceChildren(String(n), el('span', { class: 'sr-only', text: ' pending' }))
}

// Rebuild only when the list changed, so an open dropdown is not disturbed every poll.
function setOptions(select, pairs) {
  const key = JSON.stringify(pairs)
  if (select.dataset.key === key) return
  select.dataset.key = key
  const want = select.dataset.want ?? select.value
  select.replaceChildren(select.options[0], ...pairs.map(([value, label]) => el('option', { value, text: label })))
  select.value = want
  if (select.selectedIndex < 0) select.value = ''
}

function renderStatus() {
  const body = $('#status-body')
  if (!health) { body.replaceChildren(el('p', { class: 'empty', text: 'Waiting for the server…' })); return }
  const h = health
  const state = waState(h)
  const hb = h.heartbeat || {}
  const groupRow = (g) => {
    const quiet = isGroupQuiet(g.lastMessageAt, hb.minutes, hb.windowStart, hb.windowEnd)
    return el('tr', { class: quiet ? 'quiet' : null },
      el('th', { scope: 'row', text: dash(g.name) }),
      el('td', { text: fmtWhen(g.lastMessageAt) }, quiet ? el('span', { class: 'tag', text: 'Quiet' }) : null),
      el('td', { text: dash(g.countToday) }))
  }
  const count = (label, v) => el('div', {}, el('dt', { text: label }), el('dd', { text: dash(v) }))
  const out = (label, on) => el('div', {}, el('dt', { text: label }), el('dd', { text: on ? 'On' : 'Off' }))
  const c = h.counts || {}
  const o = h.outputs || {}
  body.replaceChildren(...[
    el('p', { class: 'status-line', 'data-tone': state.tone, text: `${state.text} since ${fmtWhen(h.whatsapp?.since)}` }),
    state.panel ? el('p', { class: 'panel-danger', text: state.panel }) : null,
    el('div', {}, el('h2', { text: 'Groups' }),
      el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col', text: 'Group' }), el('th', { scope: 'col', text: 'Last message' }), el('th', { scope: 'col', text: 'Messages today' }))),
        el('tbody', {}, ...(h.perGroup || []).map(groupRow)))),
    el('div', {}, el('h2', { text: 'Today' }),
      el('dl', { class: 'counts' },
        count('Raw messages', c.rawToday), count('Bookings', c.bookingsToday),
        count('Pending review', c.reviewPending), count('Duplicates folded', c.duplicatesToday))),
    el('div', {}, el('h2', { text: 'Heartbeat' }),
      run('p', 'hb', [
        `Window ${dash(hb.windowStart)}-${dash(hb.windowEnd)} IST`,
        `Alert after ${dash(hb.minutes)} min of silence`,
        `Last alert ${hb.lastAlertAt ? fmtWhen(hb.lastAlertAt) : 'never'}`,
        hb.quiet ? quietLabel(hb.minutes) : 'Messages arriving',
      ])),
    el('div', {}, el('h2', { text: 'Outputs' }),
      el('dl', { class: 'counts' }, out('Sheets', o.sheets), out('Telegram', o.telegram), out('WhatsApp send', o.whatsappSend)),
      ...outputsNote(c).map((line) => el('p', { class: line.endsWith('failed') ? 'out-note out-failed' : 'out-note', text: line }))),
    el('p', { class: 'updated', text: `Updated ${fmtWhen(healthOk)}` }),
  ].filter(Boolean))
}

// ---------- Feeds: Bookings and Raw share filters, paging, polling and new-item handling ----------
let unseen = 0
// Newest booking time the owner has seen: from the last visit, then from each time the tab was hidden.
let seenMark = store.get('lastSeen', null)
if (typeof seenMark !== 'string') seenMark = null

function feed(cfg) {
  const section = $(`#screen-${cfg.name}`)
  const list = $('.list', section)
  const form = $('.filter-form', section)
  const toggle = $('.filters-toggle', section)
  const chips = $('.chips', section)
  const newBar = $('.new-bar', section)
  const more = $('.load-more', section)
  const empty = $('.empty', section)
  const defaults = { preset: cfg.preset, fromDay: '', toDay: '', [cfg.field]: '', q: '' }
  // Saved filters are untrusted (old versions, hand edits): keep only values the form can express.
  const saved = store.get(`filters:${cfg.name}`, {}) || {}
  const ok = {
    preset: (v) => [...form.preset.options].some((o) => o.value === v) && (v === 'all' || v === 'custom' || PRESETS.includes(v)),
    fromDay: isDay, toDay: isDay,
    [cfg.field]: (v) => typeof v === 'string' && v.length <= 200,
    q: (v) => typeof v === 'string' && v.length <= 100,
  }
  const filters = Object.fromEntries(Object.keys(defaults).map((k) => [k, ok[k](saved[k]) ? saved[k] : defaults[k]]))
  let ids = new Set()
  let pending = []
  let page = 1
  let total = 0
  let loaded = false
  let lastOk = null
  let gen = 0
  let newest = null
  let failedOnce = false

  function range() {
    if (filters.preset === 'all') return {}
    if (filters.preset !== 'custom') return presetRange(filters.preset)
    return dayRange(filters.fromDay, filters.toDay)
  }
  const url = (p) => `${cfg.url}?${qs({ ...range(), [cfg.field]: filters[cfg.field], q: filters.q.trim(), page: p })}`
  const isFiltered = () => Object.keys(defaults).some((k) => filters[k] !== defaults[k])

  function add(items, where) {
    const nodes = items.filter((i) => !ids.has(i.id)).map((i) => {
      ids.add(i.id)
      // Only an unfiltered list says what the owner has seen (a filter would mark an older point).
      if (!isFiltered() && (!newest || i[cfg.timeField] > newest)) newest = i[cfg.timeField]
      return cfg.render(i)
    })
    if (where === 'top') list.prepend(...nodes)
    else list.append(...nodes)
    return nodes
  }

  function update() {
    const shown = ids.size
    empty.hidden = !(loaded && shown === 0 && pending.length === 0)
    empty.textContent = cfg.emptyText(isFiltered())
    more.hidden = !loaded || shown + pending.length >= total
    newBar.hidden = pending.length === 0
    newBar.textContent = `${pending.length} new ${cfg.noun(pending.length)} ↑`
    list.removeAttribute('aria-busy')
  }

  const loadedOk = () => { lastOk = new Date().toISOString(); errorBar(section, false) }
  const fail = () => errorBar(section, true, lastOk)

  const hasMore = () => ids.size + pending.length < total

  // `silent`: a retry after a failed first load keeps the error bar and skips the skeleton flash.
  async function reset(silent = false) {
    const my = ++gen
    ids = new Set(); pending = []; page = 1; loaded = false
    if (!silent) {
      list.setAttribute('aria-busy', 'true')
      list.replaceChildren(...Array.from({ length: 6 }, cfg.skeleton))
      empty.hidden = true; more.hidden = true; newBar.hidden = true
    }
    try {
      const data = await api(url(1))
      if (my !== gen) return
      list.replaceChildren()
      total = data.total
      add(data.items, 'bottom')
      loaded = true
      failedOnce = false
      loadedOk()
      cfg.afterLoad?.(list, hasMore())
    } catch {
      if (my !== gen) return
      list.replaceChildren()
      failedOnce = true
      fail()
    }
    update()
  }

  async function refresh() {
    if (!loaded) return reset(failedOnce)
    const my = gen
    try {
      const data = await api(url(1))
      if (my !== gen) return
      loadedOk()
      total = data.total
      const fresh = data.items.filter((i) => !ids.has(i.id) && !pending.some((p) => p.id === i.id))
      if (fresh.length) {
        if (cfg.name === 'bookings' && (window.scrollY > 120 || !document.hasFocus())) { unseen += fresh.length; updateTitle() }
        // A whole page of new items may hide more beyond it (a long hidden tab): reload in order.
        if (fresh.length === data.items.length && data.items.length >= data.pageSize) return reset()
        if (window.scrollY > 120) pending = [...fresh, ...pending]
        else { inject([...fresh, ...pending]); pending = [] }
      }
      cfg.afterLoad?.(list, hasMore())
    } catch {
      if (my === gen) fail()
    }
    update()
  }

  function inject(items) {
    for (const node of add(items, 'top')) {
      node.classList.add('fresh')
      setTimeout(() => node.classList.remove('fresh'), FRESH_MS)
    }
  }

  newBar.addEventListener('click', () => {
    inject(pending)
    pending = []
    unseen = 0
    updateTitle()
    update()
    window.scrollTo({ top: 0 })
    list.firstElementChild?.querySelector('button')?.focus({ preventScroll: true })
  })

  more.addEventListener('click', async () => {
    const my = gen
    more.disabled = true
    try {
      const data = await api(url(page + 1))
      if (my !== gen) return // filters changed meanwhile: these rows belong to the old list
      page += 1
      total = data.total
      add(data.items, 'bottom')
      loadedOk()
      cfg.afterLoad?.(list, hasMore())
    } catch {
      if (my === gen) fail()
    } finally {
      more.disabled = false
    }
    update()
  })

  // Filters
  function syncForm() {
    for (const k of Object.keys(defaults)) {
      form[k].value = filters[k]
      if (form[k].tagName === 'SELECT') form[k].dataset.want = filters[k]
    }
    section.classList.toggle('custom', filters.preset === 'custom')
    const active = []
    if (filters.preset !== defaults.preset) {
      const label = filters.preset === 'custom'
        ? `${filters.fromDay || 'Any'} to ${filters.toDay || 'any'}`
        : form.preset.selectedOptions[0]?.textContent
      active.push(['preset', label])
    }
    if (filters[cfg.field]) active.push([cfg.field, form[cfg.field].selectedOptions[0]?.textContent || filters[cfg.field]])
    if (filters.q) active.push(['q', `Search: ${filters.q}`])
    chips.replaceChildren(...active.map(([k, label]) => el('li', {},
      el('button', { type: 'button', 'aria-label': `Remove filter: ${label}`, onclick: () => clearFilter(k) },
        el('span', { text: label }), el('span', { 'aria-hidden': 'true', text: '×' })))))
    toggle.textContent = active.length ? `Filters (${active.length})` : 'Filters'
  }

  function clearFilter(k) {
    filters[k] = defaults[k]
    if (k === 'preset') { filters.fromDay = ''; filters.toDay = '' }
    changed()
    toggle.focus()
  }

  function changed() {
    store.set(`filters:${cfg.name}`, filters)
    syncForm()
    reset()
  }

  form.addEventListener('submit', (e) => e.preventDefault())
  form.addEventListener('input', debounce(() => {
    for (const k of Object.keys(defaults)) filters[k] = form[k].value
    if (filters.preset === 'custom' && !filters.fromDay && !filters.toDay) filters.fromDay = filters.toDay = istToday()
    changed()
  }))

  // Phone: the form becomes a bottom sheet.
  // While the sheet is open everything else is inert, so Tab stays inside the sheet.
  const outside = () => [$('.topbar'), toggle, chips, ...[...section.children].filter((c) => !c.contains(form))]
  const setSheet = (open) => {
    section.classList.toggle('sheet-open', open)
    toggle.setAttribute('aria-expanded', String(open))
    for (const n of outside()) n.inert = open
    if (open) form.preset.focus()
    else toggle.focus()
  }
  toggle.addEventListener('click', () => setSheet(!section.classList.contains('sheet-open')))
  $('.sheet-done', section).addEventListener('click', () => setSheet(false))
  $('.scrim', section).addEventListener('click', () => setSheet(false))
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && section.classList.contains('sheet-open')) setSheet(false) })

  // After /health fills the dropdown: a saved source/group that no longer exists is dropped.
  function dropStaleOption() {
    const sel = form[cfg.field]
    if (filters[cfg.field] && sel.options.length > 1 && sel.value !== filters[cfg.field]) {
      filters[cfg.field] = ''
      changed()
    }
  }

  syncForm()
  return {
    show: () => (loaded ? refresh() : reset()),
    refresh,
    newest: () => newest,
    syncForm,
    dropStaleOption,
    // The next show/refresh reloads from scratch (rows rendered on an earlier IST day).
    invalidate: () => { gen += 1; loaded = false },
  }
}

function skeletonRow() {
  return el('tr', { class: 'skeleton', 'aria-hidden': 'true' },
    ...['recv', 'trip', 'route', 'car', 'fare', 'contact', 'src'].map((c) => el('td', { class: `c-${c}` }, el('span', { class: 'bone' }))))
}

function bookingRow(b) {
  const others = b.otherSources?.length || 0
  const button = el('button', { type: 'button', class: 'row-toggle', 'aria-expanded': 'false' }, `${dash(b.pickup)} → ${dash(b.drop)}`)
  const tr = el('tr', { 'data-id': b.id, 'data-at': b.receivedAt },
    el('td', { class: 'c-recv', text: fmtWhen(b.receivedAt) }),
    el('td', { class: 'c-trip', text: fmtWhen(b.tripDateTime) }),
    el('td', { class: 'c-route' }, button),
    el('td', { class: 'c-car', text: dash(b.carType) }),
    el('td', { class: 'c-fare', text: fmtFare(b.fare) }),
    el('td', { class: 'c-contact', text: dash(b.contact) }),
    el('td', { class: 'c-src' }, sourceLabel(b.source),
      others ? el('span', { class: 'more' }, `+${others}`, el('span', { class: 'sr-only', text: ` other source${others === 1 ? '' : 's'}` })) : null))
  tr.addEventListener('click', () => {
    if (getSelection().toString()) return // let the contact be selected without toggling
    const open = button.getAttribute('aria-expanded') !== 'true'
    button.setAttribute('aria-expanded', String(open))
    tr.classList.toggle('open', open)
    if (open) tr.after(el('tr', { class: 'detail' }, el('td', { colspan: '7' }, bookingDetail(b))))
    else if (tr.nextElementSibling?.classList.contains('detail')) tr.nextElementSibling.remove()
  })
  return tr
}

function bookingDetail(b) {
  const sources = [{ source: b.source, receivedAt: b.receivedAt }, ...(b.otherSources || [])]
  return el('div', { class: 'detail-body' },
    el('pre', { class: 'msg', text: b.rawText || DASH }),
    el('dl', { class: 'facts' },
      el('dt', { text: 'Sources' }),
      el('dd', {}, el('ul', {}, ...sources.map((s) => el('li', {}, el('span', { text: sourceLabel(s.source) }), el('span', { text: fmtWhen(s.receivedAt) }))))),
      el('dt', { text: 'Confidence' }),
      el('dd', { text: b.confidence == null ? DASH : Number(b.confidence).toFixed(2) }),
      el('dt', { text: 'Decided by' }),
      el('dd', { text: DECIDED[b.decidedBy] || dash(b.decidedBy) })))
}

function rawRow(m) {
  const head = el('button', { type: 'button', class: 'raw-head run', 'aria-expanded': 'false' },
    el('span', { text: fmtWhen(m.timestamp) }),
    el('span', { class: 'group', text: dash(m.groupName) }),
    el('span', { text: dash(m.sender) }),
    m.bookingStatus ? el('span', { class: `tag tag-${m.bookingStatus}`, text: TAG[m.bookingStatus] || m.bookingStatus }) : null)
  const li = el('li', { 'data-id': m.id }, head, el('p', { class: 'raw-text', text: m.text || DASH }))
  li.addEventListener('click', () => {
    if (getSelection().toString()) return
    const open = !li.classList.contains('open')
    li.classList.toggle('open', open)
    head.setAttribute('aria-expanded', String(open))
  })
  return li
}

const bookings = feed({
  name: 'bookings', url: '/api/bookings', field: 'source', preset: 'last24', timeField: 'receivedAt',
  render: bookingRow, skeleton: skeletonRow,
  noun: (n) => (n === 1 ? 'booking' : 'bookings'),
  emptyText: () => 'No bookings match these filters.',
  // Placed after every load and refresh, so it also appears for a tab left open overnight.
  afterLoad(list, more) {
    list.querySelector('tr.divider')?.remove()
    if (!seenMark) return
    const rows = [...list.querySelectorAll('tr[data-id]')]
    const i = rows.findIndex((r) => r.dataset.at <= seenMark)
    const divider = (text) => el('tr', { class: 'divider' }, el('td', { colspan: '7', text }))
    if (i > 0) rows[i].before(divider('New since you last looked'))
    // Every row shown is new and more exist: say so, so the gap is not mistaken for the end.
    else if (i === -1 && rows.length && more) rows.at(-1).after(divider('All of these are new since you last looked. Load more to reach the rest.'))
  },
})

const raw = feed({
  name: 'raw', url: '/api/raw', field: 'group', preset: 'all', timeField: 'timestamp',
  render: rawRow,
  skeleton: () => el('li', { 'aria-hidden': 'true', class: 'skeleton' }, el('span', { class: 'bone' }), el('span', { class: 'bone' })),
  noun: (n) => (n === 1 ? 'message' : 'messages'),
  emptyText: (filtered) => (filtered ? 'No messages match.' : 'No messages captured yet. Check Status.'),
})

function saveLastSeen() {
  const n = bookings.newest()
  if (n && (!seenMark || n > seenMark)) seenMark = n
  if (seenMark && seenMark > (store.get('lastSeen', '') || '')) store.set('lastSeen', seenMark)
}

// ---------- Review ----------
const reviewSection = $('#screen-review')
const reviewList = $('.review-list', reviewSection)
let reviewKey = ''
let reviewOk = null
let reviewLoaded = false
let reviewDecisions = 0 // bumped on every decision; a list fetched before it is stale

const alertsOn = () => Boolean(health?.outputs && (health.outputs.telegram || health.outputs.sheets || health.outputs.whatsappSend))

let reviewTotal = 0
const reviewMore = $('.load-more', reviewSection)
const reviewUrl = (p) => `/api/bookings?${qs({ status: 'review', page: p })}`
const reviewCards = () => [...reviewList.querySelectorAll('.review-card[data-id]')]

function updateReviewMeta() {
  const shown = reviewCards().length
  $('.empty', reviewSection).hidden = !reviewLoaded || shown > 0
  reviewMore.hidden = !reviewLoaded || shown >= reviewTotal
  const note = $('.note', reviewSection)
  note.hidden = reviewMore.hidden
  note.textContent = `Showing the oldest ${shown} of ${reviewTotal}.`
  reviewKey = reviewCards().map((c) => c.dataset.id).join()
}

// Polls re-read every page already revealed (Load more), so nothing the owner opened disappears.
async function loadReview() {
  if (!reviewLoaded) {
    reviewList.setAttribute('aria-busy', 'true')
    reviewList.replaceChildren(...Array.from({ length: 3 }, () => el('div', { class: 'review-card skeleton', 'aria-hidden': 'true' },
      el('span', { class: 'bone' }), el('span', { class: 'bone' }), el('span', { class: 'bone' }))))
  }
  const started = reviewDecisions
  const pages = Math.max(1, Math.ceil(reviewCards().length / 50))
  const items = new Map()
  let total = 0
  try {
    for (let p = 1; p <= pages; p += 1) {
      const data = await api(reviewUrl(p))
      for (const i of data.items) items.set(i.id, i)
      total = data.total
      if (data.items.length < data.pageSize) break
    }
  } catch {
    if (!reviewLoaded) reviewList.replaceChildren()
    errorBar(reviewSection, true, reviewOk)
    return
  }
  if (started !== reviewDecisions) return // a decision landed meanwhile; this list may still hold that card
  reviewOk = new Date().toISOString()
  errorBar(reviewSection, false)
  reviewList.removeAttribute('aria-busy')
  reviewTotal = total
  const key = [...items.keys()].join()
  if (!reviewLoaded || key !== reviewKey) {
    // Keep keyboard focus on the same card's same button across the re-render.
    const active = document.activeElement
    const focusId = reviewList.contains(active) ? active.closest('.review-card')?.dataset.id : null
    const wasPrimary = active?.classList?.contains('primary')
    reviewList.replaceChildren(...[...items.values()].map(reviewCard))
    if (focusId) {
      const card = reviewCards().find((c) => c.dataset.id === focusId)
      ;(card?.querySelector(wasPrimary ? '.primary' : 'button:not(.primary)') || $('#h-review')).focus()
    }
  }
  reviewLoaded = true
  updateReviewMeta()
}

reviewMore.addEventListener('click', async () => {
  const started = reviewDecisions
  const shown = reviewCards()
  reviewMore.disabled = true
  try {
    // Decisions shift offsets, so ask for the page holding the next unseen item and skip ones already shown.
    const data = await api(reviewUrl(Math.floor(shown.length / 50) + 1))
    if (started !== reviewDecisions) return
    const have = new Set(shown.map((c) => c.dataset.id))
    reviewList.append(...data.items.filter((i) => !have.has(i.id)).map(reviewCard))
    reviewTotal = data.total
    errorBar(reviewSection, false)
  } catch {
    errorBar(reviewSection, true, reviewOk)
  } finally {
    reviewMore.disabled = false
    updateReviewMeta()
  }
})

function reviewCard(b) {
  const error = el('p', { class: 'form-error' })
  const confirm = el('button', { type: 'button', class: 'primary', text: "It's a booking" })
  const reject = el('button', { type: 'button', text: 'Not a booking' })
  const card = el('article', { class: 'review-card', 'data-id': b.id, 'aria-label': `Message from ${sourceLabel(b.source)}` },
    run('p', 'meta', [sourceLabel(b.source), fmtWhen(b.receivedAt), `confidence ${b.confidence == null ? DASH : Number(b.confidence).toFixed(2)}`]),
    el('pre', { class: 'msg', text: b.rawText || DASH }),
    el('dl', { class: 'guess run' },
      el('dt', { text: 'Guess' }),
      ...[`${dash(b.pickup)} → ${dash(b.drop)}`, fmtWhen(b.tripDateTime), dash(b.carType), fmtFare(b.fare), dash(b.contact)]
        .map((v) => el('dd', { text: v }))),
    error,
    el('div', { class: 'actions' }, confirm, reject))

  function removeCard() {
    const next = card.nextElementSibling || card.previousElementSibling
    card.remove()
    reviewTotal = Math.max(0, reviewTotal - 1)
    updateReviewMeta()
    setBadge(Math.max(0, pendingCount - 1))
    return next?.querySelector('button') || $('#h-review')
  }

  async function decide(action) {
    reviewDecisions += 1
    confirm.disabled = reject.disabled = true
    error.textContent = ''
    try {
      await api(`/api/bookings/${encodeURIComponent(b.id)}/${action}`, { method: 'POST', body: {} })
    } catch (e) {
      if (e.status === 409) { // decided elsewhere: the card is out of date either way
        removeCard().focus()
        showToast('Already decided elsewhere. Removed from Review.')
        return
      }
      error.textContent = `Couldn't save: ${e.message}`
      confirm.disabled = reject.disabled = false
      return
    }
    const focusBack = removeCard()
    const confirmed = action === 'confirm'
    showToast(confirmed ? 'Marked as booking' : 'Marked as not a booking',
      confirmed && alertsOn() ? 'Undo (alerts already sent)' : 'Undo',
      async () => {
        reviewDecisions += 1
        try {
          await api(`/api/bookings/${encodeURIComponent(b.id)}/undo`, { method: 'POST', body: {} })
          showToast('Moved back to Review')
        } catch (e) {
          showToast(`Couldn't undo: ${e.message}`)
        }
        loadReview()
        loadHealth() // the badge counts from /health
      },
      focusBack)
  }
  confirm.addEventListener('click', () => decide('confirm'))
  reject.addEventListener('click', () => decide('reject'))
  return card
}

// ---------- Toast ----------
let toastTimer
// `focusBack`: where focus goes when the toast closes while focused (the next card's button).
function showToast(message, actionLabel, onAction, focusBack) {
  const region = $('#toast-region')
  clearTimeout(toastTimer)
  const close = () => {
    const hadFocus = box.contains(document.activeElement)
    box.remove()
    if (hadFocus && focusBack?.isConnected) focusBack.focus()
  }
  const button = actionLabel ? el('button', { type: 'button', text: actionLabel, onclick: () => { close(); onAction() } }) : null
  const box = el('div', { class: 'toast' }, el('span', { text: message }), button)
  region.replaceChildren(box)
  // The acted-on button is gone: put focus on Undo, unless the owner is typing in a field.
  const typing = document.activeElement?.matches?.('input, textarea, select, [contenteditable]')
  if (button && focusBack && !typing) button.focus()
  // Stays while hovered or focused, so Undo can't vanish under the pointer or keyboard.
  const hide = () => { if (box.matches(':hover, :focus-within')) toastTimer = setTimeout(hide, 1000); else close() }
  toastTimer = setTimeout(hide, 6000)
}

// ---------- Export ----------
const exportForm = $('#export-form')
const exportLink = $('#export-link')
const exportCount = $('#export-count')
let exportGen = 0
exportForm.fromDay.value = addDays(istToday(), -6)
exportForm.toDay.value = istToday()

function setExportEnabled(on, href) {
  if (on) { exportLink.href = href; exportLink.removeAttribute('aria-disabled') } else { exportLink.removeAttribute('href'); exportLink.setAttribute('aria-disabled', 'true') }
}

async function countExport() {
  const my = ++exportGen
  const { fromDay, toDay, source } = exportForm
  if (!fromDay.value || !toDay.value || fromDay.value > toDay.value) {
    setExportEnabled(false)
    exportCount.textContent = 'Choose a From date on or before the To date.'
    return
  }
  const query = qs({ ...dayRange(fromDay.value, toDay.value), source: source.value })
  exportCount.textContent = 'Counting…'
  try {
    const { total } = await api(`/api/bookings?${query}&page=1`)
    if (my !== exportGen) return
    exportCount.textContent = total === 1 ? '1 booking matches' : `${total} bookings match`
    setExportEnabled(total > 0, `/export?${query}`)
  } catch {
    if (my !== exportGen) return
    exportCount.textContent = "Couldn't count bookings. You can still try the download."
    setExportEnabled(true, `/export?${query}`)
  }
}
exportForm.addEventListener('input', debounce(countExport))
exportForm.addEventListener('submit', (e) => e.preventDefault())
// A plain link would show raw JSON on an expired session; check it first (api() sends a 401 to /login).
exportLink.addEventListener('click', async (e) => {
  if (!exportLink.getAttribute('href')) return
  e.preventDefault()
  const href = exportLink.href
  try {
    await api('/api/me')
  } catch (err) {
    if (err.status !== undefined) exportCount.textContent = `Couldn't start the download: ${err.message}`
    else if (err.message !== 'Session expired') exportCount.textContent = "Couldn't reach the server. Try again."
    return
  }
  location.assign(href)
})
// role="button" on a link: Space should activate it too.
exportLink.addEventListener('keydown', (e) => { if (e.key === ' ' && exportLink.href) { e.preventDefault(); exportLink.click() } })

// ---------- Routing and polling ----------
const screens = {
  bookings: { show: bookings.show, refresh: bookings.refresh },
  review: { show: loadReview, refresh: loadReview },
  raw: { show: raw.show, refresh: raw.refresh },
  // Show what is cached at once, then fetch fresh (a stop status must not wait for the next poll).
  status: { show: () => { renderStatus(); return loadHealth() } },
  export: { show: countExport },
}
let current = null

function updateTitle() {
  document.title = `${unseen && current === 'bookings' ? `(${unseen}) ` : ''}${SCREENS[current] || 'Bookings'}`
}

function route(moveFocus) {
  const hash = location.hash.slice(1)
  const name = Object.hasOwn(SCREENS, hash) ? hash : 'bookings'
  current = name
  for (const id of Object.keys(SCREENS)) $(`#screen-${id}`).hidden = id !== name
  for (const a of document.querySelectorAll('[data-tab]')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  updateTitle()
  screens[name].show()
  if (moveFocus) $(`#h-${name}`).focus()
}

let ticking = false
let renderedDay = istToday()
async function tick() {
  if (document.hidden || ticking) return
  ticking = true
  // Past IST midnight "today shows time only" and the date presets mean another day: reload the lists.
  if (istDayChanged(renderedDay)) {
    renderedDay = istToday()
    bookings.invalidate()
    raw.invalidate()
    reviewKey = ''
  }
  try { await Promise.all([loadHealth(), screens[current].refresh?.()]) } finally { ticking = false }
}

window.addEventListener('hashchange', () => route(true))
window.addEventListener('focus', () => { if (window.scrollY <= 120 && unseen) { unseen = 0; updateTitle() } })
// Hidden: remember what was seen. Visible again: refresh, which also moves the divider to that point.
document.addEventListener('visibilitychange', () => (document.hidden ? saveLastSeen() : tick()))
window.addEventListener('pagehide', saveLastSeen)
setInterval(tick, POLL_MS)

$('#logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST', body: {} }) } catch { /* going to the login page either way */ }
  location.assign('/login')
})

await loadHealth()
bookings.syncForm()
raw.syncForm()
route(false)
