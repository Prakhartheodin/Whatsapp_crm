import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeMessageContent, getContentType } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { RawMessage, Booking } from '../models.js'

const targets = new Set(config.targetGroupIds)

export const groupNames = new Map() // groupId -> subject, for /health
export const lastMessageAt = new Map() // groupId -> Date, for /health

let pipelineHook = null
/** fn({ source, rawText, receivedAt, rawMessageId }) runs once for every newly stored message. */
export function setPipeline(fn) {
  pipelineHook = fn
}

// Cut to the pipeline's 100-char source limit (group names go up to 100 chars).
const sourceOf = (name) => `whatsapp:${name}`.slice(0, 100)

const inFlight = new Set() // raw ids handed to the pipeline and not finished yet
let finishedDuringRefeed = null // ids finished while feedUnprocessed was reading, so it skips them

/**
 * Not awaited: the pipeline queues messages itself, and its failures must never affect capture.
 * processedAt is set once the pipeline has decided (any status); a row left null is re-fed by
 * feedUnprocessed after a restart or a MongoDB reconnect. Returns false when the row is already in flight.
 */
function toPipeline(doc, rawMessageId) {
  const key = String(rawMessageId)
  if (!pipelineHook || inFlight.has(key)) return false
  inFlight.add(key)
  const { groupId, messageId } = doc
  Promise.resolve()
    // Texts past the pipeline's 4000-char limit are classified from their start; the full text stays in raw_messages.
    .then(() => pipelineHook({
      source: sourceOf(groupNames.get(groupId) ?? doc.groupName ?? groupId),
      rawText: doc.text.slice(0, 4000),
      receivedAt: new Date(doc.timestamp),
      rawMessageId,
    }))
    .then(() => RawMessage.updateOne({ _id: rawMessageId }, { $set: { processedAt: new Date() } }))
    .then(() => finishedDuringRefeed?.add(key))
    .catch((err) => logger.error({ err, groupId, messageId }, 'pipeline failed for a stored message (retried after a restart or MongoDB reconnect)'))
    .finally(() => inFlight.delete(key))
  return true
}

const REFEED_MS = 48 * 3600_000 // bounded, so old history is never pushed into the outputs
let refeeding = null

/**
 * Feeds raw messages of the last 48 h that never finished the pipeline (process stopped while they
 * were queued, MongoDB error inside the pipeline), oldest first. Rows a booking already points to
 * (the crash came after the booking was written) are only marked processed. Never throws.
 */
export function feedUnprocessed(now = new Date()) {
  refeeding ??= refeed(now)
    .catch((err) => logger.error({ err }, 'could not re-feed unprocessed raw messages'))
    .finally(() => { refeeding = null; finishedDuringRefeed = null })
  return refeeding
}

async function refeed(now) {
  if (!pipelineHook) return
  finishedDuringRefeed = new Set()
  const rows = await RawMessage.find({ processedAt: null, timestamp: { $gte: new Date(now.getTime() - REFEED_MS) } })
    .sort({ timestamp: 1 }).lean()
  if (!rows.length) return
  const ids = rows.map((r) => r._id)
  const linked = await Booking.find(
    { $or: [{ rawMessageId: { $in: ids } }, { 'otherSources.rawMessageId': { $in: ids } }] },
    { rawMessageId: 1, 'otherSources.rawMessageId': 1 },
  ).lean()
  const done = new Set(linked.flatMap((b) => [b.rawMessageId, ...(b.otherSources ?? []).map((s) => s.rawMessageId)]).map(String))
  const doneIds = ids.filter((id) => done.has(String(id)))
  if (doneIds.length) await RawMessage.updateMany({ _id: { $in: doneIds } }, { $set: { processedAt: now } })
  let fed = 0
  for (const r of rows) {
    if (!done.has(String(r._id)) && !finishedDuringRefeed.has(String(r._id)) && toPipeline(r, r._id)) fed++
  }
  logger.info({ fed, alreadyLinked: doneIds.length }, 'unprocessed raw messages re-fed to the pipeline')
}

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

/**
 * Before WhatsApp starts: the last known name of each group from MongoDB, so the offline backlog
 * that arrives before loadGroupNames finishes is not labelled with the group ID.
 */
export async function seedGroupNames() {
  for (const id of targets) {
    try {
      const row = await RawMessage.findOne({ groupId: id, groupName: { $nin: [id, null, ''] } }, { groupName: 1 }).sort({ timestamp: -1 }).lean()
      if (row && !groupNames.has(id)) groupNames.set(id, row.groupName)
    } catch (err) {
      logger.warn({ err, groupId: id }, 'could not read the stored group name')
    }
  }
}

const namesLoaded = new Set()

/** 4 metadata calls, once per process (not per reconnect). */
export async function loadGroupNames(sock) {
  if (!targets.size) {
    logger.warn('TARGET_GROUP_IDS is empty: nothing will be captured. Run `npm run groups`.')
  }
  for (const id of targets) {
    if (namesLoaded.has(id)) continue
    try {
      const name = (await sock.groupMetadata(id)).subject
      groupNames.set(id, name)
      namesLoaded.add(id)
      logger.info({ groupId: id, name }, 'watching group')
      // Rows and bookings stored before the name was known (first run's offline backlog) got the ID as their name.
      const [from, to] = [sourceOf(id), sourceOf(name)]
      await RawMessage.updateMany({ groupId: id, groupName: id }, { groupName: name })
      await Booking.updateMany({ source: from }, { $set: { source: to } })
      await Booking.updateMany({ 'otherSources.source': from }, { $set: { 'otherSources.$[s].source': to } }, { arrayFilters: [{ 's.source': from }] })
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

/** Idempotent insert. Returns the new row's _id, or null when it already existed. */
export async function storeRaw({ groupId, messageId, ...fields }) {
  const res = await RawMessage.updateOne({ groupId, messageId }, { $setOnInsert: fields }, { upsert: true })
  return res.upsertedCount > 0 ? res.upsertedId : null
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
  let rawId
  try {
    rawId = await storeRaw(doc)
  } catch (err) {
    if (err.code === 11000) return // two upserts of the same message raced; the row exists
    // WhatsApp has already been acked and will not resend: keep it on disk until MongoDB is back.
    await spool(doc)
    logger.error({ err, groupId, messageId: doc.messageId }, 'mongodb write failed; message saved to spool')
    return
  }
  if (rawId) {
    lastMessageAt.set(groupId, doc.timestamp)
    logger.info({ group: groupNames.get(groupId), chars: text.length }, 'captured message')
    toPipeline(doc, rawId)
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
      const rawId = await store(doc)
      if (rawId) toPipeline(doc, rawId)
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
