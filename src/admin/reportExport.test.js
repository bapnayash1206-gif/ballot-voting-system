import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPollReportsCsv, closePollsIndividually, collectPollReports, escapeCsvCell } from './reportExport.js'
import { togglePollSelection, toggleVisiblePollSelection } from './reportExport.js'

const published = { id: 'p1', question: '=HYPERLINK("http://evil")', status: 'closed', votingType: 'single', createdAt: 1_700_000_000_000, startedAt: 1_700_000_100_000, endsAt: 1_700_000_200_000 }

test('CSV escapes spreadsheet formulas, quotes, commas, and line breaks', () => {
  assert.equal(escapeCsvCell(' =1+1'), '"\' =1+1"')
  assert.equal(escapeCsvCell('\u0000=1+1'), '"\'\u0000=1+1"')
  assert.equal(escapeCsvCell('@SUM(A1)'), '"\'@SUM(A1)"')
  assert.equal(escapeCsvCell('A,"B"\nC'), '"A,""B""\nC"')
})

test('collects only published polls and preserves result visibility errors as per-poll failures', async () => {
  const calls = []
  const { reports, failures } = await collectPollReports([
    { id: 'draft', status: 'draft', question: 'Draft' },
    published,
    { id: 'hidden', status: 'closed', question: 'Hidden' },
  ], async (id) => {
    calls.push(id)
    if (id === 'hidden') throw new Error('Results are not visible to this caller yet')
    return { results: { ballotCount: 1, options: [] } }
  })
  assert.deepEqual(calls, ['p1', 'hidden'])
  assert.deepEqual(reports.map(({ poll }) => poll.id), ['p1'])
  assert.deepEqual(failures.map(({ poll, reason }) => [poll.id, reason]), [
    ['draft', 'Draft polls do not have voter-visible results.'],
    ['hidden', 'Results are not visible to this caller yet'],
  ])
})

test('CSV contains backend option counts and poll timestamps with no voter identity fields', () => {
  const csv = buildPollReportsCsv([{ poll: published, results: { ballotCount: 3, options: [
    { id: 'a', label: 'Yes', count: 2, percentage: 66.666 },
    { id: 'b', label: 'No', count: 1, percentage: 33.333 },
  ] } }])
  assert.match(csv, /poll_summary/)
  assert.match(csv, /option_result/)
  assert.match(csv, /Yes/)
  assert.match(csv, /66\.67/)
  assert.match(csv, /2023-11-14T22:13:20\.000Z/)
  assert.match(csv, /"'=/)
  assert.doesNotMatch(csv, /password|token|voter_id/i)
})

test('CSV includes ranked-choice rounds, exhausted ballots, eliminations, and winner', () => {
  const csv = buildPollReportsCsv([{ poll: { ...published, votingType: 'ranked' }, results: {
    method: 'instant_runoff', ballotCount: 4, outcome: 'winner', winnerLabel: 'Candidate B', rounds: [{ round: 1, continuingBallots: 4, exhaustedBallots: 1, eliminatedOptionId: 'a', tiedLowestOptionIds: [], tallies: [
      { optionId: 'a', label: 'Candidate A', votes: 1 }, { optionId: 'b', label: 'Candidate B', votes: 3 },
    ] }],
  } }])
  assert.match(csv, /ranked_round/)
  assert.match(csv, /Candidate A/)
  assert.match(csv, /"1","4","1","yes","no","Winner: Candidate B"/)
})

test('bulk close returns successful polls and backend failures separately', async () => {
  const polls = [{ id: 'a', question: 'Poll A' }, { id: 'b', question: 'Poll B' }]
  const result = await closePollsIndividually(polls, async (id) => { if (id === 'b') throw new Error('Already closed') })
  assert.deepEqual(result.succeeded.map((poll) => poll.id), ['a'])
  assert.deepEqual(result.failures.map(({ poll, reason }) => [poll.id, reason]), [['b', 'Already closed']])
})

test('selection toggles individual rows and the currently visible subset', () => {
  assert.deepEqual(togglePollSelection(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(togglePollSelection(['a', 'b'], 'a'), ['b'])
  assert.deepEqual(toggleVisiblePollSelection(['a'], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(toggleVisiblePollSelection(['a', 'b', 'c'], ['a', 'b']), ['c'])
})
