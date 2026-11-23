import { normalizeMessageContent, getContentType } from 'baileys'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { RawMessage } from '../models.js'

const targets = new Set(config.targetGroupIds)
const groupNames = new Map()
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
        logger.error({ err, groupId: m.key?.remoteJid }, 'failed to store message')
      }
    }
  })
}

async function capture(m) {
  const groupId = m.key?.remoteJid
  if (!targets.has(groupId) || !m.message) return

  const { type, text } = extractText(m.message)
  if (!text) {
    logger.info({ groupId, type }, 'skipped non-text message')
    return
  }
  const timestamp = new Date(Number(m.messageTimestamp) * 1000)
  const res = await RawMessage.updateOne(
    { groupId, messageId: m.key.id },
    {
      $setOnInsert: {
        groupName: groupNames.get(groupId) || groupId,
        // participantAlt is the phone-number JID when the group uses hidden IDs (LIDs)
        sender: m.key.fromMe ? 'me' : m.key.participantAlt || m.key.participant || '',
        text,
        timestamp,
      },
    },
    { upsert: true },
  )
  if (res.upsertedCount) {
    lastMessageAt.set(groupId, timestamp)
    logger.info({ group: groupNames.get(groupId), chars: text.length }, 'captured message')
    // TODO(step 4): hand the stored message to the detection pipeline here.
  }
}
