import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeMessageContent, getContentType } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { RawMessage } from '../models.js'

const targets = new Set(config.targetGroupIds)

export const groupNames = new Map() // groupId -> subject, for /health
export const lastMessageAt = new Map() // groupId -> Date, for /health and heartbeat later

/** Text of a message, including photo/video/document captions. */
export function extractText(message) {
  const c = normalizeMessageContent(message)
  const type = getContentType(c)
  const text =
    c?.conversation ||
    c?.extendedTextMessage?.text ||
    c?.imageMessage?.caption ||
    c?.videoMessage?.caption ||
    c?.documentMessage?.caption
  return { type, text: text?.trim() || null }
}

/**
 * participant / participantAlt hold the LID and the phone-number JID, in either order
 * depending on the group's addressing mode. Store the phone number when we have it.
 */
export function pickSender(key) {
  if (key.fromMe) return 'me'
  return [key.participant, key.participantAlt].find((j) => j?.endsWith('@s.whatsapp.net')) || key.participant || ''
}

/** WhatsApp seconds (number or Long) to Date; a missing value must not lose the message. */
export function toDate(seconds) {
  const n = Number(seconds)
  return n > 0 ? new Date(n * 1000) : new Date()
}

/** 4 metadata calls, once per process (not per reconnect). */
export async function loadGroupNames(sock) {
  if (!targets.size) {
    logger.warn('TARGET_GROUP_IDS is empty: nothing will be captured. Run `npm run groups`.')
  }
  for (const id of targets) {
    if (groupNames.has(id)) continue
    try {
      groupNames.set(id, (await sock.groupMetadata(id)).subject)
      logger.info({ groupId: id, name: groupNames.get(id) }, 'watching group')
      // Rows stored before the name was known (offline backlog) got the ID as their name.
      await RawMessage.updateMany({ groupId: id, groupName: id }, { groupName: groupNames.get(id) })
    } catch (err) {
      logger.error({ err, groupId: id }, 'cannot read group; is the number a member and the ID right?')
    }
  }
}

export function attachCapture(sock) {
  // 'notify' = live, 'append' = arrived while offline. Both are kept; the unique index drops repeats.
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        await capture(m)
      } catch (err) {
        logger.error({ err, groupId: m.key?.remoteJid, messageId: m.key?.id }, 'failed to capture message')
      }
    }
  })
}

/** Idempotent insert. Returns true when the row is new. */
export async function storeRaw({ groupId, messageId, ...fields }) {
  const res = await RawMessage.updateOne({ groupId, messageId }, { $setOnInsert: fields }, { upsert: true })
  return res.upsertedCount > 0
}

async function capture(m) {
  const groupId = m.key?.remoteJid
  if (!targets.has(groupId)) return
  if (!m.message) {
    // Usually a message that failed to decrypt (stub CIPHERTEXT); a later retry arrives with the same id.
    logger.warn(
      { groupId, messageId: m.key.id, stub: m.messageStubType, reason: m.messageStubParameters?.[0] },
      'target-group message has no readable content (may still arrive via retry)',
    )
    return
  }

  const { type, text } = extractText(m.message)
  if (!text) {
    logger.info({ groupId, type }, 'skipped non-text message')
    return
  }
  const doc = {
    groupId,
    messageId: m.key.id,
    groupName: groupNames.get(groupId) || groupId,
    sender: pickSender(m.key),
    text,
    timestamp: toDate(m.messageTimestamp),
  }
  let isNew
  try {
    isNew = await storeRaw(doc)
  } catch (err) {
    if (err.code === 11000) return // two upserts of the same message raced; the row exists
    // WhatsApp has already been acked and will not resend: keep it on disk until MongoDB is back.
    await spool(doc)
    logger.error({ err, groupId, messageId: doc.messageId }, 'mongodb write failed; message saved to spool')
    return
  }
  if (isNew) {
    lastMessageAt.set(groupId, doc.timestamp)
    logger.info({ group: groupNames.get(groupId), chars: text.length }, 'captured message')
    // TODO(step 4): hand the stored message to the detection pipeline here (and for replayed spool rows).
  }
}

async function spool(doc, file = config.spoolFile) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.appendFile(file, JSON.stringify(doc) + '\n', { mode: 0o600 })
}

let replaying = null

/**
 * Stores every spooled message (same upsert, so repeats are harmless). Lines that fail stay
 * in the spool for the next replay; unreadable lines go to raw.rejected.jsonl. Never throws.
 */
export function replaySpool(file = config.spoolFile, store = storeRaw) {
  replaying ??= replay(file, store)
    .catch((err) => logger.error({ err }, 'spool replay failed'))
    .finally(() => { replaying = null })
  return replaying
}

async function replay(file, store) {
  // Work on a renamed copy so messages spooled meanwhile are not lost; a leftover copy from a crash is replayed first.
  const work = file + '.replaying'
  try {
    await fs.access(work)
  } catch {
    try {
      await fs.rename(file, work)
    } catch (err) {
      if (err.code === 'ENOENT') return // nothing spooled
      throw err
    }
  }
  const lines = (await fs.readFile(work, 'utf8')).split('\n').filter(Boolean)
  const failed = []
  const rejected = []
  for (const line of lines) {
    let doc
    try {
      doc = JSON.parse(line)
    } catch {
      rejected.push(line)
      continue
    }
    try {
      await store(doc)
    } catch (err) {
      if (err.code !== 11000) failed.push(line)
    }
  }
  if (failed.length) await fs.appendFile(file, failed.map((l) => l + '\n').join(''), { mode: 0o600 })
  if (rejected.length) await fs.appendFile(path.join(path.dirname(file), 'raw.rejected.jsonl'), rejected.map((l) => l + '\n').join(''), { mode: 0o600 })
  await fs.unlink(work)
  const counts = { stored: lines.length - failed.length - rejected.length, failed: failed.length, rejected: rejected.length }
  if (failed.length || rejected.length) logger.warn(counts, 'spool replayed with leftovers (failed stay in the spool)')
  else logger.info(counts, 'spool replayed')
}
