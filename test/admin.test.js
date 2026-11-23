import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, validateCredentials } from '../backend/auth/password.js'
import { createAdmin } from '../backend/auth/admin.js'

// In-memory stand-in for the Mongoose Admin model (only the two calls createAdmin makes).
function fakeModel() {
  let doc = null
  return {
    get doc() { return doc },
    async create(d) {
      if (doc) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
      doc = { ...d }
    },
    async findByIdAndUpdate(id, set) {
      const old = doc
      doc = { _id: id, ...set }
      return old
    },
  }
}
const good = { username: 'boss', password: 'correct horse battery' }

test('hash/verify round trip', async () => {
  const h = await hashPassword('s3cret-pass-phrase')
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
  assert.equal(await verifyPassword('s3cret-pass-phrase', h), true)
  assert.equal(await verifyPassword('wrong-pass-phrase!', h), false)
  assert.notEqual(h, await hashPassword('s3cret-pass-phrase'))
})

test('verifyPassword returns false for malformed stored strings', async () => {
  for (const bad of ['', 'x', 'scrypt$aa', 'scrypt$zz$zz', 'bcrypt$aa$bb', null, undefined, 42]) {
    assert.equal(await verifyPassword('whatever-password', bad), false)
  }
})

test('validateCredentials', () => {
  assert.deepEqual(validateCredentials({ username: ' Admin.1 ', password: 'a'.repeat(12) }), [])
  assert.ok(validateCredentials({ username: 'ab', password: 'a'.repeat(12) }).length)
  assert.ok(validateCredentials({ username: 'a'.repeat(33), password: 'a'.repeat(12) }).length)
  assert.ok(validateCredentials({ username: 'bad name', password: 'a'.repeat(12) }).length)
  assert.ok(validateCredentials({ username: 'bad@name', password: 'a'.repeat(12) }).length)
  assert.ok(validateCredentials({ username: 'boss', password: 'a'.repeat(11) }).length)
  assert.ok(validateCredentials({ username: 'boss', password: 'a'.repeat(201) }).length)
  assert.deepEqual(validateCredentials({ username: 'boss', password: 'a'.repeat(200) }), [])
  assert.ok(validateCredentials({}).length)
})

test('createAdmin creates, stores only a verifiable hash', async () => {
  const m = fakeModel()
  assert.deepEqual(await createAdmin(m, { ...good, username: ' Boss ' }), { username: 'boss', created: true })
  assert.equal(m.doc._id, 'admin')
  assert.equal(m.doc.username, 'boss')
  assert.ok(!JSON.stringify(m.doc).includes(good.password))
  assert.equal(await verifyPassword(good.password, m.doc.passwordHash), true)
})

test('createAdmin refuses a second admin without reset, replaces with reset', async () => {
  const m = fakeModel()
  await createAdmin(m, good)
  await assert.rejects(createAdmin(m, { ...good, username: 'other' }), /already exists.*--reset/)
  assert.equal(m.doc.username, 'boss')
  const r = await createAdmin(m, { username: 'other', password: 'another long password', reset: true })
  assert.deepEqual(r, { username: 'other', created: false })
  assert.equal(await verifyPassword('another long password', m.doc.passwordHash), true)
})

test('createAdmin: invalid input throws and writes nothing', async () => {
  const m = fakeModel()
  await assert.rejects(createAdmin(m, { username: 'x', password: 'short' }), /username.*password|password.*username/is)
  assert.equal(m.doc, null)
})

test('createAdmin: duplicate-key race is reported as already exists', async () => {
  const m = { create: async () => { throw Object.assign(new Error('dup'), { code: 11000 }) } }
  await assert.rejects(createAdmin(m, good), /already exists/)
  const other = { create: async () => { throw new Error('boom') } }
  await assert.rejects(createAdmin(other, good), /boom/)
})
