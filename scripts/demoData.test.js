import test from 'node:test'
import assert from 'node:assert/strict'
import { DEMO_BALLOT_PLANS, DEMO_POLLS, DEMO_VOTERS, formatCredentialEntries, generateTemporaryPassword, parseCredentialReport } from './demoData.js'

test('demo seed definitions use ten unique voter usernames and three distinct supported poll types', () => {
  assert.equal(DEMO_VOTERS.length, 10)
  assert.equal(new Set(DEMO_VOTERS).size, 10)
  assert.equal(DEMO_POLLS.length, 3)
  assert.deepEqual(DEMO_POLLS.map((poll) => poll.votingType), ['single', 'multiple', 'ranked'])
  assert.deepEqual(DEMO_POLLS.map((poll) => poll.desiredStatus), ['active', 'active', 'closed'])
})

test('demo ballot plans use valid option indexes and leave some voters without votes', () => {
  for (const poll of DEMO_POLLS) {
    for (const [voterIndex, ranking] of DEMO_BALLOT_PLANS[poll.key]) {
      assert.ok(DEMO_VOTERS[voterIndex])
      assert.ok(ranking.length > 0)
      assert.ok(ranking.every((optionIndex) => Number.isInteger(optionIndex) && optionIndex >= 0 && optionIndex < poll.options.length))
      if (poll.votingType === 'ranked') assert.equal(new Set(ranking).size, ranking.length)
    }
  }
  assert.ok(DEMO_VOTERS.length > new Set(Object.values(DEMO_BALLOT_PLANS).flatMap((plan) => plan.map(([index]) => index))).size)
})

test('temporary credentials are random url-safe strings and report serialization is local-friendly', () => {
  const password = generateTemporaryPassword()
  assert.match(password, /^[A-Za-z0-9_-]{24}$/)
  const entries = [{ username: 'demo_voter01', password }, { username: 'demo_voter02', password: generateTemporaryPassword() }]
  const serialized = formatCredentialEntries(entries)
  assert.deepEqual([...parseCredentialReport(serialized)], entries.map(({ username, password: value }) => [username, value]))
  assert.deepEqual([...parseCredentialReport('demo_voter03\tbad')], [])
})
