import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, createVotingService } from './votingService.js'

function setup(options = {}) {
  let clock = 1_700_000_000_000
  const service = createVotingService({ now: () => clock })
  const create = (overrides = {}) => service.createPoll({
    question: 'Which option?', options: ['A', 'B'], votingType: 'single',
    durationMinutes: 1, resultVisibility: 'live', ...overrides,
  })
  const activePoll = (overrides = {}) => {
    const poll = create(overrides)
    service.startPoll(poll.id)
    return poll
  }
  return { service, create, activePoll, advance: (milliseconds) => { clock += milliseconds }, ...options }
}

function assertApiError(fn, status, includes) {
  assert.throws(fn, (error) => error instanceof ApiError && error.status === status && error.message.includes(includes))
}

test('poll lifecycle creates, lists, reads, starts, and closes a poll', () => {
  const { service, create } = setup()
  const poll = create()
  assert.equal(poll.status, 'draft')
  assert.equal(service.readPoll(poll.id).question, 'Which option?')
  assert.equal(service.listPolls().length, 1)
  assert.equal(service.startPoll(poll.id).status, 'active')
  assert.equal(service.closePoll(poll.id).status, 'closed')
  assertApiError(() => service.startPoll(poll.id), 409, 'Only draft')
})

test('poll creation validates required content and duration', () => {
  const { create } = setup()
  assertApiError(() => create({ question: '   ' }), 400, 'Question is required')
  assertApiError(() => create({ options: ['A', 'A'] }), 400, 'non-empty and unique')
  assertApiError(() => create({ durationMinutes: 0 }), 400, 'Duration must be')
  assertApiError(() => create({ resultVisibility: 'secret' }), 400, 'Invalid result visibility')
})

test('draft polls can be edited or deleted, but active polls cannot be edited', () => {
  const { service, create } = setup()
  const poll = create()
  const edited = service.updatePoll(poll.id, {
    question: 'Updated question?', options: ['New A', 'New B'], votingType: 'multiple',
    votingMode: 'anonymous', durationMinutes: 20, resultVisibility: 'afterClose', chatEnabled: true,
  })
  assert.equal(edited.question, 'Updated question?')
  assert.deepEqual(edited.options.map((option) => option.label), ['New A', 'New B'])
  assert.equal(edited.votingType, 'multiple')
  service.startPoll(poll.id)
  assertApiError(() => service.updatePoll(poll.id, { question: 'Cannot edit?', options: ['A', 'B'] }), 409, 'Only draft')
  const removable = create({ question: 'Draft to delete' })
  assert.deepEqual(service.deletePoll(removable.id), { deleted: true, pollId: removable.id })
  assertApiError(() => service.readPoll(removable.id), 404, 'not found')
})

test('backend voter receipt reports existing votes', () => {
  const { service, activePoll } = setup()
  const poll = activePoll()
  assert.equal(service.hasVoted(poll.id, 'voter').hasVoted, false)
  service.submitVote(poll.id, 'voter', { optionId: poll.options[0].id })
  assert.equal(service.hasVoted(poll.id, 'voter').hasVoted, true)
})

test('the same development identity can vote once in each different poll', () => {
  const { service, activePoll } = setup()
  const first = activePoll()
  const second = activePoll()
  service.submitVote(first.id, 'demo-voter', { optionId: first.options[0].id })
  service.submitVote(second.id, 'demo-voter', { optionId: second.options[1].id })
  assert.equal(service.getResults(first.id).ballotCount, 1)
  assert.equal(service.getResults(second.id).options[1].count, 1)
  assertApiError(() => service.readPoll('missing'), 404, 'not found')
})

test('duplicate voter ballot is rejected and does not change counts', () => {
  const { service, activePoll } = setup()
  const poll = activePoll()
  const accepted = service.submitVote(poll.id, 'voter-1', { optionId: poll.options[0].id })
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.ballotCount, 1)
  const before = service.getResults(poll.id)
  assertApiError(() => service.submitVote(poll.id, 'voter-1', { optionId: poll.options[1].id }), 409, 'You have already voted in this poll. You cannot vote again.')
  assert.deepEqual(service.getResults(poll.id), before)
  assert.equal(service.getResults(poll.id).ballotCount, 1)
  assert.equal(service.getResults(poll.id).options[1].count, 0)
})

