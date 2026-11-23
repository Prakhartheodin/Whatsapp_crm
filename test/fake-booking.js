// In-memory stand-in for the Mongoose Booking model: only the calls and operators the pipeline uses.
// Anything else throws, so a query change cannot pass here and then behave differently on MongoDB.
// (Lives in test/, so `node --test` also loads it; it defines no tests.)
const eq = (a, b) => (a instanceof Date || b instanceof Date ? +a === +b : String(a ?? null) === String(b ?? null))
const OPS = { $ne: (x, v) => !eq(x, v), $gte: (x, v) => x >= v, $lte: (x, v) => x <= v }
function matches(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (k.startsWith('$')) throw new Error(`fake-booking: unsupported operator ${k}`)
    if (!v || typeof v !== 'object' || v instanceof Date) return eq(doc[k], v)
    return Object.entries(v).every(([op, arg]) => {
      if (!OPS[op]) throw new Error(`fake-booking: unsupported operator ${op}`)
      return OPS[op](doc[k], arg)
    })
  })
}
function apply(row, update) {
  for (const op of Object.keys(update)) if (op !== '$set' && op !== '$push') throw new Error(`fake-booking: unsupported update ${op}`)
  Object.assign(row, update.$set)
  for (const [k, v] of Object.entries(update.$push ?? {})) row[k] = [...(row[k] ?? []), v]
}

export function fakeBooking(rows = []) {
  let n = 0
  return {
    rows,
    async create(doc) {
      const row = { _id: String(++n).padStart(24, '0'), otherSources: [], outputsSentAt: null, ...doc }
      rows.push(row)
      return row
    },
    find(filter) {
      let out = rows.filter((r) => matches(r, filter))
      const q = {
        sort(s) { const [[k, dir]] = Object.entries(s); out = [...out].sort((a, b) => (a[k] - b[k]) * dir); return q },
        lean: async () => out.map((r) => ({ ...r })),
      }
      return q
    },
    async updateOne(filter, update) {
      const r = rows.find((x) => matches(x, filter))
      if (!r) return { modifiedCount: 0 }
      apply(r, update)
      return { modifiedCount: 1 }
    },
    async findOneAndUpdate(filter, update, options) {
      if (options?.returnDocument !== 'after') throw new Error('fake-booking: only returnDocument "after" is supported')
      const r = rows.find((x) => matches(x, filter))
      if (!r) return null
      apply(r, update)
      return { ...r }
    },
  }
}
