import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createRequestHandler } from './index.js'
import { createVotingService } from './votingService.js'

test('GET /health returns HTTP 200 and JSON status ok', async () => {
  const handler = createRequestHandler()
  let statusCode
  let payload
  const response = {
    writeHead(status, headers) { statusCode = status; assert.match(headers['content-type'], /application\/json/) },
    end(body) { payload = JSON.parse(body) },
  }
  await handler({ method: 'GET', url: '/health', headers: { host: '127.0.0.1' } }, response)
  assert.equal(statusCode, 200)
  assert.deepEqual(payload, { status: 'ok' })
})

test('poll routes reject malformed IDs with HTTP 400', async () => {
  const handler = createRequestHandler()
  let statusCode
  let payload
  const response = {
    writeHead(status) { statusCode = status },
    end(body) { payload = JSON.parse(body) },
  }
  await handler({ method: 'GET', url: '/api/polls/not-a-uuid', headers: { host: '127.0.0.1' } }, response)
  assert.equal(statusCode, 400)
  assert.deepEqual(payload, { error: 'Poll ID must be a UUID' })
})

test('vote route rejects a duplicate identity with the exact message and HTTP 409', async () => {
  const service = createVotingService()
  const poll = service.createPoll({ question: 'Question?', options: ['A', 'B'] })
  service.startPoll(poll.id)
  const handler = createRequestHandler(service)
  const makeRequest = (optionId) => Object.assign(Readable.from([JSON.stringify({ optionId })]), {
    method: 'POST',
    url: `/api/polls/${poll.id}/votes`,
    headers: { host: '127.0.0.1', 'x-dev-voter-id': 'same-voter' },
  })
  const call = async (request) => {
    let statusCode
    let payload
    const response = {
      writeHead(status) { statusCode = status },
      end(body) { payload = JSON.parse(body) },
    }
    await handler(request, response)
    return { statusCode, payload }
  }

  assert.equal((await call(makeRequest(poll.options[0].id))).statusCode, 201)
  const duplicate = await call(makeRequest(poll.options[1].id))
  assert.equal(duplicate.statusCode, 409)
  assert.deepEqual(duplicate.payload, { error: 'You have already voted in this poll. You cannot vote again.' })
  assert.equal(service.getResults(poll.id).ballotCount, 1)
})

test('Google mode rejects missing tokens and does not trust development identity headers', async () => {
  const handler = createRequestHandler(createVotingService(), {
    authMode: 'google', adminSubjects: new Set(['admin-sub']),
    verifyToken: async (token) => ({ sub: token === 'admin-token' ? 'admin-sub' : 'voter-sub', email: 'person@example.test' }),
  })
  const call = async (url, headers = {}) => {
    let statusCode
    let payload
    const response = { writeHead(status) { statusCode = status }, end(body) { payload = JSON.parse(body) } }
    const request = Object.assign(Readable.from([]), { method: 'GET', url, headers: { host: '127.0.0.1', ...headers } })
    await handler(request, response)
    return { statusCode, payload }
  }

  assert.equal((await call('/api/polls', { 'x-dev-admin-id': 'pretend-admin', 'x-dev-voter-id': 'pretend-voter' })).statusCode, 401)
  const voter = await call('/api/auth/me', { authorization: 'Bearer voter-token', 'x-dev-admin-id': 'pretend-admin' })
  assert.equal(voter.statusCode, 200)
  assert.equal(voter.payload.isAdmin, false)
  assert.equal(voter.payload.user.sub, 'voter-sub')
})

test('Google mode authorizes poll administration only for the backend subject allowlist', async () => {
  const handler = createRequestHandler(createVotingService(), {
    authMode: 'google', adminSubjects: new Set(['admin-sub']),
    verifyToken: async (token) => ({ sub: token === 'admin-token' ? 'admin-sub' : 'voter-sub' }),
  })
  const call = async (token) => {
    let statusCode
    let payload
    const response = { writeHead(status) { statusCode = status }, end(body) { payload = JSON.parse(body) } }
    const request = Object.assign(Readable.from([JSON.stringify({ question: 'Question?', options: ['A', 'B'] })]), {
      method: 'POST', url: '/api/polls', headers: { host: '127.0.0.1', authorization: `Bearer ${token}`, 'x-dev-admin-id': 'forged-admin' },
    })
    await handler(request, response)
    return { statusCode, payload }
  }
  assert.equal((await call('voter-token')).statusCode, 403)
  assert.equal((await call('admin-token')).statusCode, 201)
})

