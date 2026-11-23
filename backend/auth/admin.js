import { hashPassword, normalizeUsername, validateCredentials } from './password.js'

const ADMIN_ID = 'admin'
const EXISTS = 'An admin already exists. Use --reset to replace it.'

export async function createAdmin(AdminModel, { username, password, reset = false }) {
  const problems = validateCredentials({ username, password })
  if (problems.length) throw new Error(`Invalid credentials: ${problems.join('; ')}`)
  const name = normalizeUsername(username)
  const passwordHash = await hashPassword(password)

  if (reset) {
    // upsert on the fixed _id; returns the previous document (null if there was none)
    const old = await AdminModel.findByIdAndUpdate(ADMIN_ID, { username: name, passwordHash }, { upsert: true })
    return { username: name, created: !old }
  }
  try {
    await AdminModel.create({ _id: ADMIN_ID, username: name, passwordHash })
  } catch (err) {
    if (err?.code === 11000) throw new Error(EXISTS) // fixed _id: the database enforces "one admin", also in a race
    throw err
  }
  return { username: name, created: true }
}
