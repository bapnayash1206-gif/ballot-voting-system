import test from 'node:test'
import assert from 'node:assert/strict'
import { mockBackend } from './mockBackend.js'

test('poll API client sends dashboard reads through the Vite proxy', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return { ok: true, json: async () => ({ polls: [] }) }
  }
  try {
    assert.deepEqual(await mockBackend.listPolls(), { polls: [] })
    assert.equal(request.url, '/api/polls')
    assert.equal(request.options.method, 'GET')
  } finally { globalThis.fetch = originalFetch }
})

test('poll API client sends creation data and development admin header', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return { ok: true, json: async () => ({ poll: { id: 'new-poll' } }) }
  }
  const pollData = { question: 'Question?', options: ['A', 'B'] }
  try {
    assert.deepEqual(await mockBackend.createPoll(pollData), { poll: { id: 'new-poll' } })
    assert.equal(request.url, '/api/polls')
    assert.equal(request.options.headers['x-dev-admin-id'], 'local-admin')
    assert.deepEqual(JSON.parse(request.options.body), pollData)
  } finally { globalThis.fetch = originalFetch }
})

test('poll API client rejects backend errors instead of reporting success', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'You have already voted in this poll. You cannot vote again.' }) })
  try {
    await assert.rejects(mockBackend.submitVote('poll-id', { optionId: 'option-id' }), /^Error: You have already voted in this poll\. You cannot vote again\.$/)
  } finally { globalThis.fetch = originalFetch }
})

test('poll API client sends reopen requests to the lifecycle route', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return { ok: true, json: async () => ({ poll: { status: 'active' } }) }
  }
  try {
    await mockBackend.reopenPoll('poll-id')
    assert.equal(request.url, '/api/polls/poll-id/reopen')
    assert.equal(request.options.method, 'POST')
    assert.equal(request.options.headers['x-dev-admin-id'], 'local-admin')
  } finally { globalThis.fetch = originalFetch }
})

test('poll API client handles a non-JSON error response without masking HTTP failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not JSON') } })
  try {
    await assert.rejects(mockBackend.listPolls(), /API request failed \(502\)/)
  } finally { globalThis.fetch = originalFetch }
})

test('poll API client explains a timed-out local backend request', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }
  try {
    await assert.rejects(mockBackend.listPolls(), /did not respond within 5 seconds/)
  } finally { globalThis.fetch = originalFetch }
})
