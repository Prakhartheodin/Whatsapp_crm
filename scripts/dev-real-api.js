// DEV / TEST ONLY. Runs the REAL backend app (createApp from backend/http/server.js: real routes,
// real auth, real validation, real .xlsx export) on in-memory stand-ins for MongoDB, seeded with
// MADE-UP data. No MongoDB, no WhatsApp, nothing is sent anywhere. Bound to 127.0.0.1 only.
//   node scripts/dev-real-api.js          -> http://localhost:4020  login: admin / admin-password-123
//   DEV_WA_STATUS=logged_out node scripts/dev-real-api.js   (any whatsapp.status value)
// Also importable: `const { server, state } = await start({ port })`, then change state.whatsapp.status.
import { fileURLToPath } from 'node:url'
import { createApp } from '../backend/http/server.js'
import { hashPassword } from '../backend/auth/password.js'

// ---- in-memory model: the same operator subset the routes use (copied from test/http.test.js) ----
const get = (o, path) => path.split('.').reduce((v, k) => (Array.isArray(v) ? v.map((x) => x?.[k]) : v?.[k]), o)
const OPS = {
  $gte: (v, x) => v >= x,
  $lte: (v, x) => v <= x,
  $lt: (v, x) => v < x,
  $ne: (v, x) => String(v) !== String(x),
  $in: (v, x) => x.map(String).includes(String(v)),
  $regex: (v, x, c) => new RegExp(x, c.$options).test(v),
  $options: () => true,
}
const one = (v, c) => {
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    return v != null && Object.entries(c).every(([op, x]) => {
      if (!OPS[op]) throw new Error(`dev-real-api fake: unsupported operator ${op}`) // never fake a pass
      return OPS[op](v, x, c)
    })
  }
  return c === null ? v == null : String(v) === String(c)
}
const match = (d, f) => Object.entries(f).every(([k, c]) => {
  if ((k === '$or' || k === '$and') && !c.length) throw new Error(`${k} must be a nonempty array`) // as MongoDB
  if (k === '$or') return c.some((sub) => match(d, sub))
  if (k === '$and') return c.every((sub) => match(d, sub))
  if (k.startsWith('$')) throw new Error(`dev-real-api fake: unsupported operator ${k}`)
  const v = get(d, k)
  return Array.isArray(v) ? v.some((e) => one(e, c)) : one(v, c)
})
function query(rows, single = false) {
  const q = {
    sort(s) {
      const keys = Object.entries(s)
      const cmp = (a, b, dir) => (a < b ? -dir : a > b ? dir : 0)
      rows = [...rows].sort((a, b) => keys.reduce((r, [k, dir]) => r || cmp(a[k], b[k], dir), 0))
      return q
    },
    skip(n) { rows = rows.slice(n); return q },
    limit(n) { rows = rows.slice(0, n); return q },
    lean() { return q },
    async *cursor() { yield* structuredClone(rows) },
    then(res, rej) { return Promise.resolve(structuredClone(single ? rows[0] ?? null : rows)).then(res, rej) },
  }
  return q
}
function fakeModel(docs = []) {
  const m = {
    docs,
    find: (f = {}) => query(docs.filter((d) => match(d, f))),
    findOne: (f = {}) => query(docs.filter((d) => match(d, f)), true),
    findById: (id) => m.findOne({ _id: id }),
    countDocuments: async (f = {}) => docs.filter((d) => match(d, f)).length,
    exists: async (f) => (docs.some((d) => match(d, f)) ? { _id: 'x' } : null),
    findOneAndUpdate(f, u, o = {}) {
      const d = docs.find((x) => match(x, f))
      if (!d) return query([], true)
      const before = structuredClone(d)
      Object.assign(d, u.$set)
      return query([o.returnDocument === 'after' ? d : before], true)
    },
    async updateOne(f, u) {
      const d = docs.find((x) => match(x, f))
      if (d) Object.assign(d, u.$set)
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 }
    },
  }
  return m
}

// ---- made-up seed data ----
const IST_MS = 5.5 * 3600_000
const GROUPS = [
  ['120363000000000001@g.us', 'Group A'], ['120363000000000002@g.us', 'Group B'],
  ['120363000000000003@g.us', 'Group C'], ['120363000000000004@g.us', 'Group D'],
]
const hex = (n) => n.toString(16).padStart(24, '0')

