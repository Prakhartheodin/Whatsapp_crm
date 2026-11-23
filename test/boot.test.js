import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const INDEX = fileURLToPath(new URL('../backend/index.js', import.meta.url))

// Starts the real backend/index.js from an empty temp folder (so no real .env is read) with a clean
// env and a temp AUTH_DIR. Both cases must exit before WhatsApp starts; nothing is reachable.
async function boot(t, env) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boot-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const child = spawn(process.execPath, [INDEX], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir,
      API_TOKEN: 'a'.repeat(40), SESSION_SECRET: 'b'.repeat(40), AUTH_DIR: path.join(dir, 'auth'), ...env,
    },
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  await assert.rejects(fs.access(path.join(dir, 'auth')), 'WhatsApp never started')
  return { code, out }
}

test('boot: an enabled output without its settings stops at start with one fatal line', async (t) => {
  const { code, out } = await boot(t, { MONGODB_URI: 'mongodb://127.0.0.1:1/x', TELEGRAM_ENABLED: 'true' })
  assert.equal(code, 1)
  const fatal = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.level === 60)
  assert.match(fatal.msg, /TELEGRAM_BOT_TOKEN/)
})

test('boot: MongoDB unreachable is one fatal line without the URI or its password', async (t) => {
  const { code, out } = await boot(t, { MONGODB_URI: 'mongodb://app:s3cretPW@127.0.0.1:1/x?serverSelectionTimeoutMS=300' })
  assert.equal(code, 1)
  const lines = out.split('\n').filter(Boolean)
  assert.ok(lines.every((l) => l.startsWith('{')), 'no raw stack trace')
  assert.match(JSON.parse(lines.at(-1)).msg, /MongoDB is unreachable.*Check MONGODB_URI/)
  assert.doesNotMatch(out, /s3cretPW/)
})
