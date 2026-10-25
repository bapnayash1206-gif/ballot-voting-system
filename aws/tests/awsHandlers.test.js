import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpHandler } from '../src/http/handler.js'
import { createWebSocketAuthorizer } from '../src/websocket/authorizer.js'
import { createWebSocketHandler } from '../src/websocket/handler.js'
import { ApiError } from '../src/shared/http.js'

const httpEvent = (method, path, claims = { sub: 'subject-1' }, body) => ({
  requestContext: { http: { method }, authorizer: { jwt: { claims } } },
  rawPath: path,
  body: body === undefined ? undefined : JSON.stringify(body),
})

test('authenticated /auth/me derives identity and admin role only from verified claims and allowlist', async () => {
  const handler = createHttpHandler({
    getRepository: async () => { throw new Error('identity route must not need repository access') },
    env: { GOOGLE_ADMIN_SUBJECTS: 'approved-admin-sub' },
  })
  const admin = await handler(httpEvent('GET', '/auth/me', {
    sub: 'approved-admin-sub', email: 'admin@example.test', name: 'Admin', role: 'voter',
  }))
  assert.equal(admin.statusCode, 200)
  assert.deepEqual(JSON.parse(admin.body), {
    user: { sub: 'approved-admin-sub', email: 'admin@example.test', name: 'Admin', role: 'admin' }, isAdmin: true,
  })
  const voter = await handler(httpEvent('GET', '/auth/me', {
    sub: 'ordinary-voter-sub', email: 'voter@example.test', role: 'admin',
  }))
  assert.equal(voter.statusCode, 200)
  assert.deepEqual(JSON.parse(voter.body), {
    user: { sub: 'ordinary-voter-sub', email: 'voter@example.test', name: '', role: 'voter' }, isAdmin: false,
  })
  const anonymous = await handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/auth/me' })
  assert.equal(anonymous.statusCode, 401)
})

test('HTTP handler requires an allowlisted verified Google subject before poll creation', async () => {
  let creates = 0
  const store = { async createPoll(input, subject) { creates += 1; return { ...input, ownerSub: subject } } }
  const handler = createHttpHandler({ getRepository: async () => store, env: { GOOGLE_ADMIN_SUBJECTS: 'admin-1' } })
  const denied = await handler(httpEvent('POST', '/polls', { sub: 'student-1' }, { question: 'Q', options: ['A', 'B'] }))
  assert.equal(denied.statusCode, 403)
  assert.equal(creates, 0)
  const accepted = await handler(httpEvent('POST', '/polls', { sub: 'admin-1' }, { question: 'Q', options: ['A', 'B'] }))
  assert.equal(accepted.statusCode, 201)
  assert.equal(JSON.parse(accepted.body).poll.ownerSub, 'admin-1')
})

test('poll listing defaults to voter discovery for voters and keeps admins owner-scoped', async () => {
  const calls = []
  const store = {
    async listPolls(subject, cursor) { calls.push(['admin', subject, cursor]); return { polls: [{ id: 'owned-poll' }], nextCursor: cursor ? null : 'owner-next' } },
    async listVoterPolls(cursor) { calls.push(['voter', cursor]); return { polls: [{ id: 'published-poll' }], nextCursor: null } },
  }
  const handler = createHttpHandler({ getRepository: async () => store, env: { GOOGLE_ADMIN_SUBJECTS: 'admin-1' } })
  const voterResult = await handler({ ...httpEvent('GET', '/polls', { sub: 'student-1' }), queryStringParameters: { cursor: 'next' } })
  assert.equal(JSON.parse(voterResult.body).polls[0].id, 'published-poll')
  assert.deepEqual(calls.pop(), ['voter', 'next'])

  const adminResult = await handler({ ...httpEvent('GET', '/polls', { sub: 'admin-1' }), queryStringParameters: { view: 'admin', cursor: 'owner-next' } })
  assert.equal(JSON.parse(adminResult.body).polls[0].id, 'owned-poll')
  assert.deepEqual(calls.pop(), ['admin', 'admin-1', 'owner-next'])

  const voterOverride = await handler({ ...httpEvent('GET', '/polls', { sub: 'admin-1' }), queryStringParameters: { view: 'voter' } })
  assert.equal(JSON.parse(voterOverride.body).polls[0].id, 'published-poll')
})