test('voter identities are normalized before duplicate checks', () => {
  const { service, activePoll } = setup()
  const poll = activePoll()
  service.submitVote(poll.id, 'voter-1', { optionId: poll.options[0].id })
  assertApiError(() => service.submitVote(poll.id, ' voter-1 ', { optionId: poll.options[1].id }), 409, 'You have already voted in this poll. You cannot vote again.')
  assert.equal(service.getResults(poll.id).ballotCount, 1)
})

test('invalid options and repeated multiple choices are rejected', () => {
  const { service, activePoll } = setup()
  const single = activePoll()
  assertApiError(() => service.submitVote(single.id, 'voter', { optionId: 'not-an-option' }), 400, 'Options must exist')
  const multiple = activePoll({ votingType: 'multiple' })
  assertApiError(() => service.submitVote(multiple.id, 'voter', { optionIds: [multiple.options[0].id, multiple.options[0].id] }), 400, 'may not be repeated')
})

test('ranked ballots accept incomplete rankings, reject invalid rankings, and calculate IRV results', () => {
  const { service, activePoll, create } = setup()
  const poll = activePoll({ votingType: 'ranked', options: ['A', 'B', 'C'] })
  assertApiError(() => service.submitVote(poll.id, 'empty', { rankedOptionIds: [] }), 400, 'at least one')
  assertApiError(() => service.submitVote(poll.id, 'unknown', { rankedOptionIds: ['unknown'] }), 400, 'valid poll options')
  assertApiError(() => service.submitVote(poll.id, 'repeat', { rankedOptionIds: [poll.options[0].id, poll.options[0].id] }), 400, 'only once')
  const [a, b, c] = poll.options.map((option) => option.id)
  service.submitVote(poll.id, 'voter-a', { rankedOptionIds: [a, b] })
  service.submitVote(poll.id, 'voter-b', { rankedOptionIds: [b] })
  service.submitVote(poll.id, 'voter-c', { rankedOptionIds: [b] })
  service.submitVote(poll.id, 'voter-d', { rankedOptionIds: [c] })
  service.submitVote(poll.id, 'voter-e', { rankedOptionIds: [c] })
  assertApiError(() => service.submitVote(poll.id, 'voter-a', { rankedOptionIds: [b] }), 409, 'already voted')
  const result = service.getResults(poll.id)
  assert.equal(result.method, 'instant_runoff')
  assert.equal(result.outcome, 'winner')
  assert.equal(result.winnerOptionId, b)
  assert.equal(result.rounds[0].eliminatedOptionId, a)
  assert.equal(result.rounds[1].tallies.find((tally) => tally.optionId === b).votes, 3)
  assert.deepEqual(service.readPoll(poll.id).votingType, 'ranked')

  const another = create({ votingType: 'ranked', options: ['X', 'Y', 'Z'] })
  assert.equal(another.votingType, 'ranked')
})

test('ranked results report exhausted ballots, unresolved ties, and zero-vote polls', () => {
  const { service, activePoll } = setup()
  const tie = activePoll({ votingType: 'ranked', options: ['A', 'B', 'C'] })
  const [a, b, c] = tie.options.map((option) => option.id)
  service.submitVote(tie.id, 'a-voter', { rankedOptionIds: [a] })
  service.submitVote(tie.id, 'b-voter', { rankedOptionIds: [b] })
  service.submitVote(tie.id, 'c-voter', { rankedOptionIds: [c] })
  const tied = service.getResults(tie.id)
  assert.equal(tied.outcome, 'elimination_tie')
  assert.equal(tied.winnerOptionId, null)
  assert.equal(tied.rounds[0].tiedLowestOptionIds.length, 3)

  const partial = activePoll({ votingType: 'ranked', options: ['A', 'B', 'C'] })
  const [pa, pb, pc] = partial.options.map((option) => option.id)
  service.submitVote(partial.id, 'pa', { rankedOptionIds: [pa] })
  service.submitVote(partial.id, 'pb1', { rankedOptionIds: [pb] })
  service.submitVote(partial.id, 'pb2', { rankedOptionIds: [pb] })
  service.submitVote(partial.id, 'pc1', { rankedOptionIds: [pc] })
  service.submitVote(partial.id, 'pc2', { rankedOptionIds: [pc] })
  const exhausted = service.getResults(partial.id)
  assert.equal(exhausted.rounds[1].exhaustedBallots, 1)
  assert.equal(exhausted.rounds[1].continuingBallots, 4)

  const empty = activePoll({ votingType: 'ranked', options: ['A', 'B', 'C'] })
  assert.equal(service.getResults(empty.id).outcome, 'no_votes')
})

