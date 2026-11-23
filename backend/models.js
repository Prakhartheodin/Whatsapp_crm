import mongoose from 'mongoose'

const rawMessageSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    groupId: { type: String, required: true },
    groupName: String,
    sender: String,
    text: { type: String, required: true },
    timestamp: { type: Date, required: true, index: true },
    // Set when the booking pipeline has decided on the message; null rows are re-fed after a restart.
    processedAt: { type: Date, default: null },
  },
  { collection: 'raw_messages', timestamps: { createdAt: true, updatedAt: false } },
)
// WhatsApp can deliver the same message twice (reconnects); this makes inserts idempotent.
rawMessageSchema.index({ groupId: 1, messageId: 1 }, { unique: true })
rawMessageSchema.index({ processedAt: 1, timestamp: 1 }) // the unprocessed re-feed at start/reconnect

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

const bookingSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    rawText: { type: String, required: true },
    pickup: String,
    drop: String,
    pickupNorm: String,
    dropNorm: String,
    tripDateTime: { type: Date, default: null },
    carType: { type: String, default: null },
    fare: { type: Number, default: null },
    contact: { type: String, default: null },
    receivedAt: { type: Date, required: true },
    confidence: { type: Number, min: 0, max: 1 },
    rawMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'RawMessage', default: null },
    status: { type: String, enum: ['confirmed', 'review', 'rejected'], required: true },
    decidedBy: { type: String, enum: ['rules', 'llm', 'admin'], required: true },
    decidedAt: { type: Date, default: Date.now },
    otherSources: [{ _id: false, source: String, rawMessageId: mongoose.Schema.Types.ObjectId, receivedAt: Date }],
    outputsSentAt: { type: Date, default: null },
  },
  { collection: 'bookings' },
)
bookingSchema.index({ status: 1, receivedAt: -1 })
bookingSchema.index({ contact: 1, receivedAt: -1 })
// /api/raw looks up the booking status of each page of raw messages.
bookingSchema.index({ rawMessageId: 1 })
// ...and of messages folded in as duplicates (also checked by the unprocessed re-feed).
bookingSchema.index({ 'otherSources.rawMessageId': 1 })

export const Booking = mongoose.model('Booking', bookingSchema)