test('unauthorized users cannot request the admin poll list or create polls', async () => {
  let adminReads = 0
  let creates = 0
  const store = {
    async listPolls() { adminReads += 1; return { polls: [] } },
    async listVoterPolls() { return { polls: [] } },
    async createPoll() { creates += 1; return {} },
  }
  const handler = createHttpHandler({ getRepository: async () => store, env: { GOOGLE_ADMIN_SUBJECTS: 'admin-1' } })
  const list = await handler({ ...httpEvent('GET', '/polls', { sub: 'student-1' }), queryStringParameters: { view: 'admin' } })
  const create = await handler(httpEvent('POST', '/polls', { sub: 'student-1' }, { question: 'Q', options: ['A', 'B'] }))
  assert.equal(list.statusCode, 403)
  assert.equal(create.statusCode, 403)
  assert.equal(adminReads, 0)
  assert.equal(creates, 0)
})

test('HTTP handler forwards ranked ballots and round-based results without accepting client totals', async () => {
  const calls = []
  const result = { method: 'instant_runoff', outcome: 'winner', winnerOptionId: 'candidate-b', ballotCount: 2, rounds: [] }
  const store = {
    async submitVote(pollId, subject, input) { calls.push(['vote', pollId, subject, input]); return { accepted: true, ballotCount: 2 } },
    async getResults(pollId, subject) { calls.push(['results', pollId, subject]); return { pollId, ...result } },
  }
  const handler = createHttpHandler({ getRepository: async () => store, broadcast: async () => true, env: {} })
  const vote = await handler(httpEvent('POST', '/polls/poll-r/votes', { sub: 'voter-1' }, {
    rankedOptionIds: ['candidate-a', 'candidate-b'], ballotCount: 999, winnerOptionId: 'fake',
  }))
  assert.equal(vote.statusCode, 201)
  assert.deepEqual(calls[0], ['vote', 'poll-r', 'voter-1', { rankedOptionIds: ['candidate-a', 'candidate-b'], ballotCount: 999, winnerOptionId: 'fake' }])
  const response = await handler(httpEvent('GET', '/polls/poll-r/results', { sub: 'voter-1' }))
  assert.deepEqual(JSON.parse(response.body).results, { pollId: 'poll-r', ...result })
})

test('WebSocket authorizer allows only a consumed single-use ticket', async () => {
  let consumed = 0
  const handler = createWebSocketAuthorizer({ getRepository: async () => ({ async consumeWsTicket(ticket) {
    consumed += 1
    if (ticket !== 'valid-one-time-ticket') throw new ApiError(401, 'INVALID_TICKET', 'Invalid ticket')
    return { subject: 'subject-1', pollId: 'poll-one', purpose: 'chat' }
  } }) })
  const allowed = await handler({ queryStringParameters: { ticket: 'valid-one-time-ticket' }, methodArn: 'arn:test:connect' })
  assert.equal(allowed.principalId, 'subject-1')
  assert.equal(allowed.context.pollId, 'poll-one')
  assert.equal(allowed.context.purpose, 'chat')
  assert.equal(allowed.policyDocument.Statement[0].Effect, 'Allow')
  const denied = await handler({ queryStringParameters: { ticket: 'reused-ticket' }, methodArn: 'arn:test:connect' })
  assert.equal(denied.policyDocument.Statement[0].Effect, 'Deny')
  assert.equal(consumed, 2)
})

test('WebSocket chat route refuses client-supplied cross-poll IDs', async () => {
  let persisted = 0
  const store = {
    async persistChat() { persisted += 1; return {} },
    async closeConnection() {},
  }
  const handler = createWebSocketHandler({ getRepository: async () => store, send: async () => true })
  const result = await handler({
    requestContext: { routeKey: 'chat.send', connectionId: 'conn-1', authorizer: { principalId: 'subject-1', pollId: 'poll-one', subject: 'subject-1', purpose: 'chat' } },
    body: JSON.stringify({ action: 'chat.send', pollId: 'poll-two', text: 'hello' }),
  })
  assert.equal(result.statusCode, 403)
  assert.equal(persisted, 0)
})

test('HTTP-only first-stage handler does not expose WebSocket ticket or chat routes', async () => {
  const store = { async createWsTicket() { throw new Error('must not be called') }, async listChat() { throw new Error('must not be called') } }
  const handler = createHttpHandler({ getRepository: async () => store, env: {} })
  const ticket = await handler(httpEvent('POST', '/polls/poll-1/ws-ticket', { sub: 'voter-1' }, { purpose: 'chat' }))
  const chat = await handler(httpEvent('GET', '/polls/poll-1/chat', { sub: 'voter-1' }))
  assert.equal(ticket.statusCode, 404)
  assert.equal(chat.statusCode, 404)
})
