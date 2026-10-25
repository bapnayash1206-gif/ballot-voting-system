import test from 'node:test'
import assert from 'node:assert/strict'
import { createAwsBackend, listPollsForView } from './awsBackend.js'

test('AWS adapter exposes identity from authenticated /auth/me and forwards only its bearer ID token', async () => {
  let request
  const backend = createAwsBackend({
    httpBaseUrl: 'https://api.example.invalid/dev', getIdentityToken: async () => 'short-lived-id-token',
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ user: { sub: 'verified-sub', role: 'voter' }, isAdmin: false }) } },
  })
  assert.deepEqual(await backend.getCurrentUser(), { user: { sub: 'verified-sub', role: 'voter' }, isAdmin: false })
  assert.equal(request.url, 'https://api.example.invalid/dev/auth/me')
  assert.equal(request.options.headers.authorization, 'Bearer short-lived-id-token')
})

test('AWS adapter treats an expired or rejected ID token as authentication failure', async () => {
  const backend = createAwsBackend({
    httpBaseUrl: 'https://api.example.invalid/dev', getIdentityToken: async () => 'expired-id-token',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }),
  })
  await assert.rejects(backend.getCurrentUser(), /Google sign-in was rejected or has expired/)
})

test('AWS client uses verified bearer token and has no development identity headers', async () => {
  let request
  const backend = createAwsBackend({
    httpBaseUrl: 'https://api.example.invalid/dev/',
    getIdentityToken: async () => 'google-id-token',
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, json: async () => ({ polls: [] }) }
    },
  })
  assert.deepEqual(await backend.listPolls(), { polls: [] })
  assert.equal(request.url, 'https://api.example.invalid/dev/polls?view=admin')
  assert.equal(request.options.headers.authorization, 'Bearer google-id-token')
  assert.equal(request.options.headers['x-dev-admin-id'], undefined)
  assert.equal(request.options.headers['x-dev-voter-id'], undefined)
})

test('AWS client provides a separate voter poll discovery request', async () => {
  let requestUrl
  const backend = createAwsBackend({
    httpBaseUrl: 'https://api.example.invalid/dev', getIdentityToken: async () => 'google-id-token',
    fetchImpl: async (url) => { requestUrl = url; return { ok: true, json: async () => ({ polls: [] }) } },
  })
  await backend.listVoterPolls('next cursor')
  assert.equal(requestUrl, 'https://api.example.invalid/dev/polls?view=voter&cursor=next+cursor')
})

test('AWS client fails closed when no OIDC token callback is configured', async () => {
  const backend = createAwsBackend({ httpBaseUrl: 'https://api.example.invalid/dev' })
  await assert.rejects(backend.listPolls(), /OIDC identity-token provider is required/)
})

test('AWS client returns backend duplicate-vote errors without fallback success', async () => {
  const backend = createAwsBackend({
    httpBaseUrl: 'https://api.example.invalid/dev', getIdentityToken: async () => 'token',
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'You have already voted in this poll. You cannot vote again.' }) }),
  })
  await assert.rejects(backend.submitVote('poll-1', { optionId: 'choice-1' }), /You have already voted in this poll/)
})

test('AWS client obtains a short-lived poll ticket before opening a WebSocket', async () => {
  let openedUrl
  class FakeWebSocket {
    constructor(url) { openedUrl = url; this.listeners = {} }
    addEventListener(name, handler) { this.listeners[name] = handler }
  }
  const backend = createAwsBackend({
    httpBaseUrl: 'https://api.example.invalid/dev', webSocketUrl: 'wss://socket.example.invalid/dev',
    getIdentityToken: async () => 'token', WebSocketImpl: FakeWebSocket,
    fetchImpl: async (url, options) => {
      assert.match(url, /poll-1\/ws-ticket$/)
      assert.equal(JSON.parse(options.body).purpose, 'chat')
      return { ok: true, json: async () => ({ ticket: 'one-time-ticket' }) }
    },
  })
  const socket = await backend.connectPoll('poll-1', 'chat', () => {})
  assert.ok(socket instanceof FakeWebSocket)
  assert.equal(openedUrl, 'wss://socket.example.invalid/dev?ticket=one-time-ticket')
})

