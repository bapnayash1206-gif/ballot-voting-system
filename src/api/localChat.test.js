import test from 'node:test'
import assert from 'node:assert/strict'
import { localChatApi, subscribeChat } from './localChat.js'

test('chat API uses authenticated same-origin requests and never accepts a sender field', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, async json() { return { message: { id: 'm' } } } }
  }
  try {
    await localChatApi.sendPollMessage('poll/a', 'Hello')
    assert.equal(calls[0].url, '/api/polls/poll%2Fa/chat')
    assert.equal(calls[0].options.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(calls[0].options.body), { text: 'Hello' })
  } finally { globalThis.fetch = originalFetch }
})

test('chat API reports backend failures instead of optimistic success', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 409, async json() { return { error: 'Chat is read-only because this poll is closed.' } } })
  try { await assert.rejects(localChatApi.sendPollMessage('poll', 'Hello'), /read-only/) }
  finally { globalThis.fetch = originalFetch }
})

test('chat stream parses server events and supports cancellation', async () => {
  const originalFetch = globalThis.fetch
  let controller
  let received
  const stream = new ReadableStream({ start(target) { target.enqueue(new TextEncoder().encode('event: chat.message\ndata: {"message":{"id":"m"}}\n\n')); target.close() } })
  globalThis.fetch = async () => ({ ok: true, body: stream })
  controller = subscribeChat('/polls/p/chat/stream', { onMessage: (event) => { received = event }, onStatus: () => {} })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  globalThis.fetch = originalFetch
  assert.equal(received.type, 'chat.message')
  assert.equal(received.message.id, 'm')
})