test('Google mode enforces one vote per verified subject and poll', async () => {
  const service = createVotingService()
  const poll = service.createPoll({ question: 'Google identity ballot?', options: ['A', 'B'] })
  service.startPoll(poll.id)
  const handler = createRequestHandler(service, {
    authMode: 'google', adminSubjects: new Set(), verifyToken: async () => ({ sub: 'verified-google-sub' }),
  })
  const call = async (optionId) => {
    let statusCode
    let payload
    const response = { writeHead(status) { statusCode = status }, end(body) { payload = JSON.parse(body) } }
    const request = Object.assign(Readable.from([JSON.stringify({ optionId })]), {
      method: 'POST', url: `/api/polls/${poll.id}/votes`,
      headers: { host: '127.0.0.1', authorization: 'Bearer verified-token' },
    })
    await handler(request, response)
    return { statusCode, payload }
  }
  assert.equal((await call(poll.options[0].id)).statusCode, 201)
  const duplicate = await call(poll.options[1].id)
  assert.equal(duplicate.statusCode, 409)
  assert.equal(duplicate.payload.error, 'You have already voted in this poll. You cannot vote again.')
  assert.equal(service.getResults(poll.id, 'verified-google-sub').ballotCount, 1)
})

test('local account login sets an HttpOnly session cookie and returns only the backend role', async () => {
  const accountService = {
    async login(input) {
      assert.equal(input.username, 'voter')
      assert.equal(input.accountType, 'voter')
      return { token: 'opaque-session-token', user: { id: 'voter-id', sub: 'voter-id', username: 'voter', name: 'Voter', role: 'voter', mustChangePassword: false } }
    },
    userForSession(token) {
      assert.equal(token, 'opaque-session-token')
      return { id: 'voter-id', sub: 'voter-id', username: 'voter', name: 'Voter', role: 'voter', mustChangePassword: false }
    },
  }
  const handler = createRequestHandler(createVotingService(), { authMode: 'accounts', accountService })
  const call = async (method, url, { headers = {}, body } = {}) => {
    let statusCode
    let responseHeaders
    let payload
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: { host: 'localhost', ...headers } })
    const response = { writeHead(status, value) { statusCode = status; responseHeaders = value }, end(data) { payload = data ? JSON.parse(data) : null } }
    await handler(request, response)
    return { statusCode, responseHeaders, payload }
  }

  const login = await call('POST', '/api/auth/login', { body: { username: 'voter', password: 'input-secret', accountType: 'voter' } })
  assert.equal(login.statusCode, 200)
  assert.match(login.responseHeaders['set-cookie'], /HttpOnly/)
  assert.match(login.responseHeaders['set-cookie'], /SameSite=Strict/)
  assert.equal(JSON.stringify(login.payload).includes('opaque-session-token'), false)
  assert.equal(Object.hasOwn(login.payload.user, 'passwordHash'), false)

  const me = await call('GET', '/api/auth/me', { headers: { cookie: 'ballot_session=opaque-session-token' } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.payload.isAdmin, false)
})

