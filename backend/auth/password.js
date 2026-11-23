import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

export const normalizeUsername = (u) => String(u ?? '').trim().toLowerCase()

export async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  try {
    const [tag, saltHex, hashHex, extra] = String(stored).split('$')
    if (tag !== 'scrypt' || extra !== undefined || !/^[0-9a-f]+$/.test(saltHex ?? '') || !/^[0-9a-f]+$/.test(hashHex ?? '')) return false
    const expected = Buffer.from(hashHex, 'hex')
    const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length)
    return timingSafeEqual(key, expected)
  } catch {
    return false
  }
}

export function validateCredentials({ username, password } = {}) {
  const problems = []
  if (!/^[a-z0-9_.-]{3,32}$/.test(normalizeUsername(username))) {
    problems.push('username must be 3-32 characters: a-z, 0-9, _ . -')
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
    problems.push('password must be 12-200 characters')
  }
  return problems
}