test('closed and expired polls reject votes', () => {
  const { service, activePoll, advance } = setup()
  const closed = activePoll()
  service.closePoll(closed.id)
  assertApiError(() => service.submitVote(closed.id, 'voter', { optionId: closed.options[0].id }), 409, 'not accepting')
  const expired = activePoll()
  advance(60_001)
  assert.equal(service.readPoll(expired.id).status, 'expired')
  assertApiError(() => service.submitVote(expired.id, 'voter', { optionId: expired.options[0].id }), 409, 'not accepting')
})

test('reopening a closed poll resets its duration and preserves votes and results', () => {
  const { service, activePoll, advance } = setup()
  const poll = activePoll({ durationMinutes: 1 })
  const firstOption = poll.options[0].id
  service.submitVote(poll.id, 'existing-voter', { optionId: firstOption })
  const resultBefore = service.getResults(poll.id, 'existing-voter')
  service.closePoll(poll.id)
  advance(30_000)

  const reopened = service.reopenPoll(poll.id)
  assert.equal(reopened.status, 'active')
  assert.equal(reopened.startedAt, 1_700_000_030_000)
  assert.equal(reopened.endsAt, reopened.startedAt + 60_000)
  assert.equal(reopened.ballotCount, 1)
  assert.deepEqual(service.getResults(poll.id, 'existing-voter'), resultBefore)
  assert.equal(service.hasVoted(poll.id, 'existing-voter').hasVoted, true)
  assertApiError(() => service.submitVote(poll.id, 'existing-voter', { optionId: poll.options[1].id }), 409, 'already voted')

  service.submitVote(poll.id, 'new-voter', { optionId: poll.options[1].id })
  const resultsAfter = service.getResults(poll.id, 'new-voter')
  assert.equal(resultsAfter.ballotCount, 2)
  assert.deepEqual(resultsAfter.options.map((option) => option.count), [1, 1])
})

test('expired polls can be reopened, while drafts, active, and deleted polls cannot', () => {
  const { service, create, activePoll, advance } = setup()
  const draft = create()
  assertApiError(() => service.reopenPoll(draft.id), 409, 'Only closed or expired')

  const active = activePoll()
  assertApiError(() => service.reopenPoll(active.id), 409, 'Only closed or expired')

  const expired = activePoll({ durationMinutes: 1 })
  service.submitVote(expired.id, 'voter', { optionId: expired.options[0].id })
  advance(60_001)
  const reopened = service.reopenPoll(expired.id)
  assert.equal(reopened.status, 'active')
  assert.equal(reopened.ballotCount, 1)

  assert.deepEqual(service.deletePoll(draft.id), { deleted: true, pollId: draft.id })
  assertApiError(() => service.reopenPoll(draft.id), 404, 'not found')
  assertApiError(() => service.reopenPoll('archived-poll'), 404, 'not found')
})

test('concurrent submissions from one development voter count exactly once', async () => {
  const { service, activePoll } = setup()
  const poll = activePoll()
  const results = await Promise.allSettled([
    Promise.resolve().then(() => service.submitVote(poll.id, 'same-voter', { optionId: poll.options[0].id })),
    Promise.resolve().then(() => service.submitVote(poll.id, 'same-voter', { optionId: poll.options[1].id })),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1)
  assert.equal(service.getResults(poll.id).ballotCount, 1)
})

test('multiple-choice tallies, percentages, and result visibility are enforced', () => {
  const { service, activePoll } = setup()
  const poll = activePoll({ votingType: 'multiple', resultVisibility: 'afterVote' })
  assertApiError(() => service.getResults(poll.id), 403, 'not visible')
  service.submitVote(poll.id, 'voter-a', { optionIds: [poll.options[0].id, poll.options[1].id] })
  const results = service.getResults(poll.id, 'voter-a')
  assert.equal(results.ballotCount, 1)
  assert.deepEqual(results.options.map((option) => option.count), [1, 1])
  assert.deepEqual(results.options.map((option) => option.percentage), [100, 100])
  assertApiError(() => service.getResults(poll.id, 'other-voter'), 403, 'not visible')

  const afterClose = activePoll({ resultVisibility: 'afterClose' })
  assertApiError(() => service.getResults(afterClose.id), 403, 'not visible')
  service.closePoll(afterClose.id)
  assert.equal(service.getResults(afterClose.id).ballotCount, 0)
})
