import { randomUUID } from 'node:crypto'
import { calculateIrvResults, validateRanking } from '../aws/src/shared/irv.js'

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const fail = (status, message) => { throw new ApiError(status, message) }

export function createVotingService({ now = () => Date.now() } = {}) {
  // DEVELOPMENT ONLY: process memory is neither durable nor shared between instances.
  const polls = new Map()

  function getPoll(pollId) {
    const poll = polls.get(pollId)
    if (!poll) fail(404, 'Poll not found')
    return poll
  }

  function effectiveStatus(poll) {
    return poll.status === 'active' && poll.endsAt !== null && now() >= poll.endsAt ? 'expired' : poll.status
  }

  function serialize(poll) {
    const safePoll = { ...poll }
    delete safePoll.ballots
    delete safePoll.counts
    return { ...safePoll, status: effectiveStatus(poll) }
  }

  function createPoll(input = {}) {
    if (typeof input.question !== 'string' || !input.question.trim()) fail(400, 'Question is required')
    if (!Array.isArray(input.options) || input.options.length < 2) fail(400, 'At least two options are required')
    const options = input.options.map((item) => typeof item === 'string' ? item.trim() : '')
    if (options.some((item) => !item) || new Set(options).size !== options.length) fail(400, 'Options must be non-empty and unique')
    const votingType = input.votingType ?? 'single'
    if (!['single', 'multiple', 'ranked'].includes(votingType)) fail(400, 'Voting type must be single, multiple, or ranked')
    const votingMode = input.votingMode ?? 'public'
    if (!['public', 'anonymous'].includes(votingMode)) fail(400, 'Voting mode must be public or anonymous')
    const resultVisibility = input.resultVisibility ?? 'live'
    if (!['live', 'afterVote', 'afterClose'].includes(resultVisibility)) fail(400, 'Invalid result visibility')
    const durationMinutes = input.durationMinutes ?? 30
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) fail(400, 'Duration must be between 1 and 10080 minutes')
    const chatEnabled = input.chatEnabled ?? false
    if (typeof chatEnabled !== 'boolean') fail(400, 'chatEnabled must be a boolean')

    const poll = {
      id: randomUUID(), question: input.question.trim(),
      options: options.map((label) => ({ id: randomUUID(), label })),
      status: 'draft', votingType, votingMode, durationMinutes, resultVisibility,
      chatEnabled, createdAt: now(), startedAt: null, endsAt: null,
      ballotCount: 0, ballots: new Map(), counts: new Map(options.map((_, index) => [index, 0])),
    }
    polls.set(poll.id, poll)
    return serialize(poll)
  }

  function listPolls() { return [...polls.values()].map(serialize) }

  function readPoll(pollId) { return serialize(getPoll(pollId)) }

  function updatePoll(pollId, input = {}) {
    const poll = getPoll(pollId)
    if (poll.status !== 'draft') fail(409, 'Only draft polls can be edited')
    if (typeof input.question !== 'string' || !input.question.trim()) fail(400, 'Question is required')
    if (!Array.isArray(input.options) || input.options.length < 2) fail(400, 'At least two options are required')
    const labels = input.options.map((item) => typeof item === 'string' ? item.trim() : '')
    if (labels.some((label) => !label) || new Set(labels).size !== labels.length) fail(400, 'Options must be non-empty and unique')
    const votingType = input.votingType ?? poll.votingType
    const votingMode = input.votingMode ?? poll.votingMode
    const resultVisibility = input.resultVisibility ?? poll.resultVisibility
    const durationMinutes = input.durationMinutes ?? poll.durationMinutes
    const chatEnabled = input.chatEnabled ?? poll.chatEnabled
    if (!['single', 'multiple', 'ranked'].includes(votingType)) fail(400, 'Voting type must be single, multiple, or ranked')
    if (!['public', 'anonymous'].includes(votingMode)) fail(400, 'Voting mode must be public or anonymous')
    if (!['live', 'afterVote', 'afterClose'].includes(resultVisibility)) fail(400, 'Invalid result visibility')
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) fail(400, 'Duration must be between 1 and 10080 minutes')
    if (typeof chatEnabled !== 'boolean') fail(400, 'chatEnabled must be a boolean')
    poll.question = input.question.trim()
    poll.options = labels.map((label, index) => ({ id: poll.options[index]?.id ?? randomUUID(), label }))
    poll.counts = new Map(labels.map((_, index) => [index, 0]))
    Object.assign(poll, { votingType, votingMode, resultVisibility, durationMinutes, chatEnabled })
    return serialize(poll)
  }

  function deletePoll(pollId) {
    const poll = getPoll(pollId)
    if (poll.status !== 'draft') fail(409, 'Only draft polls can be deleted')
    polls.delete(pollId)
    return { deleted: true, pollId }
  }

  function hasVoted(pollId, voterId) {
    const poll = getPoll(pollId)
    const identity = typeof voterId === 'string' ? voterId.trim() : ''
    return { pollId, hasVoted: Boolean(identity && poll.ballots.has(identity)) }
  }

  function startPoll(pollId) {
    const poll = getPoll(pollId)
    if (poll.status !== 'draft') fail(409, 'Only draft polls can be started')
    poll.status = 'active'
    poll.startedAt = now()
    poll.endsAt = poll.startedAt + poll.durationMinutes * 60_000
    return serialize(poll)
  }

  function closePoll(pollId) {
    const poll = getPoll(pollId)
    if (poll.status !== 'active') fail(409, 'Only active polls can be closed')
    poll.status = 'closed'
    return serialize(poll)
  }

  function reopenPoll(pollId) {
    const poll = getPoll(pollId)
    const status = effectiveStatus(poll)
    if (status !== 'closed' && status !== 'expired') fail(409, 'Only closed or expired polls can be reopened')
    poll.status = 'active'
    poll.startedAt = now()
    poll.endsAt = poll.startedAt + poll.durationMinutes * 60_000
    return serialize(poll)
  }

  function submitVote(pollId, voterId, input = {}) {
    if (!voterId || !voterId.trim()) fail(401, 'Development voter identity is required')
    const identity = voterId.trim()
    const poll = getPoll(pollId)
    if (effectiveStatus(poll) !== 'active') fail(409, 'Poll is not accepting votes')
    if (poll.votingType === 'ranked') {
      const ranking = input.rankedOptionIds
      const error = validateRanking(ranking, poll.options.map((option) => option.id))
      if (error) fail(400, error)
      if (poll.ballots.has(identity)) fail(409, 'You have already voted in this poll. You cannot vote again.')
      poll.ballots.set(identity, { rankedOptionIds: [...ranking], submittedAt: now() })
      poll.ballotCount += 1
      return { accepted: true, ballotCount: poll.ballotCount }
    }
    const indexes = poll.votingType === 'single'
      ? (typeof input.optionId === 'string' ? [poll.options.findIndex((option) => option.id === input.optionId)] : [])
      : (Array.isArray(input.optionIds) ? input.optionIds.map((id) => poll.options.findIndex((option) => option.id === id)) : [])
    if (poll.votingType === 'single' && indexes.length !== 1) fail(400, 'Provide one optionId')
    if (poll.votingType === 'multiple' && indexes.length === 0) fail(400, 'Provide at least one optionId in optionIds')
    if (indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length) fail(400, 'Options must exist and may not be repeated')

    // This critical section is synchronous in one Node process, so a concurrent duplicate
    // cannot pass both the existence check and insertion. It is not a distributed lock.
    if (poll.ballots.has(identity)) fail(409, 'You have already voted in this poll. You cannot vote again.')
    poll.ballots.set(identity, { optionIndexes: indexes, submittedAt: now() })
    poll.ballotCount += 1
    for (const index of indexes) poll.counts.set(index, poll.counts.get(index) + 1)
    return { accepted: true, ballotCount: poll.ballotCount }
  }

  function getResults(pollId, voterId) {
    const poll = getPoll(pollId)
    const status = effectiveStatus(poll)
    const identity = typeof voterId === 'string' ? voterId.trim() : ''
    const hasVoted = Boolean(identity && poll.ballots.has(identity))
    const allowed = poll.resultVisibility === 'live'
      || (poll.resultVisibility === 'afterVote' && hasVoted)
      || (poll.resultVisibility === 'afterClose' && ['closed', 'expired'].includes(status))
    if (!allowed) fail(403, 'Results are not visible to this caller yet')
    if (poll.votingType === 'ranked') {
      const tally = calculateIrvResults(poll.options, [...poll.ballots.values()])
      return { pollId: poll.id, ...tally }
    }
    return {
      pollId: poll.id, ballotCount: poll.ballotCount,
      options: poll.options.map((option, index) => {
        const count = poll.counts.get(index)
        return { ...option, count, percentage: poll.ballotCount ? count / poll.ballotCount * 100 : 0 }
      }),
    }
  }

  function exportSnapshot() {
    const exportedPolls = [...polls.values()].map((poll) => {
      const options = poll.options.map((option) => ({ id: option.id, label: option.label }))
      const ballots = [...poll.ballots.entries()].map(([voterId, ballot]) => ({
        voterId,
        voteData: poll.votingType === 'ranked'
          ? { rankedOptionIds: [...ballot.rankedOptionIds] }
          : { optionIds: ballot.optionIndexes.map((index) => poll.options[index]?.id) },
        submittedAt: ballot.submittedAt,
      }))
      const optionCounts = poll.votingType === 'ranked' ? null : options.map((option, index) => ({ optionId: option.id, count: poll.counts.get(index) ?? 0 }))
      const rankedResults = poll.votingType === 'ranked' ? calculateIrvResults(options, ballots.map((ballot) => ballot.voteData)) : null
      return {
        id: poll.id, question: poll.question, options, status: effectiveStatus(poll), votingType: poll.votingType,
        votingMode: poll.votingMode, durationMinutes: poll.durationMinutes, resultVisibility: poll.resultVisibility,
        chatEnabled: poll.chatEnabled, createdAt: poll.createdAt, startedAt: poll.startedAt, endsAt: poll.endsAt,
        ballotCount: poll.ballotCount, optionCounts, rankedResults, ballots,
      }
    })
    return { schemaVersion: 1, exportedAt: now(), pollCount: exportedPolls.length,
      ballotCount: exportedPolls.reduce((total, poll) => total + poll.ballots.length, 0), polls: exportedPolls }
  }

  return { createPoll, listPolls, readPoll, updatePoll, deletePoll, hasVoted, startPoll, closePoll, reopenPoll, submitVote, getResults, exportSnapshot }
}
