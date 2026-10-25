import test from 'node:test'
import assert from 'node:assert/strict'
import QRCode from 'qrcode'
import { buildVoterPollUrl, canSharePoll, isLoopbackVoterUrl } from './pollSharing.js'

test('builds the voter URL on the configured app origin and existing poll route', () => {
  assert.equal(buildVoterPollUrl('poll id/one', { configuredOrigin: 'https://ballot.example/app', currentOrigin: 'http://localhost:5174' }), 'https://ballot.example/poll/poll%20id%2Fone')
})

test('uses the current browser origin when no app origin is configured', () => {
  assert.equal(buildVoterPollUrl('poll-123', { currentOrigin: 'http://localhost:5174' }), 'http://localhost:5174/poll/poll-123')
})

test('requires a valid HTTP(S) origin and a poll ID', () => {
  assert.throws(() => buildVoterPollUrl('', { currentOrigin: 'http://localhost:5174' }), /poll ID/)
  assert.throws(() => buildVoterPollUrl('x', { currentOrigin: 'javascript:alert(1)' }), /HTTP or HTTPS/)
})

test('only published polls can be shared and loopback links are identified', () => {
  assert.equal(canSharePoll({ id: 'p1', status: 'draft' }), false)
  assert.equal(canSharePoll({ id: 'p1', status: 'closed' }), true)
  assert.equal(isLoopbackVoterUrl('http://localhost:5174/poll/p1'), true)
  assert.equal(isLoopbackVoterUrl('https://ballot.example/poll/p1'), false)
})

test('QR encoder produces a downloadable PNG data URL for a voter route', async () => {
  const url = buildVoterPollUrl('poll-123', { currentOrigin: 'https://ballot.example' })
  const image = await QRCode.toDataURL(url, { width: 120, margin: 1 })
  assert.match(image, /^data:image\/png;base64,/)
})