export function seed(now = Date.now()) {
  const ago = (min) => new Date(now - min * 60_000)
  const istMidnight = new Date(Math.floor((now + IST_MS) / 86_400_000) * 86_400_000 - IST_MS) // today 00:00 IST
  const raws = []
  const bookings = []
  let n = 0
  const rawFor = (group, text, at, sender = `9198765${String(10000 + n).slice(-5)}@s.whatsapp.net`) => {
    const _id = hex(5000 + raws.length)
    raws.push({ _id, messageId: `M${raws.length}`, groupId: group[0], groupName: group[1], sender, text, timestamp: at })
    return _id
  }
  const add = (status, decidedBy, at, extra = {}) => {
    n += 1
    const group = GROUPS[n % 3] // Group D stays silent (quiet)
    const rawText = extra.rawText ?? `${extra.pickup ?? 'Noida'} to ${extra.drop ?? 'Agra'} ${n}, Sedan 3${n % 10}00, 98765${String(10000 + n).slice(-5)}`
    const b = {
      _id: hex(n), source: `whatsapp:${group[1]}`, rawText, pickup: 'Noida', drop: `Agra ${n}`, pickupNorm: 'noida', dropNorm: `agra ${n}`,
      tripDateTime: null, carType: 'Sedan', fare: 3000 + n, contact: `98765${String(10000 + n).slice(-5)}`, receivedAt: at,
      confidence: status === 'review' ? 0.55 : 0.92, rawMessageId: rawFor(group, rawText, at), status, decidedBy, decidedAt: at,
      otherSources: [], outputsSentAt: status === 'confirmed' ? at : null, ...extra,
    }
    bookings.push(b)
    return b
  }
  // 60 confirmed across ~3 days (pagination), the newest first in the list
  for (let i = 0; i < 60; i += 1) add('confirmed', 'rules', ago(10 + i * 70))
  // one folded from two other groups, with its duplicate raw messages
  const folded = add('confirmed', 'llm', ago(5), { pickup: 'Delhi Airport T3', drop: 'Agra', rawText: 'Delhi Airport T3 to Agra 24 Nov 6am Sedan 3500 9876543210', fare: 3500, contact: '9876543210', tripDateTime: new Date(istMidnight.getTime() + 30 * 3600_000) })
  folded.otherSources = [GROUPS[2], GROUPS[0]].map((g, i) => ({ source: `whatsapp:${g[1]}`, rawMessageId: rawFor(g, folded.rawText, ago(4 - i)), receivedAt: ago(4 - i) }))
  // exactly on the IST midnight boundary, for inclusive whole-day ranges
  add('confirmed', 'rules', new Date(istMidnight.getTime()), { pickup: 'Midnight start', drop: 'Today' })
  add('confirmed', 'rules', new Date(istMidnight.getTime() - 1), { pickup: 'Last ms', drop: 'Yesterday' })
  // formula-looking text must stay text
  add('confirmed', 'rules', ago(7), { rawText: '=HYPERLINK("http://example.invalid","cheap cabs") Delhi to Manali', pickup: 'Delhi', drop: 'Manali', source: 'app' })
  // 55 review items (more than one page), oldest first in Review
  for (let i = 0; i < 55; i += 1) add('review', i % 2 ? 'llm' : 'rules', ago(600 - i * 9), { fare: null, carType: null, pickup: i % 4 ? 'Jaipur' : null })
  add('rejected', 'admin', ago(300))
  add('rejected', 'rules', ago(320))
  // raw-only messages
  rawFor(GROUPS[1], '<script>alert(1)</script> <img src=x onerror=alert(2)>', ago(30))
  rawFor(GROUPS[0], '=cmd|"/c calc"!A1', ago(45), 'me')
  rawFor(GROUPS[2], 'Good morning everyone', ago(50))
  return { bookings, raws }
}

export async function start({ port = Number(process.env.PORT) || 4020, waStatus = process.env.DEV_WA_STATUS || 'open', now = Date.now() } = {}) {
  const { bookings, raws } = seed(now)
  const passwordHash = await hashPassword('admin-password-123')
  const models = {
    Admin: fakeModel([{ _id: 'admin', username: 'admin', passwordHash }]),
    Booking: fakeModel(bookings),
    RawMessage: fakeModel(raws),
  }
  // Mutable: a caller can change whatsapp.status / heartbeat / outputs while the server runs.
  const state = {
    whatsapp: { status: waStatus, since: new Date(now - 3 * 3600_000) },
    groupNames: new Map(GROUPS),
    lastMessageAt: new Map(),
    heartbeat: { minutes: 120, windowStart: '08:00', windowEnd: '23:00', quiet: false, lastAlertAt: null },
    outputs: { sheets: true, telegram: true, whatsappSend: false },
    // The real one counts the outbox; made-up numbers here so Status shows both lines.
    outputCounts: async () => ({ outputsPending: 2, outputsFailed: 1 }),
  }
  const logger = { error: (o, msg) => console.error('[dev-real-api] error:', msg, o?.err?.message ?? ''), warn() {}, info() {} }
  const app = createApp({
    models,
    config: { apiToken: '', sessionSecret: 'dev-only-session-secret-'.padEnd(48, 'x'), nodeEnv: 'development', targetGroupIds: GROUPS.map((g) => g[0]), heartbeatMinutes: 120 },
    getHealthState: () => state,
    onConfirmed: () => {}, // outputs are not exercised here
    pipeline: { async processMessage() { return { status: 'ignored' } } },
    logger,
  })
  const server = await new Promise((resolve, reject) => {
    const s = app.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(s))
    s.on('error', reject) // e.g. port in use: fail instead of serving nothing
  })
  return { server, state, models }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server } = await start()
  console.log(`DEV REAL-BACKEND (made-up data, in-memory) on http://localhost:${server.address().port}  login: admin / admin-password-123`)
}
