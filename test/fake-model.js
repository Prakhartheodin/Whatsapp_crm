// In-memory stand-in for a Mongoose model: only the calls the backend makes, with MongoDB's
// matching rules for the operators used (dotted paths, $or/$and, null matches missing).
const get = (o, path) =>
  path.split('.').reduce((v, k) => (Array.isArray(v) ? v.map((x) => x?.[k]) : v?.[k]), o)
function set(o, path, value) {
  const keys = path.split('.')
  const last = keys.pop()
  for (const k of keys) o = o[k] ??= {}
  o[last] = value
}
const OPS = {
  $gte: (v, x) => v >= x,
  $lte: (v, x) => v <= x,
  $lt: (v, x) => v < x,
  $ne: (v, x) => String(v) !== String(x),
  $in: (v, x) => x.map(String).includes(String(v)),
  $regex: (v, x, c) => new RegExp(x, c.$options).test(v),
  $options: () => true,
}
const one = (v, c) =>
  c && typeof c === 'object' && !(c instanceof Date)
    ? c.$ne === null && Object.keys(c).length === 1 ? v != null : v != null && Object.entries(c).every(([op, x]) => OPS[op](v, x, c))
    : c === null ? v == null : String(v) === String(c)
export const match = (d, f) =>
  Object.entries(f).every(([k, c]) => {
    if ((k === '$or' || k === '$and') && !c.length) throw new Error(`${k} must be a nonempty array`) // as MongoDB
    if (k === '$or') return c.some((sub) => match(d, sub))
    if (k === '$and') return c.every((sub) => match(d, sub))
    const v = get(d, k)
    return Array.isArray(v) ? v.some((e) => one(e, c)) : one(v, c)
  })

function query(rows, single = false) {
  const q = {
    sort(s) {
      const keys = Object.entries(s)
      const cmp = (a, b, dir) => (a < b ? -dir : a > b ? dir : 0)
      rows = [...rows].sort((a, b) => keys.reduce((r, [k, dir]) => r || cmp(get(a, k), get(b, k), dir), 0))
      return q
    },
    skip(n) { rows = rows.slice(n); return q },
    limit(n) { rows = rows.slice(0, n); return q },
    lean() { return q },
    async *cursor() { yield* structuredClone(rows) },
    then(res, rej) {
      return Promise.resolve(structuredClone(single ? rows[0] ?? null : rows)).then(res, rej)
    },
  }
  return q
}

function apply(d, u) {
  for (const [k, v] of Object.entries(u.$set ?? {})) set(d, k, v)
  for (const [k, v] of Object.entries(u.$inc ?? {})) set(d, k, (get(d, k) ?? 0) + v)
}

/** unique: field names forming a unique index (create throws code 11000 on a repeat). */
export function fakeModel(docs = [], { unique } = {}) {
  let n = 0
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
      apply(d, u)
      return query([o.returnDocument === 'after' ? d : before], true)
    },
    async updateOne(f, u) {
      const d = docs.find((x) => match(x, f))
      if (d) apply(d, u)
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 }
    },
    async updateMany(f, u) {
      const hit = docs.filter((x) => match(x, f))
      for (const d of hit) apply(d, u)
      return { matchedCount: hit.length, modifiedCount: hit.length }
    },
    async create(doc) {
      if (unique && docs.some((d) => unique.every((k) => String(d[k]) === String(doc[k])))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
      }
      const d = { _id: `fake${++n}`, ...structuredClone(doc) }
      docs.push(d)
      return d
    },
    async deleteMany(f) {
      const before = docs.length
      for (let i = docs.length - 1; i >= 0; i--) if (match(docs[i], f)) docs.splice(i, 1)
      return { deletedCount: before - docs.length }
    },
    async deleteOne(f) {
      const i = docs.findIndex((x) => match(x, f))
      if (i >= 0) docs.splice(i, 1)
      return { deletedCount: i >= 0 ? 1 : 0 }
    },
  }
  return m
}
