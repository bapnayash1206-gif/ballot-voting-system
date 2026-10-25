import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { ApiError } from '../shared/http.js'
import { calculateIrvResults, validateRanking } from '../shared/irv.js'

const pollPk = (pollId) => `POLL#${pollId}`
const metaKey = (pollId) => ({ PK: pollPk(pollId), SK: 'META' })
const discoveryKey = (pollId) => ({ PK: pollPk(pollId), SK: 'DISCOVERY' })
const optionId = (option) => option.optionId || option.id
const labelsFrom = (labels) => labels.map((label) => ({ optionId: randomUUID(), label }))
const validLabels = (labels) => Array.isArray(labels) && labels.length >= 2
  && labels.every((label) => typeof label === 'string' && label.trim())
  && new Set(labels.map((label) => label.trim())).size === labels.length
const hashNumber = (value, modulo) => Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % modulo

function summarize(poll, shards) {
  const optionCounts = Object.fromEntries(poll.options.map((option) => [optionId(option), 0]))
  let ballotCount = 0
  for (const shard of shards) {
    if (!shard) continue
    ballotCount += shard.ballotCount || 0
    for (const option of poll.options) optionCounts[optionId(option)] += shard.optionCounts?.[optionId(option)] || 0
  }
  return {
    ballotCount,
    options: poll.options.map((option) => {
      const count = optionCounts[optionId(option)] || 0
      return { ...option, id: optionId(option), count, percentage: ballotCount ? count / ballotCount * 100 : 0 }
    }),
  }
}

function publicPoll(poll, summary) {
  const excluded = new Set(['PK', 'SK', 'GSI1PK', 'GSI1SK', 'ownerSub', 'tenantId'])
  const safePoll = Object.fromEntries(Object.entries(poll).filter(([key]) => !excluded.has(key)))
  const options = poll.options.map((option) => ({ ...option, id: optionId(option) }))
  return summary ? { ...safePoll, ...summary } : { ...safePoll, options }
}

