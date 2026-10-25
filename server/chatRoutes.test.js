import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createRequestHandler } from './index.js'
import { createChatService } from './chatService.js'
import { createVotingService } from './votingService.js'

const users = {
  voter1: { id: 'voter-1', sub: 'voter-1', username: 'student1', role: 'voter' },
  voter2: { id: 'voter-2', sub: 'voter-2', username: 'student2', role: 'voter' },
  admin: { id: 'admin-1', sub: 'admin-1', username: 'samarth', role: 'admin' },
}
function setup() {
  const voting = createVotingService()
  const chat = createChatService({ storageFile: null, auditFile: null })
  const accountService = { userForSession: (session) => users[session] || null }
  const handler = createRequestHandler(voting, { authMode: 'accounts', accountService, chatService: chat })
  const call = async (method, url, { session, body, stream = false } = {}) => {
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      method, url, headers: { host: '127.0.0.1', cookie: session ? `ballot_session=${session}` : '' },
    })
    const response = new EventEmitter()
    response.writableEnded = false
    response.writeHead = (status, headers = {}) => { response.statusCode = status; response.headers = headers }
    response.write = (chunk) => { response.output = (response.output || '') + chunk; return true }
    response.end = (output) => { response.output = output; response.writableEnded = true; response.emit('close') }
    await handler(request, response)
    return stream ? response : { status: response.statusCode, payload: response.output ? JSON.parse(response.output) : null, headers: response.headers }
  }
  const makePoll = (status = 'active') => {
    const poll = voting.createPoll({ question: 'Campus event?', options: ['Fest', 'Sports'], chatEnabled: false })
    if (status === 'active') voting.startPoll(poll.id)
    if (status === 'closed') { voting.startPoll(poll.id); voting.closePoll(poll.id) }
    return poll
  }
  return { call, makePoll, chat, voting }
}

test('authenticated voters exchange poll-isolated chat messages through validated APIs', async () => {
  const { call, makePoll } = setup()
  const first = makePoll('active')
  const second = makePoll('active')
  const sent = await call('POST', `/api/polls/${first.id}/chat`, { session: 'voter1', body: { text: 'Hello there', sender: 'Admin' } })
  assert.equal(sent.status, 201)
  assert.equal(sent.payload.message.sender, 'student1')
  assert.equal((await call('GET', `/api/polls/${first.id}/chat`, { session: 'voter2' })).payload.messages.length, 1)
  assert.equal((await call('GET', `/api/polls/${second.id}/chat`, { session: 'voter2' })).payload.messages.length, 0)
})

test('unauthenticated and draft-poll chat access are rejected', async () => {
  const { call, makePoll } = setup()
  const active = makePoll('active')
  const draft = makePoll('draft')
  assert.equal((await call('GET', `/api/polls/${active.id}/chat`)).status, 401)
  assert.equal((await call('POST', `/api/polls/${active.id}/chat`, { body: { text: 'No' } })).status, 401)
  assert.equal((await call('GET', `/api/polls/${draft.id}/chat`, { session: 'voter1' })).status, 404)
  assert.equal((await call('POST', `/api/polls/${draft.id}/chat`, { session: 'voter1', body: { text: 'No' } })).status, 404)
})

test('closed polls keep readable chat history but reject sending new messages', async () => {
  const { call, makePoll } = setup()
  const poll = makePoll('active')
  await call('POST', `/api/polls/${poll.id}/chat`, { session: 'voter1', body: { text: 'Before closure' } })
  const closed = makePoll('closed')
  // Polls remain separate: the historical message is attached only to its original ID.
  assert.equal((await call('GET', `/api/polls/${poll.id}/chat`, { session: 'voter2' })).payload.messages.length, 1)
  assert.equal((await call('GET', `/api/polls/${closed.id}/chat`, { session: 'voter2' })).payload.messages.length, 0)
  assert.equal((await call('POST', `/api/polls/${closed.id}/chat`, { session: 'voter2', body: { text: 'After closure' } })).status, 409)
})

test('only admins can list chat rooms, monitor hidden messages, and moderate them', async () => {
  const { call, makePoll } = setup()
  const poll = makePoll('active')
  const sent = await call('POST', `/api/polls/${poll.id}/chat`, { session: 'voter1', body: { text: 'Moderate me' } })
  const id = sent.payload.message.id
  assert.equal((await call('GET', '/api/admin/chat/rooms', { session: 'voter1' })).status, 403)
  assert.equal((await call('POST', `/api/admin/chat/${poll.id}/messages/${id}/moderate`, { session: 'voter1', body: { action: 'hide' } })).status, 403)
  assert.equal((await call('GET', `/api/admin/chat/${poll.id}`, { session: 'voter1' })).status, 403)
  assert.equal((await call('POST', `/api/polls/${poll.id}/chat`, { session: 'admin', body: { text: 'Admin message' } })).status, 403)
  assert.equal((await call('GET', '/api/admin/chat/rooms', { session: 'admin' })).payload.rooms.length, 1)
  assert.equal((await call('POST', `/api/admin/chat/${poll.id}/messages/${id}/moderate`, { session: 'admin', body: { action: 'hide' } })).status, 200)
  assert.equal((await call('GET', `/api/polls/${poll.id}/chat`, { session: 'voter2' })).payload.messages.length, 0)
  assert.equal((await call('GET', `/api/admin/chat/${poll.id}`, { session: 'admin' })).payload.messages[0].hidden, true)
})

test('SSE streams publish room messages and disconnect cleanup works', async () => {
  const { call, makePoll } = setup()
  const poll = makePoll('active')
  const stream = await call('GET', `/api/polls/${poll.id}/chat/stream`, { session: 'voter1', stream: true })
  assert.equal(stream.statusCode, 200)
  await call('POST', `/api/polls/${poll.id}/chat`, { session: 'voter2', body: { text: 'Live update' } })
  assert.match(stream.output, /event: chat.message/)
  assert.match(stream.output, /Live update/)
  const beforeClose = stream.output
  stream.emit('close')
  await call('POST', `/api/polls/${poll.id}/chat`, { session: 'voter2', body: { text: 'After disconnect' } })
  assert.equal(stream.output, beforeClose)
})
