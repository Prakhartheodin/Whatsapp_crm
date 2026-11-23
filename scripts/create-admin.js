// npm run create-admin [-- --reset]: create (or with --reset, replace) the single admin account.
// The password is read from the terminal with echo off, never from argv, never logged.
import readline from 'node:readline'
import { Writable } from 'node:stream'
import mongoose from 'mongoose'
import { config } from '../backend/config.js'
import { Admin } from '../backend/models.js'
import { createAdmin } from '../backend/auth/admin.js'

if (!config.mongoUri) {
  console.error('MONGODB_URI is not set (put it in .env).')
  process.exit(1)
}

let muted = false
const rl = readline.createInterface({
  input: process.stdin,
  output: new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb() } }),
  terminal: process.stdin.isTTY,
})
// Buffer lines as they arrive: piped stdin can end before a later question is asked.
const lines = []
const waiting = []
let closed = false
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)))
rl.on('close', () => { closed = true; waiting.splice(0).forEach((w) => w(null)) })

function ask(prompt, hidden = false) {
  if (process.stdin.isTTY) process.stdout.write(prompt)
  muted = hidden
  const done = (l) => { muted = false; if (hidden && process.stdin.isTTY) process.stdout.write('\n'); return l }
  if (lines.length) return Promise.resolve(done(lines.shift()))
  if (closed) return Promise.resolve(null)
  return new Promise((resolve) => waiting.push((l) => resolve(done(l))))
}

let code = 0
try {
  const username = await ask('Username: ')
  const password = await ask('Password: ', true)
  const again = await ask('Repeat password: ', true)
  if (username === null || password === null || again === null) throw new Error('Input ended early.')
  if (password !== again) throw new Error('Passwords do not match.')
  await mongoose.connect(config.mongoUri)
  const r = await createAdmin(Admin, { username, password, reset: process.argv.includes('--reset') })
  console.log(`Admin "${r.username}" ${r.created ? 'created' : 'replaced'}.`)
} catch (err) {
  console.error(err.message)
  code = 1
} finally {
  rl.close()
  await mongoose.disconnect()
}
process.exit(code)
