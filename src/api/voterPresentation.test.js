import test from 'node:test'
import assert from 'node:assert/strict'
import { canVoterSeePollCounts, isClosingSoon, matchesVoterPoll, voterEmptyState, voterIdentityNotice } from './voterPresentation.js'

test('live results may show counts while a poll is active', () => {
  assert.equal(canVoterSeePollCounts({ visibility: 'live' }, 'active', false), true)
})

test('after-vote counts stay hidden until this identity has voted', () => {
  const poll = { visibility: 'after-vote' }
  assert.equal(canVoterSeePollCounts(poll, 'active', false), false)
  assert.equal(canVoterSeePollCounts(poll, 'closed', false), false)
  assert.equal(canVoterSeePollCounts(poll, 'active', true), true)
})

test('after-close counts stay hidden while open and appear after closure', () => {
  const poll = { visibility: 'after-close' }
  assert.equal(canVoterSeePollCounts(poll, 'active', true), false)
  assert.equal(canVoterSeePollCounts(poll, 'closed', false), true)
  assert.equal(canVoterSeePollCounts(poll, 'expired', false), true)
})

test('voter search matches only real poll fields including optional descriptions', () => {
  const poll = { id: 'poll-123', question: 'Campus lunch', description: 'Choose a dining hall', options: [{ label: 'North Cafe' }] }
  assert.equal(matchesVoterPoll(poll, 'dining hall'), true)
  assert.equal(matchesVoterPoll(poll, 'north cafe'), true)
  assert.equal(matchesVoterPoll(poll, 'poll-123'), true)
  assert.equal(matchesVoterPoll(poll, 'fabricated'), false)
  assert.equal(matchesVoterPoll(poll, '   '), true)
})

test('closing soon requires a future active poll end time within the configured window', () => {
  const now = Date.UTC(2026, 0, 1)
  assert.equal(isClosingSoon({ endsAt: now + 60_000 }, 'active', now), true)
  assert.equal(isClosingSoon({ endsAt: now + 25 * 60 * 60 * 1000 }, 'active', now), false)
  assert.equal(isClosingSoon({ endsAt: now - 1 }, 'active', now), false)
  assert.equal(isClosingSoon({ endsAt: now + 60_000 }, 'closed', now), false)
  assert.equal(isClosingSoon({ endsAt: 'not-a-date' }, 'active', now), false)
})

test('voter empty states distinguish unpublished polls from unavailable voting history', () => {
  assert.match(voterEmptyState({ filter: 'all' }).description, /Drafts are hidden from voters/)
  assert.match(voterEmptyState({ filter: 'voted', historyError: true }).description, /cannot confirm your activity/)
  assert.match(voterEmptyState({ query: 'winter' }).description, /different search term/)
})

test('voter identity guidance matches the configured local authentication mode', () => {
  assert.match(voterIdentityNotice({ accountMode: true }), /signed-in voter account/)
  assert.match(voterIdentityNotice({ googleMode: true }), /verified Google identity/)
  assert.match(voterIdentityNotice({}), /shared voter identity/)
  assert.match(voterIdentityNotice({ audience: 'anonymous', accountMode: true }), /not production-secure anonymous voting/)
  assert.match(voterIdentityNotice({ audience: 'anonymous', googleMode: true }), /verified Google identity/)
  assert.match(voterIdentityNotice({ audience: 'anonymous' }), /shared development identity/)
})
