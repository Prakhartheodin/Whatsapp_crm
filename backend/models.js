import mongoose from 'mongoose'

const rawMessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    groupId: { type: String, required: true },
    groupName: String,
    sender: String,
    text: { type: String, required: true },
    timestamp: { type: Date, required: true, index: true },
  },
  { collection: 'raw_messages', timestamps: { createdAt: true, updatedAt: false } },
)
// WhatsApp can deliver the same message twice (reconnects); this makes inserts idempotent.
rawMessageSchema.index({ groupId: 1, messageId: 1 }, { unique: true })

export const RawMessage = mongoose.model('RawMessage', rawMessageSchema)

// Exactly one admin: the fixed _id 'admin' makes a second document impossible.
const adminSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'admin' },
    username: { type: String, required: true },
    passwordHash: { type: String, required: true },
  },
  { collection: 'admins', timestamps: true },
)

export const Admin = mongoose.model('Admin', adminSchema)
