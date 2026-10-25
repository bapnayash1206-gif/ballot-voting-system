import test from 'node:test'
import assert from 'node:assert/strict'
import { moveRankingItem } from './ranking.js'

test('ranking controls move one candidate while preserving unique order', () => {
  assert.deepEqual(moveRankingItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b'])
  assert.deepEqual(moveRankingItem(['a', 'b'], 0, 1), ['b', 'a'])
  assert.deepEqual(moveRankingItem(['a', 'b'], 0, -1), ['a', 'b'])
  assert.deepEqual(moveRankingItem(['a', 'b'], 1, 1), ['a', 'b'])
})
