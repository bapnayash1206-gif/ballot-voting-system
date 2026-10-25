import test from 'node:test'
import assert from 'node:assert/strict'
import { accountBackend } from './accountBackend.js'

test('account API uses same-origin cookies and does not send mock identity headers', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, async json() { return { user: { role: 'voter' } } } }
  }
  try {
    await accountBackend.getCurrentUser()
    await accountBackend.login({ username: 'student', password: 'private-input', accountType: 'voter' })
    assert.equal(calls[0].options.credentials, 'same-origin')
    assert.deepEqual(calls[0].options.headers, {})
    assert.equal(calls[0].url, '/api/auth/me')
    assert.deepEqual(calls[1].options.headers, { 'content-type': 'application/json' })
    assert.deepEqual(JSON.parse(calls[1].options.body), { username: 'student', password: 'private-input', accountType: 'voter' })
    assert.equal(Object.keys(calls[1].options.headers).some((key) => key.startsWith('x-dev-')), false)
  } finally { globalThis.fetch = originalFetch }
})

test('account API returns backend authentication errors without a mock identity fallback', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401, async json() { return { error: 'Username or password is incorrect.' } } })
  try {
    await assert.rejects(accountBackend.login({ username: 'student', password: 'wrong', accountType: 'voter' }), /Username or password is incorrect/)
  } finally { globalThis.fetch = originalFetch }
})

test('account API submits only the passphrase to the authenticated backup route', async () => {
  const originalFetch = globalThis.fetch
  let call
  globalThis.fetch = async (url, options) => { call = { url, options }; return { ok: true, async json() { return { backup: { filename: 'ballot-backup-test.json' } } } } }
  try {
    const passphrase = 'never log this backup passphrase'
    await accountBackend.createEncryptedBackup(passphrase)
    assert.equal(call.url, '/api/admin/backup/export')
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(call.options.body), { passphrase })
    assert.equal(Object.keys(call.options.headers).some((name) => name.startsWith('x-dev-')), false)
  } finally { globalThis.fetch = originalFetch }
})