export function createDynamoRepository({ client, commands, env = process.env, now = () => Date.now() }) {
  const { GetCommand, PutCommand, UpdateCommand, QueryCommand, TransactWriteCommand } = commands
  const tableName = env.TABLE_NAME
  const voteShardCount = Number(env.VOTE_SHARD_COUNT || 4)
  const resultShardCount = Number(env.RESULT_SHARD_COUNT || 4)
  const connectionShardCount = Number(env.CONNECTION_SHARD_COUNT || 4)
  const voterSecret = env.VOTER_KEY_SECRET
  if (!tableName) throw new Error('TABLE_NAME must be configured')

  const send = (Command, input) => client.send(new Command(input))
  const getRawPoll = async (pollId) => {
    const response = await send(GetCommand, { TableName: tableName, Key: metaKey(pollId), ConsistentRead: true })
    if (!response.Item) throw new ApiError(404, 'NOT_FOUND', 'Poll not found')
    return response.Item
  }
  const getSummary = async (poll) => {
    const shards = await Promise.all(Array.from({ length: poll.resultShardCount || resultShardCount }, (_, i) =>
      send(GetCommand, { TableName: tableName, Key: { PK: `POLL#${poll.id}#RESULTS#${i}`, SK: 'TOTALS' }, ConsistentRead: true })))
    return summarize(poll, shards.map((item) => item.Item))
  }
  const attachSummary = async (poll) => publicPoll(poll, await getSummary(poll))
  const requireOwner = (poll, ownerSub) => {
    if (poll.ownerSub !== ownerSub) throw new ApiError(404, 'NOT_FOUND', 'Poll not found')
  }
  const voterKey = (pollId, subject) => {
    if (!voterSecret || voterSecret.length < 32) throw new Error('VOTER_KEY_SECRET must contain at least 32 characters')
    return createHmac('sha256', voterSecret).update(`${pollId}:${subject}`).digest('hex')
  }
  const ballotKey = (poll, identityKey) => {
    const shard = hashNumber(identityKey, poll.voteShardCount || voteShardCount)
    return { PK: `POLL#${poll.id}#VOTES#${shard}`, SK: `VOTER#${identityKey}` }
  }
  const resultKey = (poll, identityKey) => {
    const shard = hashNumber(identityKey, poll.resultShardCount || resultShardCount)
    return { PK: `POLL#${poll.id}#RESULTS#${shard}`, SK: 'TOTALS' }
  }

  async function createPoll(input, ownerSub) {
    if (typeof input.question !== 'string' || !input.question.trim() || !validLabels(input.options)) {
      throw new ApiError(400, 'INVALID_POLL', 'Question and at least two unique options are required')
    }
    if (!['single', 'multiple', 'ranked'].includes(input.votingType || 'single')) throw new ApiError(422, 'UNSUPPORTED_VOTING_TYPE', 'Unsupported voting type')
    if (!['public', 'anonymous'].includes(input.votingMode || 'public')) throw new ApiError(400, 'INVALID_VOTING_MODE', 'Invalid voting mode')
    if (!['live', 'afterVote', 'afterClose'].includes(input.resultVisibility || 'live')) throw new ApiError(400, 'INVALID_VISIBILITY', 'Invalid result visibility')
    if (input.chatEnabled !== undefined && typeof input.chatEnabled !== 'boolean') throw new ApiError(400, 'INVALID_CHAT_SETTING', 'chatEnabled must be a boolean')
    const durationMinutes = input.durationMinutes ?? 30
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080) throw new ApiError(400, 'INVALID_DURATION', 'Duration must be between 1 and 10080 minutes')
    const pollId = randomUUID()
    const options = labelsFrom(input.options.map((label) => label.trim()))
    const createdAt = now()
    const poll = {
      ...metaKey(pollId), id: pollId, ownerSub, GSI1PK: `OWNER#${ownerSub}`,
      GSI1SK: `POLL#${String(createdAt).padStart(13, '0')}#${pollId}`,
      question: input.question.trim(), options, status: 'draft',
      votingType: input.votingType || 'single', votingMode: input.votingMode || 'public',
      durationMinutes, resultVisibility: input.resultVisibility || 'live', chatEnabled: Boolean(input.chatEnabled),
      createdAt, updatedAt: createdAt, startedAt: null, endsAt: null,
      voteShardCount, resultShardCount, connectionShardCount, schemaVersion: 1,
    }
    await send(TransactWriteCommand, { ClientRequestToken: randomUUID(), TransactItems: [
      { Put: { TableName: tableName, Item: poll, ConditionExpression: 'attribute_not_exists(PK)' } },
      ...Array.from({ length: resultShardCount }, (_, shard) => ({ Put: {
        TableName: tableName,
        Item: { PK: `POLL#${pollId}#RESULTS#${shard}`, SK: 'TOTALS', pollId, ballotCount: 0, optionCounts: Object.fromEntries(options.map((option) => [option.optionId, 0])) },
        ConditionExpression: 'attribute_not_exists(PK)',
      } })),
    ] })
    return { ...poll, ballotCount: 0, options: options.map((option) => ({ ...option, id: option.optionId, count: 0, percentage: 0 })) }
  }

  async function listPolls(ownerSub, cursor) {
    let ExclusiveStartKey
    if (cursor) {
      try { ExclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) }
      catch { throw new ApiError(400, 'INVALID_CURSOR', 'Poll-list cursor is invalid') }
    }
    const page = await send(QueryCommand, {
      TableName: tableName, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :owner',
      ExpressionAttributeValues: { ':owner': `OWNER#${ownerSub}` }, ScanIndexForward: false,
      ExclusiveStartKey, Limit: 50,
    })
    const polls = await Promise.all((page.Items || []).map(async (item) => {
      const poll = await attachSummary(item)
      return { ...poll, status: poll.status === 'active' && poll.endsAt <= now() ? 'expired' : poll.status }
    }))
    let dashboard
    if (!cursor) {
      // Dashboard totals span every owner poll but are computed only on the first list request.
      const allPolls = [...(page.Items || [])]
      let statsCursor = page.LastEvaluatedKey
      const seenStatsCursors = new Set()
      let statsPageCount = 1
      while (statsCursor) {
        const marker = Buffer.from(JSON.stringify(statsCursor)).toString('base64url')
        if (seenStatsCursors.has(marker)) throw new Error('DynamoDB owner poll pagination repeated a cursor')
        if (statsPageCount >= 1000) throw new Error('DynamoDB owner poll pagination exceeded the safety limit')
        seenStatsCursors.add(marker)
        const next = await send(QueryCommand, { TableName: tableName, IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :owner', ExpressionAttributeValues: { ':owner': `OWNER#${ownerSub}` },
          ScanIndexForward: false, ExclusiveStartKey: statsCursor, Limit: 50 })
        allPolls.push(...(next.Items || []))
        statsCursor = next.LastEvaluatedKey
        statsPageCount += 1
      }
      const summaries = await Promise.all(allPolls.map(async (poll) => ({ poll, summary: await getSummary(poll) })))
      dashboard = { pollCount: allPolls.length,
        activePollCount: allPolls.filter((poll) => poll.status === 'active' && poll.endsAt > now()).length,
        totalVotes: summaries.reduce((total, item) => total + item.summary.ballotCount, 0) }
    }
    return { polls,
      nextCursor: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url') : null,
      ...(dashboard ? { dashboard } : {}) }
  }
  async function listVoterPolls(cursor) {
    let ExclusiveStartKey
    if (cursor) {
      try { ExclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) }
      catch { throw new ApiError(400, 'INVALID_CURSOR', 'Poll-list cursor is invalid') }
    }
    const page = await send(QueryCommand, {
      TableName: tableName, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :published',
      ExpressionAttributeValues: { ':published': 'VOTER#AVAILABLE' }, ScanIndexForward: false,
      ExclusiveStartKey, Limit: 50,
    })
    const directoryItems = page.Items || []
    const polls = (await Promise.all(directoryItems.map(async (item) => {
      try {
        const poll = await getRawPoll(item.pollId)
        const status = poll.status === 'active' && poll.endsAt <= now() ? 'expired' : poll.status
        if (status === 'draft') return null
        return publicPoll({ ...poll, status })
      } catch (error) {
        // Ignore stale discovery records; the directory is an index, not the source of truth.
        if (error instanceof ApiError && error.statusCode === 404) return null
        throw error
      }
    }))).filter(Boolean)
    return {
      polls,
      nextCursor: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url') : null,
    }
  }

  async function readPoll(pollId) {
    const poll = await getRawPoll(pollId)
    return publicPoll({ ...poll, status: poll.status === 'active' && poll.endsAt <= now() ? 'expired' : poll.status })
  }

  async function readPollForViewer(pollId, subject, isAdmin) {
    const poll = await getRawPoll(pollId)
    if (poll.status === 'draft' && !(isAdmin && poll.ownerSub === subject)) {
      throw new ApiError(404, 'NOT_FOUND', 'Poll not found')
    }
    const status = poll.status === 'active' && poll.endsAt <= now() ? 'expired' : poll.status
    return publicPoll({ ...poll, status })
  }

  async function updatePoll(pollId, input, ownerSub) {
    const poll = await getRawPoll(pollId); requireOwner(poll, ownerSub)
    if (poll.status !== 'draft') throw new ApiError(409, 'INVALID_STATE', 'Only draft polls can be edited')
    if (typeof input.question !== 'string' || !input.question.trim() || !validLabels(input.options)) throw new ApiError(400, 'INVALID_POLL', 'Question and at least two unique options are required')
    if (input.votingType && !['single', 'multiple', 'ranked'].includes(input.votingType)) throw new ApiError(422, 'UNSUPPORTED_VOTING_TYPE', 'Unsupported voting type')
    if (input.votingMode && !['public', 'anonymous'].includes(input.votingMode)) throw new ApiError(400, 'INVALID_VOTING_MODE', 'Invalid voting mode')
    if (input.resultVisibility && !['live', 'afterVote', 'afterClose'].includes(input.resultVisibility)) throw new ApiError(400, 'INVALID_VISIBILITY', 'Invalid result visibility')
    if (input.durationMinutes !== undefined && (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 10080)) throw new ApiError(400, 'INVALID_DURATION', 'Duration must be between 1 and 10080 minutes')
    if (input.chatEnabled !== undefined && typeof input.chatEnabled !== 'boolean') throw new ApiError(400, 'INVALID_CHAT_SETTING', 'chatEnabled must be a boolean')
    const options = labelsFrom(input.options.map((label) => label.trim())).map((option, index) => ({ ...option, optionId: poll.options[index]?.optionId || option.optionId }))
    const updated = { ...poll, question: input.question.trim(), options, votingType: input.votingType || poll.votingType,
      votingMode: input.votingMode || poll.votingMode, durationMinutes: input.durationMinutes ?? poll.durationMinutes,
      resultVisibility: input.resultVisibility || poll.resultVisibility, chatEnabled: input.chatEnabled ?? poll.chatEnabled, updatedAt: now() }
    await send(TransactWriteCommand, { ClientRequestToken: randomUUID(), TransactItems: [
      { Put: { TableName: tableName, Item: updated, ConditionExpression: '#status = :draft AND ownerSub = :owner',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':draft': 'draft', ':owner': ownerSub } } },
      ...Array.from({ length: poll.resultShardCount }, (_, shard) => ({ Put: {
        TableName: tableName, Item: { PK: `POLL#${pollId}#RESULTS#${shard}`, SK: 'TOTALS', pollId,
          ballotCount: 0, optionCounts: Object.fromEntries(options.map((option) => [option.optionId, 0])) },
      } })),
    ] })
    return attachSummary(updated)
  }

  async function lifecycle(pollId, ownerSub, action) {
    const poll = await getRawPoll(pollId); requireOwner(poll, ownerSub)
    const timestamp = now()
    let update
    if (action === 'start') update = {
      UpdateExpression: 'SET #status = :active, startedAt = :now, endsAt = :ends, updatedAt = :now',
      ConditionExpression: '#status = :draft', values: { ':draft': 'draft', ':active': 'active' },
    }
    else if (action === 'close') update = {
      UpdateExpression: 'SET #status = :closed, updatedAt = :now',
      ConditionExpression: '#status = :active AND endsAt > :now', values: { ':active': 'active', ':closed': 'closed' },
    }
    else update = {
      UpdateExpression: 'SET #status = :active, startedAt = :now, endsAt = :ends, updatedAt = :now',
      ConditionExpression: '#status = :closed OR (#status = :active AND endsAt <= :now)', values: { ':closed': 'closed', ':active': 'active' },
    }
    const { values, ...expressions } = update
    const ExpressionAttributeValues = { ...values, ':now': timestamp, ':ends': timestamp + poll.durationMinutes * 60_000 }
    if (action === 'close') delete ExpressionAttributeValues[':ends']
    const discovery = { ...discoveryKey(pollId), GSI1PK: 'VOTER#AVAILABLE',
      GSI1SK: `POLL#${String(poll.createdAt).padStart(13, '0')}#${pollId}`,
      pollId, createdAt: poll.createdAt, status: action === 'close' ? 'closed' : 'active',
      endsAt: action === 'close' ? timestamp : timestamp + poll.durationMinutes * 60_000 }
    await send(TransactWriteCommand, { ClientRequestToken: randomUUID(), TransactItems: [
      { Update: { TableName: tableName, Key: metaKey(pollId), ...expressions,
        ExpressionAttributeNames: { '#status': 'status' },
        ConditionExpression: `(${expressions.ConditionExpression}) AND ownerSub = :owner`,
        ExpressionAttributeValues: { ...ExpressionAttributeValues, ':owner': ownerSub },
      } },
      { Put: { TableName: tableName, Item: discovery } },
    ] })
    return readPoll(pollId)
  }

  async function deletePoll(pollId, ownerSub) {
    const poll = await getRawPoll(pollId)
    requireOwner(poll, ownerSub)
    if (poll.status !== 'draft') throw new ApiError(409, 'INVALID_STATE', 'Only draft polls can be deleted')
    await send(TransactWriteCommand, { ClientRequestToken: randomUUID(), TransactItems: [
      { Delete: { TableName: tableName, Key: metaKey(pollId),
        ConditionExpression: '#status = :draft AND ownerSub = :owner',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':draft': 'draft', ':owner': ownerSub } } },
      ...Array.from({ length: poll.resultShardCount }, (_, shard) => ({ Delete: {
        TableName: tableName, Key: { PK: `POLL#${pollId}#RESULTS#${shard}`, SK: 'TOTALS' },
      } })),
    ] })
    return { deleted: true, pollId }
  }

  async function hasVoted(pollId, subject) {
    const poll = await getRawPoll(pollId)
    const identity = voterKey(pollId, subject)
    const { Item } = await send(GetCommand, { TableName: tableName, Key: ballotKey(poll, identity), ConsistentRead: true })
    return { pollId, hasVoted: Boolean(Item) }
  }

  function parseVote(poll, input) {
    if (poll.votingType === 'ranked') {
      const ranking = input.rankedOptionIds
      const error = validateRanking(ranking, poll.options.map(optionId))
      if (error) throw new ApiError(400, 'INVALID_VOTE', error)
      return { rankedOptionIds: [...ranking] }
    }
    const selected = poll.votingType === 'single' ? [input.optionId] : input.optionIds
    if (poll.votingType === 'single' && typeof input.optionId !== 'string') throw new ApiError(400, 'INVALID_VOTE', 'Provide one optionId')
    if (poll.votingType === 'multiple' && (!Array.isArray(input.optionIds) || !input.optionIds.length)) throw new ApiError(400, 'INVALID_VOTE', 'Provide at least one optionId in optionIds')
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string' || !poll.options.some((option) => optionId(option) === id))
      || new Set(selected).size !== selected.length) throw new ApiError(400, 'INVALID_VOTE', 'Options must exist and may not be repeated')
    return poll.votingType === 'single' ? { selectionId: selected[0] } : { selectionIds: selected }
  }

  async function submitVote(pollId, subject, input, clientRequestToken) {
    const poll = await getRawPoll(pollId)
    const timestamp = now()
    if (poll.status !== 'active' || poll.endsAt <= timestamp) throw new ApiError(409, 'POLL_CLOSED', 'Poll is not accepting votes')
    const voteData = parseVote(poll, input)
    const identity = voterKey(pollId, subject)
    const ballot = ballotKey(poll, identity)
    const result = resultKey(poll, identity)
    const selectedIds = voteData.selectionId ? [voteData.selectionId] : voteData.selectionIds || []
    const names = { '#ballotCount': 'ballotCount' }
    const values = { ':one': 1, ':now': timestamp }
    const increments = selectedIds.map((id, index) => {
      names['#optionCounts'] = 'optionCounts'
      names[`#o${index}`] = id
      values[`:old${index}`] = 0
      return `#optionCounts.#o${index} = if_not_exists(#optionCounts.#o${index}, :old${index}) + :one`
    })
    const aggregateUpdate = selectedIds.length
      ? `SET #ballotCount = #ballotCount + :one, updatedAt = :now, ${increments.join(', ')}`
      : 'SET #ballotCount = #ballotCount + :one, updatedAt = :now'
    const actions = [
      { ConditionCheck: { TableName: tableName, Key: metaKey(pollId),
        ConditionExpression: '#status = :active AND endsAt > :now',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':active': 'active', ':now': timestamp } } },
      { Put: { TableName: tableName, Item: { ...ballot, pollId, voterKey: identity, voteData, submittedAt: timestamp, schemaVersion: 1 },
        ConditionExpression: 'attribute_not_exists(PK)' } },
      { Update: { TableName: tableName, Key: result,
        UpdateExpression: aggregateUpdate,
        ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
    ]
    try {
      const requestToken = clientRequestToken
        ? createHash('sha256').update(`${pollId}:${identity}:${clientRequestToken}`).digest('hex').slice(0, 36)
        : randomUUID()
      await send(TransactWriteCommand, { ClientRequestToken: requestToken, TransactItems: actions })
      return { accepted: true, ballotCount: (await getSummary(poll)).ballotCount + 0 }
    } catch (error) {
      if (error?.name !== 'TransactionCanceledException' && error?.name !== 'ConditionalCheckFailedException') throw error
      const existing = await send(GetCommand, { TableName: tableName, Key: ballot, ConsistentRead: true })
      if (existing.Item) throw new ApiError(409, 'DUPLICATE_VOTE', 'You have already voted in this poll. You cannot vote again.')
      const latest = await getRawPoll(pollId)
      if (latest.status !== 'active' || latest.endsAt <= now()) throw new ApiError(409, 'POLL_CLOSED', 'Poll is not accepting votes')
      throw new ApiError(409, 'VOTE_CONFLICT', 'Vote conflicted with another update. Please retry once.')
    }
  }

  async function getResults(pollId, subject) {
    const poll = await getRawPoll(pollId)
    const status = poll.status === 'active' && poll.endsAt <= now() ? 'expired' : poll.status
    const identity = voterKey(pollId, subject)
    const ballot = await send(GetCommand, { TableName: tableName, Key: ballotKey(poll, identity), ConsistentRead: true })
    const allowed = poll.resultVisibility === 'live'
      || (poll.resultVisibility === 'afterVote' && Boolean(ballot.Item))
      || (poll.resultVisibility === 'afterClose' && ['closed', 'expired'].includes(status))
    if (!allowed) throw new ApiError(403, 'RESULTS_HIDDEN', 'Results are not visible to this caller yet')
    if (poll.votingType === 'ranked') {
      const ballots = []
      for (let shard = 0; shard < (poll.voteShardCount || voteShardCount); shard += 1) {
        let ExclusiveStartKey
        do {
          const page = await send(QueryCommand, {
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':pk': `POLL#${poll.id}#VOTES#${shard}`, ':prefix': 'VOTER#' },
            ConsistentRead: true,
            ExclusiveStartKey,
          })
          ballots.push(...(page.Items || []))
          ExclusiveStartKey = page.LastEvaluatedKey
        } while (ExclusiveStartKey)
      }
      return { pollId, ...calculateIrvResults(poll.options, ballots) }
    }
    return { pollId, ...await getSummary(poll) }
  }

  async function createWsTicket(pollId, subject, purpose) {
    const poll = await getRawPoll(pollId)
    if (!['results', 'chat'].includes(purpose)) throw new ApiError(400, 'INVALID_PURPOSE', 'WebSocket purpose must be results or chat')
    if (purpose === 'chat' && !poll.chatEnabled) throw new ApiError(403, 'CHAT_DISABLED', 'Chat is disabled for this poll')
    if (purpose === 'results') {
      const visible = poll.resultVisibility === 'live'
        || (poll.resultVisibility === 'afterVote' && (await hasVoted(pollId, subject)).hasVoted)
      || (poll.resultVisibility === 'afterClose' && ['closed', 'expired'].includes(poll.status === 'active' && poll.endsAt <= now() ? 'expired' : poll.status))
      if (!visible) throw new ApiError(403, 'RESULTS_HIDDEN', 'Results are not visible to this caller yet')
    }
    const ticket = randomBytes(32).toString('base64url')
    const ticketHash = createHash('sha256').update(ticket).digest('hex')
    const expiresAt = Math.floor(now() / 1000) + Number(env.CONNECTION_TICKET_TTL_SECONDS || 90)
    await send(PutCommand, { TableName: tableName, Item: {
      PK: `CONNECTION_TICKET#${ticketHash}`, SK: 'STATE', subject, pollId, purpose, expiresAt,
    }, ConditionExpression: 'attribute_not_exists(PK)' })
    return { ticket, expiresAt }
  }

  async function consumeWsTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length < 32) throw new ApiError(401, 'INVALID_TICKET', 'WebSocket ticket is missing or invalid')
    const ticketHash = createHash('sha256').update(ticket).digest('hex')
    try {
      const result = await send(UpdateCommand, { TableName: tableName,
        Key: { PK: `CONNECTION_TICKET#${ticketHash}`, SK: 'STATE' },
        UpdateExpression: 'SET consumedAt = :now',
        ConditionExpression: 'expiresAt > :now AND attribute_not_exists(consumedAt)',
        ExpressionAttributeValues: { ':now': Math.floor(now() / 1000) }, ReturnValues: 'ALL_NEW' })
      if (!result.Attributes) throw new ApiError(401, 'INVALID_TICKET', 'WebSocket ticket is missing or expired')
      return result.Attributes
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (error?.name === 'ConditionalCheckFailedException') throw new ApiError(401, 'INVALID_TICKET', 'WebSocket ticket is missing, expired, or already used')
      throw error
    }
  }

  async function openConnection(connectionId, context) {
    const poll = await getRawPoll(context.pollId)
    const shard = hashNumber(connectionId, poll.connectionShardCount || connectionShardCount)
    const expiresAt = Math.floor(now() / 1000) + 86_400
    await send(TransactWriteCommand, { ClientRequestToken: randomUUID(), TransactItems: [
      { Put: { TableName: tableName, Item: { PK: `CONNECTION#${connectionId}`, SK: 'STATE', connectionId,
        pollId: poll.id, subject: context.subject, purpose: context.purpose, shard, expiresAt }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: tableName, Item: { PK: `POLL#${poll.id}#CONNECTIONS#${shard}`, SK: `CONNECTION#${connectionId}`,
        pollId: poll.id, connectionId, expiresAt }, ConditionExpression: 'attribute_not_exists(PK)' } },
    ] })
  }

  async function closeConnection(connectionId) {
    const response = await send(GetCommand, { TableName: tableName, Key: { PK: `CONNECTION#${connectionId}`, SK: 'STATE' }, ConsistentRead: true })
    const connection = response.Item
    if (!connection) return
    await send(TransactWriteCommand, { ClientRequestToken: randomUUID(), TransactItems: [
      { Delete: { TableName: tableName, Key: { PK: `CONNECTION#${connectionId}`, SK: 'STATE' } } },
      { Delete: { TableName: tableName, Key: { PK: `POLL#${connection.pollId}#CONNECTIONS#${connection.shard}`, SK: `CONNECTION#${connectionId}` } } },
    ] })
  }

  async function listConnections(poll) {
    const perShard = await Promise.all(Array.from({ length: poll.connectionShardCount || connectionShardCount }, async (_, shard) => {
      const items = []
      let ExclusiveStartKey
      do {
        const page = await send(QueryCommand, { TableName: tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': `POLL#${poll.id}#CONNECTIONS#${shard}`, ':prefix': 'CONNECTION#' }, ExclusiveStartKey })
        items.push(...(page.Items || []))
        ExclusiveStartKey = page.LastEvaluatedKey
      } while (ExclusiveStartKey)
      return items
    }))
    return perShard.flat().filter((item) => item.expiresAt > Math.floor(now() / 1000))
  }

  async function persistChat(pollId, subject, message) {
    const poll = await getRawPoll(pollId)
    if (!poll.chatEnabled) throw new ApiError(403, 'CHAT_DISABLED', 'Chat is disabled for this poll')
    if (typeof message !== 'string' || !message.trim() || message.trim().length > Number(env.CHAT_MAX_LENGTH || 500)) {
      throw new ApiError(400, 'INVALID_MESSAGE', 'Chat message must contain 1 to 500 characters')
    }
    const createdAt = now()
    const messageId = randomUUID()
    const month = new Date(createdAt).toISOString().slice(0, 7).replace('-', '')
    const item = { PK: `POLL#${pollId}#CHAT#${month}`, SK: `MSG#${new Date(createdAt).toISOString()}#${messageId}`,
      pollId, messageId, senderDisplay: 'Participant', text: message.trim(), createdAt }
    await send(PutCommand, { TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })
    return { ...item, PK: undefined, SK: undefined }
  }

  async function listChat(pollId, limit = 50) {
    const maxItems = Math.min(Math.max(1, limit), 100)
    const months = Array.from({ length: 3 }, (_, offset) => {
      const date = new Date(now())
      date.setUTCDate(1)
      date.setUTCMonth(date.getUTCMonth() - offset)
      return date.toISOString().slice(0, 7).replace('-', '')
    })
    const pages = await Promise.all(months.map((month) => send(QueryCommand, {
      TableName: tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `POLL#${pollId}#CHAT#${month}`, ':prefix': 'MSG#' },
      ScanIndexForward: false, Limit: maxItems,
    })))
    return pages.flatMap((response) => response.Items || [])
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, maxItems)
      .map((item) => {
        const message = { ...item }
        delete message.PK
        delete message.SK
        return message
      })
  }

  return { createPoll, listPolls, listVoterPolls, readPoll, readPollForViewer, updatePoll, lifecycle, deletePoll, hasVoted, submitVote, getResults,
    createWsTicket, consumeWsTicket, openConnection, closeConnection, listConnections, persistChat, listChat }
}