test('local account mode requires a session and rejects voters from admin and vote APIs by role', async () => {
  const service = createVotingService()
  const poll = service.createPoll({ question: 'Accounts?', options: ['Yes', 'No'] })
  service.startPoll(poll.id)
  const voter = { id: 'voter-id', sub: 'voter-id', username: 'voter', role: 'voter', name: 'Voter', mustChangePassword: false }
  const admin = { id: 'admin-id', sub: 'admin-id', username: 'samarth', role: 'admin', name: 'Samarth', mustChangePassword: false }
  const accountService = {
    userForSession(token) { return token === 'voter-token' ? voter : token === 'admin-token' ? admin : null },
  }
  const handler = createRequestHandler(service, { authMode: 'accounts', accountService })
  const call = async (method, url, cookie, body) => {
    let statusCode
    let payload
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      method, url, headers: { host: 'localhost', ...(cookie ? { cookie: `ballot_session=${cookie}` } : {}) },
    })
    const response = { writeHead(status) { statusCode = status }, end(data) { payload = data ? JSON.parse(data) : null } }
    await handler(request, response)
    return { statusCode, payload }
  }
  assert.equal((await call('GET', '/api/polls')).statusCode, 401)
  const voterPolls = await call('GET', '/api/polls', 'voter-token')
  assert.equal(voterPolls.statusCode, 200)
  assert.equal(voterPolls.payload.polls[0].ballotCount, undefined)
  const adminPolls = await call('GET', '/api/polls', 'admin-token')
  assert.equal(adminPolls.payload.polls[0].ballotCount, 0)
  assert.equal((await call('POST', '/api/polls', 'voter-token', { question: 'Unauthorized?', options: ['A', 'B'] })).statusCode, 403)
  for (const [method, path, body] of [
    ['PATCH', `/api/polls/${poll.id}`, { question: 'Tampered?' }],
    ['DELETE', `/api/polls/${poll.id}`],
    ['POST', `/api/polls/${poll.id}/start`],
    ['POST', `/api/polls/${poll.id}/close`],
    ['POST', `/api/polls/${poll.id}/reopen`],
  ]) {
    assert.equal((await call(method, path, 'voter-token', body)).statusCode, 403, `${method} ${path} must be admin-only`)
  }
  assert.equal((await call('POST', `/api/polls/${poll.id}/votes`, 'admin-token', { optionId: poll.options[0].id })).statusCode, 403)
  assert.equal((await call('POST', '/api/polls', 'admin-token', { question: 'Authorized?', options: ['A', 'B'] })).statusCode, 201)
})

test('local registration assigns voter role and logout clears the session cookie', async () => {
  let seenRegistration
  const accountService = {
    async registerVoter(body) { seenRegistration = body; return { id: 'voter-id', username: body.username, role: 'voter' } },
    logout(token) { assert.equal(token, 'opaque-session-token') },
  }
  const handler = createRequestHandler(createVotingService(), { authMode: 'accounts', accountService })
  const call = async (method, url, { headers = {}, body } = {}) => {
    let statusCode
    let responseHeaders
    let payload
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, url, headers: { host: 'localhost', ...headers } })
    const response = { writeHead(status, value) { statusCode = status; responseHeaders = value }, end(data) { payload = data ? JSON.parse(data) : null } }
    await handler(request, response)
    return { statusCode, responseHeaders, payload }
  }
  const registration = await call('POST', '/api/auth/register', { body: { username: 'voter', password: 'VoterPass!123', confirmPassword: 'VoterPass!123' } })
  assert.equal(registration.statusCode, 201)
  assert.equal(seenRegistration.role, undefined)
  assert.equal(registration.payload.user.role, 'voter')
  const logout = await call('POST', '/api/auth/logout', { headers: { cookie: 'ballot_session=opaque-session-token' } })
  assert.equal(logout.statusCode, 200)
  assert.match(logout.responseHeaders['set-cookie'], /Max-Age=0/)
})

test('backend blocks all poll APIs for an administrator until the initial password is changed', async () => {
  const service = createVotingService()
  const admin = { id: 'admin-id', sub: 'admin-id', username: 'samarth', role: 'admin', name: 'Samarth', mustChangePassword: true }
  const accountService = { userForSession: () => admin, async changePassword() { return { ...admin, mustChangePassword: false } } }
  const handler = createRequestHandler(service, { authMode: 'accounts', accountService })
  const call = async (method, url, body) => {
    let statusCode
    let payload
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      method, url, headers: { host: 'localhost', cookie: 'ballot_session=initial-admin-session' },
    })
    const response = { writeHead(status) { statusCode = status }, end(data) { payload = data ? JSON.parse(data) : null } }
    await handler(request, response)
    return { statusCode, payload }
  }
  const blocked = await call('GET', '/api/polls')
  assert.equal(blocked.statusCode, 403)
  assert.match(blocked.payload.error, /Change the initial password/)
  assert.equal((await call('POST', '/api/auth/password', { currentPassword: 'Initial!123', newPassword: 'Changed!1234', confirmPassword: 'Changed!1234' })).statusCode, 200)
})
