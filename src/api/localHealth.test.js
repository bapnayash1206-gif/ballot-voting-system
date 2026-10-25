import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLocalApiHealth } from './localHealth.js'

test('checks the same-origin local API health endpoint without caching', async () => {
  let requestedUrl
  let options
  const health = await checkLocalApiHealth({ fetchImpl: async (url, requestOptions) => {
    requestedUrl = url
    options = requestOptions
    return { ok: true, json: async () => ({ ok: true, mode: 'development-only in-memory mock' }) }
  } })

  assert.equal(requestedUrl, '/api/health')
  assert.equal(options.cache, 'no-store')
  assert.equal(health.mode, 'development-only in-memory mock')
})

test('reports unhealthy API responses instead of treating them as connected', async () => {
  await assert.rejects(checkLocalApiHealth({ fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false }) }) }), /unavailable/)
})

test('reports an unreachable local API', async () => {
  await assert.rejects(checkLocalApiHealth({ fetchImpl: async () => { throw new TypeError('offline') } }), /unreachable/)
})
