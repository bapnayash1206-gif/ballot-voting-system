import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateIrvResults, validateRanking } from '../src/shared/irv.js'

const options = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]
const ballots = (...rankings) => rankings.map((rankedOptionIds) => ({ voteData: { rankedOptionIds } }))

test('rank validation accepts unique partial rankings and rejects empty, unknown, or repeated IDs', () => {
  assert.equal(validateRanking(['a', 'c'], ['a', 'b', 'c']), null)
  assert.match(validateRanking([], ['a', 'b', 'c']), /at least one/)
  assert.match(validateRanking(['a', 'x'], ['a', 'b', 'c']), /valid/)
  assert.match(validateRanking(['a', 'a'], ['a', 'b', 'c']), /only once/)
})

test('IRV detects a strict majority and stops at zero ballots', () => {
  const result = calculateIrvResults(options, ballots(['a'], ['a', 'b'], ['b']))
  assert.equal(result.outcome, 'winner')
  assert.equal(result.winnerOptionId, 'a')
  assert.equal(result.rounds[0].continuingBallots, 3)
  const empty = calculateIrvResults(options, [])
  assert.equal(empty.outcome, 'no_votes')
  assert.equal(empty.winnerOptionId, null)
})

test('IRV transfers preferences, records eliminations, and counts exhausted ballots', () => {
  const result = calculateIrvResults(options, ballots(['a', 'b'], ['b'], ['b'], ['c'], ['c']))
  assert.equal(result.outcome, 'winner')
  assert.equal(result.winnerOptionId, 'b')
  assert.equal(result.rounds[0].eliminatedOptionId, 'a')
  assert.equal(result.rounds[1].tallies.find((entry) => entry.optionId === 'b').votes, 3)

  const exhausted = calculateIrvResults(options, ballots(['a'], ['b'], ['c']))
  assert.equal(exhausted.outcome, 'elimination_tie')
  assert.deepEqual(exhausted.tieOptionIds.sort(), ['a', 'b', 'c'])

  const partial = calculateIrvResults(options, ballots(['a'], ['b'], ['b'], ['c'], ['c']))
  assert.equal(partial.rounds[0].eliminatedOptionId, 'a')
  assert.equal(partial.rounds[1].exhaustedBallots, 1)
  assert.equal(partial.rounds[1].continuingBallots, 4)
  assert.equal(partial.outcome, 'elimination_tie')
})

test('IRV stops without arbitrary elimination when the lowest count is tied', () => {
  const result = calculateIrvResults(options, ballots(['a'], ['b'], ['c'], ['c']))
  assert.equal(result.outcome, 'elimination_tie')
  assert.equal(result.winnerOptionId, null)
  assert.deepEqual(result.tieOptionIds.sort(), ['a', 'b'])
  assert.deepEqual(result.rounds[0].tiedLowestOptionIds.sort(), ['a', 'b'])
})
