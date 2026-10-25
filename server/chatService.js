import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { ApiError } from './votingService.js'

const fail = (status, message) => { throw new ApiError(status, message) }

export function createChatService({ storageFile = resolve('.local-data/chat-messages.json'), auditFile = resolve('.local-data/chat-moderation.jsonl'), now = () => Date.now(), maxMessageLength = 500, perPollLimit = 1000, globalLimit = 20_000, rateWindowMs = 10_000, rateLimit = 10 } = {}) {
  let messages = []
  let loadPromise
  let writeQueue = Promise.resolve()
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const sendTimes = new Map()

  async function load() {
    if (!loadPromise) loadPromise = storageFile ? readFile(storageFile, 'utf8').then((value) => {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed) || parsed.some((item) => !item?.id || !item?.pollId || typeof item.text !== 'string')) throw new Error('Chat store has an invalid format; preserve it for inspection.')
      messages = parsed.slice(-globalLimit)
    }).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    }) : Promise.resolve()
    return loadPromise
  }

  function persist() {
    if (!storageFile) return Promise.resolve()
    const snapshot = JSON.stringify(messages.slice(-globalLimit))
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(storageFile), { recursive: true })
      const temp = `${storageFile}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
      await rename(temp, storageFile)
    })
    return writeQueue
  }

  function assertPoll(poll, allowClosed = false) {
    if (!poll || poll.status === 'draft') fail(404, 'Poll not found')
    if (!['active', 'closed', 'expired'].includes(poll.status)) fail(404, 'Poll not found')
    if (!allowClosed && poll.status !== 'active') fail(409, 'Chat is read-only because this poll is closed.')
  }

  function rateCheck(pollId, senderId) {
    const key = `${pollId}:${senderId}`
    const current = now()
    const recent = (sendTimes.get(key) || []).filter((time) => current - time < rateWindowMs)
    if (recent.length >= rateLimit) fail(429, 'You are sending messages too quickly. Please wait a moment.')
    recent.push(current)
    sendTimes.set(key, recent)
  }

  async function listMessages(pollId, poll, { includeHidden = false, limit = 100 } = {}) {
    await load()
    assertPoll(poll, true)
    const max = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 100))
    return messages.filter((item) => item.pollId === pollId && (includeHidden || !item.hidden)).slice(-max)
  }

  async function sendMessage(pollId, poll, identity, text) {
    await load()
    assertPoll(poll, false)
    if (typeof text !== 'string' || !text.trim() || text.trim().length > maxMessageLength) fail(400, `Message must contain 1 to ${maxMessageLength} characters.`)
    const senderId = String(identity?.sub || identity?.id || '').trim()
    if (!senderId) fail(401, 'A verified account is required to send chat messages.')
    rateCheck(pollId, senderId)
    const message = {
      id: randomUUID(), pollId,
      sender: String(identity.username || identity.name || identity.email || 'Participant').slice(0, 80),
      text: text.trim(), createdAt: now(), hidden: false,
    }
    if (messages.filter((item) => item.pollId === pollId).length >= perPollLimit) fail(429, 'This poll chat has reached its local message limit.')
    messages.push(message)
    if (messages.length > globalLimit) messages = messages.slice(-globalLimit)
    await persist()
    events.emit(`poll:${pollId}`, { type: 'chat.message', message })
    events.emit('admin', { type: 'chat.message', message })
    return message
  }

  async function moderate(pollId, poll, messageId, admin, action) {
    await load()
    assertPoll(poll, true)
    if (!['hide', 'restore'].includes(action)) fail(400, 'Moderation action must be hide or restore.')
    const message = messages.find((item) => item.pollId === pollId && item.id === messageId)
    if (!message) fail(404, 'Chat message not found')
    const hidden = action === 'hide'
    if (message.hidden === hidden) return message
    message.hidden = hidden
    await persist()
    if (auditFile) {
      await mkdir(dirname(auditFile), { recursive: true })
      await appendFile(auditFile, `${JSON.stringify({ pollId, messageId, action, admin: String(admin?.username || admin?.name || 'Admin').slice(0, 80), createdAt: now() })}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    const event = { type: hidden ? 'chat.hidden' : 'chat.restored', pollId, messageId }
    events.emit(`poll:${pollId}`, event)
    events.emit('admin', event)
    return message
  }

  function subscribe(pollId, listener) {
    const topic = pollId === '*' ? 'admin' : `poll:${pollId}`
    events.on(topic, listener)
    return () => events.off(topic, listener)
  }

  async function listRooms(polls) {
    await load()
    return polls.filter((poll) => ['active', 'closed', 'expired'].includes(poll.status)).map((poll) => {
      const items = messages.filter((message) => message.pollId === poll.id)
      return { pollId: poll.id, question: poll.question, status: poll.status, messageCount: items.length, lastMessageAt: items.at(-1)?.createdAt ?? null }
    })
  }

  return { listMessages, sendMessage, moderate, subscribe, listRooms, initialize: load }
}