test('AWS API selection is opt-in and local-only features stay unavailable in AWS mode', async () => {
  const { resolveApiMode, canUseLocalOnlyFeatures } = await import('./awsBackend.js')
  assert.equal(resolveApiMode(), 'local')
  assert.equal(resolveApiMode('aws'), 'aws')
  assert.equal(canUseLocalOnlyFeatures('aws'), false)
  assert.equal(canUseLocalOnlyFeatures('local'), true)
  const calls = []
  const api = {
    listPolls: async () => { calls.push('admin'); return { polls: [] } },
    listVoterPolls: async () => { calls.push('voter'); return { polls: [] } },
  }
  await listPollsForView(api, 'aws', 'voter')
  await listPollsForView(api, 'aws', 'admin')
  await listPollsForView(api, 'local', 'voter')
  assert.deepEqual(calls, ['voter', 'admin', 'admin'])
})
test('AWS poll lists aggregate every cursor page and retain complete Admin dashboard totals', async () => {
  const calls = []
  const firstPage = Array.from({ length: 50 }, (_, index) => ({ id: `poll-${index}` }))
  const secondPage = Array.from({ length: 7 }, (_, index) => ({ id: `poll-${index + 50}` }))
  const api = {
    async listPolls(cursor) {
      calls.push(['admin', cursor])
      return cursor
        ? { polls: secondPage, nextCursor: null }
        : { polls: firstPage, nextCursor: 'cursor-2', dashboard: { pollCount: 57, activePollCount: 9, totalVotes: 123 } }
    },
    async listVoterPolls() { throw new Error('voter endpoint should not be used') },
  }
  const result = await listPollsForView(api, 'aws', 'admin')
  assert.equal(result.polls.length, 57)
  assert.deepEqual(result.dashboard, { pollCount: 57, activePollCount: 9, totalVotes: 123 })
  assert.equal(result.nextCursor, null)
  assert.deepEqual(calls, [['admin', undefined], ['admin', 'cursor-2']])
})

test('AWS voter poll pagination continues through empty pages with a cursor', async () => {
  const cursors = []
  const api = {
    async listPolls() { throw new Error('admin endpoint should not be used') },
    async listVoterPolls(cursor) {
      cursors.push(cursor)
      if (cursor === undefined) return { polls: [], nextCursor: 'cursor-empty' }
      if (cursor === 'cursor-empty') return { polls: [{ id: 'published-poll' }], nextCursor: 'cursor-final' }
      return { polls: [], nextCursor: null }
    },
  }
  const result = await listPollsForView(api, 'aws', 'voter')
  assert.deepEqual(result.polls, [{ id: 'published-poll' }])
  assert.deepEqual(cursors, [undefined, 'cursor-empty', 'cursor-final'])
})

test('AWS poll pagination stops after a valid empty final page and makes no extra request', async () => {
  let calls = 0
  const result = await listPollsForView({
    async listPolls() { calls += 1; return { polls: [], nextCursor: null, dashboard: { pollCount: 0, activePollCount: 0, totalVotes: 0 } } },
  }, 'aws', 'admin')
  assert.deepEqual(result.polls, [])
  assert.deepEqual(result.dashboard, { pollCount: 0, activePollCount: 0, totalVotes: 0 })
  assert.equal(calls, 1)
})

test('AWS poll pagination detects repeated cursors and enforces a page safety limit', async () => {
  let repeatedCalls = 0
  await assert.rejects(listPollsForView({ async listPolls() {
    repeatedCalls += 1
    return { polls: [], nextCursor: 'same-cursor' }
  } }, 'aws', 'admin'), /cursor repeated/)
  assert.equal(repeatedCalls, 2)

  let limitedCalls = 0
  await assert.rejects(listPollsForView({ async listPolls() {
    limitedCalls += 1
    return { polls: [], nextCursor: `cursor-${limitedCalls}` }
  } }, 'aws', 'admin', { maxPages: 2 }), /2-page safety limit/)
  assert.equal(limitedCalls, 2)
})

test('local poll listing remains a single unpaginated backend call', async () => {
  let calls = 0
  const response = { polls: [{ id: 'local-poll' }] }
  const actual = await listPollsForView({ async listPolls(...args) { calls += 1; assert.equal(args.length, 0); return response } }, 'local', 'voter')
  assert.equal(actual, response)
  assert.equal(calls, 1)
})
