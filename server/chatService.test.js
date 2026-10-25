import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createChatService } from './chatService.js'

const poll = (id, status = 'active') => ({ id, status, question: id })
const admin = { username: 'samarth' }

test('chat isolates messages by poll, records trusted identity, and publishes new messages', async () => {
  const chat = createChatService({ storageFile: null, auditFile: null })
  const voter = { sub: 'voter-1', username: 'student' }
  const events = []
  chat.subscribe('poll-a', (event) => events.push(event))
  const first = await chat.sendMessage('poll-a', poll('poll-a'), voter, 'Hello campus')
  await chat.sendMessage('poll-b', poll('poll-b'), voter, 'Other room')
  assert.equal(first.sender, 'student')
  assert.equal((await chat.listMessages('poll-a', poll('poll-a'))).length, 1)
  assert.equal((await chat.listMessages('poll-b', poll('poll-b'))).length, 1)
  assert.equal(events.length, 1)
})

test('chat rejects invalid, closed, draft, and rate-limited messages', async () => {
  const chat = createChatService({ storageFile: null, auditFile: null, rateLimit: 1 })
  const voter = { sub: 'voter-1', username: 'student' }
  await assert.rejects(chat.sendMessage('p', poll('p'), voter, '  '), (error) => error.status === 400)
  await assert.rejects(chat.sendMessage('p', poll('p'), voter, 'x'.repeat(501)), (error) => error.status === 400)
  await assert.rejects(chat.sendMessage('p', poll('p', 'draft'), voter, 'Hello'), (error) => error.status === 404)
  await assert.rejects(chat.sendMessage('p', poll('p', 'closed'), voter, 'Hello'), (error) => error.status === 409)
  await chat.sendMessage('p', poll('p'), voter, 'Hello')
  await assert.rejects(chat.sendMessage('p', poll('p'), voter, 'Again'), (error) => error.status === 429)
})

test('closed rooms retain history and admins can hide/restore with audit metadata', async () => {
  const chat = createChatService({ storageFile: null, auditFile: null })
  const voter = { sub: 'voter-1', username: 'student' }
  const message = await chat.sendMessage('p', poll('p'), voter, 'Keep it civil')
  await chat.moderate('p', poll('p', 'closed'), message.id, admin, 'hide')
  assert.equal((await chat.listMessages('p', poll('p', 'closed'))).length, 0)
  assert.equal((await chat.listMessages('p', poll('p', 'closed'), { includeHidden: true }))[0].hidden, true)
  await chat.moderate('p', poll('p', 'closed'), message.id, admin, 'restore')
  assert.equal((await chat.listMessages('p', poll('p', 'closed'))).length, 1)
})

test('chat history and moderation audit persist separately across service instances', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-chat-test-'))
  const storageFile = join(directory, 'messages.json')
  const auditFile = join(directory, 'moderation.jsonl')
  try {
    const first = createChatService({ storageFile, auditFile })
    const message = await first.sendMessage('persistent-poll', poll('persistent-poll'), { sub: 'voter', username: 'student' }, 'Persist this discussion')
    await first.moderate('persistent-poll', poll('persistent-poll'), message.id, admin, 'hide')
    const restarted = createChatService({ storageFile, auditFile })
    assert.equal((await restarted.listMessages('persistent-poll', poll('persistent-poll'))).length, 0)
    const stored = await restarted.listMessages('persistent-poll', poll('persistent-poll'), { includeHidden: true })
    assert.equal(stored[0].text, 'Persist this discussion')
    assert.equal(stored[0].hidden, true)
    const audit = await readFile(auditFile, 'utf8')
    assert.match(audit, /"action":"hide"/)
    assert.doesNotMatch(audit, /Persist this discussion/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
