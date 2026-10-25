import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createBackupService, validateBackupFile } from './backupService.js'
import { accountAuth } from './accountService.js'
import { createRequestHandler } from './index.js'
import { createVotingService } from './votingService.js'

const passphrase = 'another local backup passphrase'
const users = {
  admin: { id: 'admin-id', sub: 'admin-id', username: 'samarth', role: 'admin', mustChangePassword: false },
  voter: { id: 'voter-id', sub: 'voter-id', username: 'student', role: 'voter', mustChangePassword: false },
}

function makeCall(handler) {
  return async (method, url, { session, body, headers = {} } = {}) => {
    const request = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
      method, url, headers: { host: '127.0.0.1', cookie: session ? accountAuth.cookie(session).split(';')[0] : '', ...headers },
    })
    const response = new EventEmitter()
    response.writableEnded = false
    response.writeHead = (status, responseHeaders = {}) => { response.statusCode = status; response.headers = responseHeaders }
    response.end = (output) => { response.output = output; response.writableEnded = true }
    await handler(request, response)
    return { status: response.statusCode, headers: response.headers, payload: response.output ? JSON.parse(response.output) : null }
  }
}

function makeState() {
  const voting = createVotingService({ now: () => 1_800_000_000_000 })
  const poll = voting.createPoll({ question: 'Secret choice?', options: ['Option A', 'Option B'], votingType: 'single' })
  voting.startPoll(poll.id)
  voting.submitVote(poll.id, users.voter.id, { optionId: poll.options[1].id })
  return voting
}

test('only a signed-in Admin can request the encrypted backup; voter and missing sessions are denied', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-backup-test-'))
  try {
    const voting = makeState()
    const backupService = createBackupService({ directory })
    const accountService = { userForSession: (session) => users[session] || null }
    const call = makeCall(createRequestHandler(voting, { authMode: 'accounts', accountService, backupService }))
    assert.equal((await call('POST', '/api/admin/backup/export', { body: { passphrase } })).status, 401)
    assert.equal((await call('POST', '/api/admin/backup/export', { session: 'voter', body: { passphrase } })).status, 403)
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(directory)), [])
    const before = voting.exportSnapshot()
    const result = await call('POST', '/api/admin/backup/export', { session: 'admin', body: { passphrase } })
    assert.equal(result.status, 201)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.payload.backup.pollCount, 1)
    assert.equal(result.payload.backup.ballotCount, 1)
    assert.equal(result.payload.backup.filePath, undefined)
    assert.deepEqual(voting.exportSnapshot(), before)
    const summary = await validateBackupFile(join(directory, result.payload.backup.filename), passphrase)
    assert.equal(summary.pollCount, 1)
    assert.equal(summary.ballotCount, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('mock/development identity and client-supplied snapshots cannot create a backup', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-backup-test-'))
  try {
    const voting = makeState()
    const backupService = createBackupService({ directory })
    const devCall = makeCall(createRequestHandler(voting, { authMode: 'development', backupService }))
    assert.equal((await devCall('POST', '/api/admin/backup/export', { body: { passphrase }, headers: { 'x-dev-voter-id': 'spoofed', 'x-dev-admin-id': 'spoofed-admin' } })).status, 403)
    const accountService = { userForSession: (session) => users[session] || null }
    const accountCall = makeCall(createRequestHandler(voting, { authMode: 'accounts', accountService, backupService }))
    assert.equal((await accountCall('POST', '/api/admin/backup/export', { session: 'admin', body: { passphrase, snapshot: { polls: [] } } })).status, 400)
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(directory)), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('allowlisted Google Admin can export while an authenticated non-admin is denied', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-backup-test-'))
  try {
    const voting = makeState()
    const backupService = createBackupService({ directory })
    const handler = createRequestHandler(voting, {
      authMode: 'google', adminSubjects: new Set(['google-admin-sub']),
      verifyToken: async (token) => token === 'admin-token' ? { sub: 'google-admin-sub', name: 'Admin' } : { sub: 'voter-sub', name: 'Voter' },
      backupService,
    })
    const call = makeCall(handler)
    assert.equal((await call('POST', '/api/admin/backup/export', { headers: { authorization: 'Bearer voter-token' }, body: { passphrase } })).status, 403)
    assert.equal((await call('POST', '/api/admin/backup/export', { headers: { authorization: 'Bearer admin-token' }, body: { passphrase } })).status, 201)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('backup failure logging excludes passphrase and voter data', async () => {
  const voting = makeState()
  const accountService = { userForSession: (session) => users[session] || null }
  const handler = createRequestHandler(voting, {
    authMode: 'accounts', accountService,
    backupService: { writeBackup: async () => { throw new Error(`${passphrase} voter-id-sensitive`) } },
  })
  const call = makeCall(handler)
  const originalError = console.error
  const logs = []
  console.error = (value) => logs.push(String(value))
  try {
    const result = await call('POST', '/api/admin/backup/export', { session: 'admin', body: { passphrase } })
    assert.equal(result.status, 500)
    assert.equal(logs.length, 1)
    assert.doesNotMatch(logs[0], /passphrase|voter-id-sensitive/)
  } finally { console.error = originalError }
})
