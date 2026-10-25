import test from 'node:test'
import assert from 'node:assert/strict'
import { createDynamoRepository } from '../src/repository/dynamoRepository.js'

function commands() {
  const command = (name) => class { constructor(input) { this.name = name; this.input = input } }
  return Object.fromEntries(['GetCommand', 'PutCommand', 'UpdateCommand', 'DeleteCommand', 'QueryCommand', 'TransactWriteCommand'].map((name) => [name, command(name)]))
}

function setup({ resultVisibility = 'live' } = {}) {
  const classes = commands()
  const records = new Map()
  const queryInputs = []
  const transactionInputs = []
  const key = (value) => `${value.PK}|${value.SK}`
  const now = 1_700_000_000_000
  const env = { TABLE_NAME: 'BallotData', VOTER_KEY_SECRET: 'a'.repeat(48), VOTE_SHARD_COUNT: '2', RESULT_SHARD_COUNT: '2', CONNECTION_SHARD_COUNT: '2' }
  const createPoll = (id) => {
    const poll = { PK: `POLL#${id}`, SK: 'META', id, ownerSub: 'admin', GSI1PK: 'OWNER#admin', GSI1SK: `POLL#${id}`, status: 'active', endsAt: now + 60_000,
      durationMinutes: 1, votingType: 'single', votingMode: 'public', resultVisibility, chatEnabled: false,
      options: [{ optionId: `a-${id}`, label: 'A' }, { optionId: `b-${id}`, label: 'B' }], resultShardCount: 2,
      voteShardCount: 2, connectionShardCount: 2 }
    records.set(key(poll), poll)
    for (let shard = 0; shard < 2; shard += 1) {
      const item = { PK: `POLL#${id}#RESULTS#${shard}`, SK: 'TOTALS', ballotCount: 0,
        optionCounts: { [`a-${id}`]: 0, [`b-${id}`]: 0 } }
      records.set(key(item), item)
    }
    return poll
  }
  const client = { async send(cmd) {
    const input = cmd.input
    if (cmd.name === 'GetCommand') return { Item: records.get(key(input.Key)) }
    if (cmd.name === 'QueryCommand') {
      queryInputs.push(input)
      if (input.ExpressionAttributeValues[':pk']) {
        const partition = input.ExpressionAttributeValues[':pk']
        const items = [...records.values()].filter((item) => item.PK === partition && item.SK.startsWith(input.ExpressionAttributeValues[':prefix']))
        return { Items: items }
      }
      const indexPartition = input.ExpressionAttributeValues[':owner'] ?? input.ExpressionAttributeValues[':published']
      const indexedItems = [...records.values()]
        .filter((item) => item.GSI1PK === indexPartition)
        .sort((left, right) => (left.GSI1SK || '').localeCompare(right.GSI1SK || ''))
      const startIndex = input.ExclusiveStartKey
        ? indexedItems.findIndex((item) => item.PK === input.ExclusiveStartKey.PK && item.SK === input.ExclusiveStartKey.SK) + 1
        : 0
      const pageItems = indexedItems.slice(startIndex, startIndex + (input.Limit || indexedItems.length))
      const hasMore = startIndex + pageItems.length < indexedItems.length
      const last = hasMore ? pageItems.at(-1) : null
      return { Items: pageItems, ...(last ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK, GSI1PK: last.GSI1PK, GSI1SK: last.GSI1SK } } : {}) }
    }
    if (cmd.name === 'TransactWriteCommand') {
      transactionInputs.push(input)
      const ballotPut = input.TransactItems.find((action) => action.Put?.Item?.voterKey)
      if (!ballotPut) {
        const update = input.TransactItems.find((action) => action.Update)?.Update
        const poll = records.get(key(update.Key))
        const values = update.ExpressionAttributeValues
        poll.status = update.UpdateExpression.includes('#status = :closed') && values[':closed']
          ? values[':closed'] : values[':active'] || poll.status
        if (values[':now']) poll.startedAt = values[':now']
        if (values[':ends']) poll.endsAt = values[':ends']
        const discovery = input.TransactItems.find((action) => action.Put?.Item?.SK === 'DISCOVERY')?.Put?.Item
        if (discovery) records.set(key(discovery), discovery)
        return {}
      }
      const update = input.TransactItems.find((action) => action.Update?.Key?.SK === 'TOTALS')?.Update
      if (records.has(key(ballotPut.Put.Item))) throw Object.assign(new Error('transaction canceled'), { name: 'TransactionCanceledException' })
      records.set(key(ballotPut.Put.Item), ballotPut.Put.Item)
      const aggregate = records.get(key(update.Key))
      aggregate.ballotCount += 1
      const voteData = ballotPut.Put.Item.voteData
      if (voteData.selectionId) aggregate.optionCounts[voteData.selectionId] += 1
      else if (voteData.selectionIds) for (const id of voteData.selectionIds) aggregate.optionCounts[id] += 1
      return {}
    }
    throw new Error(`Unexpected command ${cmd.name}`)
  } }
  const store = createDynamoRepository({ client, commands: classes, env, now: () => now })
  return { store, createPoll, records, key, now, env, queryInputs, transactionInputs }
}

test('ranked vote stores the complete preference order and tallies each IRV round from ballots', async () => {
  const { store, createPoll, records, queryInputs } = setup()
  const poll = createPoll('ranked-poll')
  poll.votingType = 'ranked'
  poll.options.push({ optionId: `c-${poll.id}`, label: 'C' })
  for (const shard of [0, 1]) {
    const aggregate = records.get(`POLL#${poll.id}#RESULTS#${shard}|TOTALS`)
    aggregate.optionCounts[`c-${poll.id}`] = 0
  }
  await store.submitVote(poll.id, 'voter-a', { rankedOptionIds: [`a-${poll.id}`, `b-${poll.id}`, `c-${poll.id}`], ballotCount: 999, winnerOptionId: 'client-claim' })
  await store.submitVote(poll.id, 'voter-b1', { rankedOptionIds: [`b-${poll.id}`, `c-${poll.id}`] })
  await store.submitVote(poll.id, 'voter-b2', { rankedOptionIds: [`b-${poll.id}`] })
  await store.submitVote(poll.id, 'voter-c1', { rankedOptionIds: [`c-${poll.id}`, `b-${poll.id}`] })
  await store.submitVote(poll.id, 'voter-c2', { rankedOptionIds: [`c-${poll.id}`] })
  const stored = [...records.values()].find((item) => item.pollId === poll.id && item.voterKey)
  assert.deepEqual(stored.voteData, { rankedOptionIds: [`a-${poll.id}`, `b-${poll.id}`, `c-${poll.id}`] })

  const result = await store.getResults(poll.id, 'admin')
  assert.equal(result.method, 'instant_runoff')
  assert.equal(result.outcome, 'winner')
  assert.equal(result.winnerOptionId, `b-${poll.id}`)
  assert.equal(result.rounds.length, 2)
  assert.deepEqual(result.rounds[0].tallies.map((candidate) => candidate.votes), [1, 2, 2])
  assert.equal(result.rounds[0].eliminatedOptionId, `a-${poll.id}`)
  assert.equal(result.rounds[1].continuingBallots, 5)
  const voteQueries = queryInputs.filter((input) => input.ExpressionAttributeValues[':pk']?.includes('#VOTES#'))
  assert.equal(voteQueries.length, 2)
  assert.ok(voteQueries.every((input) => input.ConsistentRead === true))
})

test('ranked AWS vote validation rejects empty, unknown, and repeated candidates', async () => {
  const { store, createPoll } = setup()
  const poll = createPoll('ranked-validation')
  poll.votingType = 'ranked'
  await assert.rejects(store.submitVote(poll.id, 'voter', { rankedOptionIds: [] }), (error) => error.statusCode === 400)
  await assert.rejects(store.submitVote(poll.id, 'voter', { rankedOptionIds: ['unknown'] }), (error) => error.statusCode === 400)
  await assert.rejects(store.submitVote(poll.id, 'voter', { rankedOptionIds: [`a-${poll.id}`, `a-${poll.id}`] }), (error) => error.statusCode === 400)
})

test('DynamoDB vote transaction conditionally inserts one poll-scoped ballot and updates its result shard', async () => {
  const { store, createPoll, records } = setup()
  const poll = createPoll('poll-one')
  const response = await store.submitVote(poll.id, 'verified-subject', { optionId: `a-${poll.id}` }, 'request-token-000000000000000000000001')
  assert.equal(response.accepted, true)
  const ballot = [...records.values()].find((item) => item.pollId === poll.id && item.voterKey)
  assert.ok(ballot)
  assert.equal(ballot.voteData.selectionId, `a-${poll.id}`)
  const aggregate = [...records.values()].filter((item) => item.PK.startsWith(`POLL#${poll.id}#RESULTS#`)).reduce((sum, item) => sum + item.ballotCount, 0)
  assert.equal(aggregate, 1)
})

test('duplicate account vote rejects with clear conflict and leaves prior result unchanged', async () => {
  const { store, createPoll, records } = setup()
  const poll = createPoll('poll-one')
  await store.submitVote(poll.id, 'verified-subject', { optionId: `a-${poll.id}` })
  const before = [...records.values()].filter((item) => item.PK.startsWith(`POLL#${poll.id}#RESULTS#`)).map((item) => structuredClone(item))
  await assert.rejects(store.submitVote(poll.id, 'verified-subject', { optionId: `b-${poll.id}` }), (error) =>
    error.statusCode === 409 && error.code === 'DUPLICATE_VOTE' && error.message === 'You have already voted in this poll. You cannot vote again.')
  const after = [...records.values()].filter((item) => item.PK.startsWith(`POLL#${poll.id}#RESULTS#`))
  assert.deepEqual(after, before)
})

test('verified subject can vote in a different poll because voter keys are poll scoped', async () => {
  const { store, createPoll, records } = setup()
  const first = createPoll('poll-one')
  const second = createPoll('poll-two')
  await store.submitVote(first.id, 'verified-subject', { optionId: `a-${first.id}` })
  await store.submitVote(second.id, 'verified-subject', { optionId: `b-${second.id}` })
  const ballots = [...records.values()].filter((item) => item.voterKey)
  assert.equal(ballots.length, 2)
  assert.notEqual(ballots[0].voterKey, ballots[1].voterKey)
})

test('afterVote results require a verified subject ballot', async () => {
  const { store, createPoll } = setup({ resultVisibility: 'afterVote' })
  const poll = createPoll('poll-one')
  await assert.rejects(store.getResults(poll.id, 'other-subject'), (error) => error.statusCode === 403 && error.code === 'RESULTS_HIDDEN')
  await store.submitVote(poll.id, 'verified-subject', { optionId: `a-${poll.id}` })
  const results = await store.getResults(poll.id, 'verified-subject')
  assert.equal(results.ballotCount, 1)
  assert.equal(results.options[0].percentage, 100)
})

test('voter discovery returns published polls only and does not expose result counts', async () => {
  const { store, createPoll, records, key, queryInputs, now } = setup()
  const published = createPoll('poll-public')
  published.status = 'closed'
  const expired = createPoll('poll-expired')
  expired.endsAt = now - 1
  const draft = createPoll('poll-draft')
  draft.status = 'draft'
  for (const poll of [published, expired, draft]) {
    const discovery = { PK: `POLL#${poll.id}`, SK: 'DISCOVERY', GSI1PK: 'VOTER#AVAILABLE',
      GSI1SK: `POLL#${poll.id}`, pollId: poll.id }
    records.set(key(discovery), discovery)
  }
  const result = await store.listVoterPolls()
  assert.deepEqual(result.polls.map((poll) => poll.id).sort(), ['poll-expired', 'poll-public'])
  assert.equal(result.polls.some((poll) => Object.hasOwn(poll, 'ballotCount')), false)
  assert.equal(queryInputs[0].IndexName, 'GSI1')
  assert.equal(queryInputs[0].ExpressionAttributeValues[':published'], 'VOTER#AVAILABLE')
})

test('starting a poll transactionally publishes its voter-discovery record', async () => {
  const { store, createPoll, records, key, transactionInputs } = setup()
  const poll = createPoll('poll-to-publish')
  poll.status = 'draft'
  const started = await store.lifecycle(poll.id, 'admin', 'start')
  assert.equal(started.status, 'active')
  const transaction = transactionInputs.at(-1)
  assert.equal(transaction.TransactItems.length, 2)
  const update = transaction.TransactItems.find((action) => action.Update)?.Update
  assert.match(update.ConditionExpression, /\(.*\) AND ownerSub = :owner/)
  const directory = records.get(key({ PK: `POLL#${poll.id}`, SK: 'DISCOVERY' }))
  assert.equal(directory.GSI1PK, 'VOTER#AVAILABLE')
  assert.equal(directory.status, 'active')
})

test('closing and reopening keeps the published directory entry synchronized', async () => {
  const { store, createPoll, records, key } = setup()
  const poll = createPoll('poll-lifecycle')
  const closed = await store.lifecycle(poll.id, 'admin', 'close')
  assert.equal(closed.status, 'closed')
  assert.equal(records.get(key({ PK: `POLL#${poll.id}`, SK: 'DISCOVERY' })).status, 'closed')

  const reopened = await store.lifecycle(poll.id, 'admin', 'reopen')
  assert.equal(reopened.status, 'active')
  assert.equal(records.get(key({ PK: `POLL#${poll.id}`, SK: 'DISCOVERY' })).status, 'active')
})

test('direct poll reads hide drafts from voters and non-owning administrators', async () => {
  const { store, createPoll, records, key } = setup()
  const publicPoll = createPoll('poll-public')
  const found = await store.readPollForViewer(publicPoll.id, 'another-student', false)
  assert.equal(found.id, publicPoll.id)

  const draft = createPoll('poll-draft')
  draft.status = 'draft'
  records.set(key(draft), draft)
  await assert.rejects(store.readPollForViewer(draft.id, 'another-student', false), (error) => error.statusCode === 404)
  await assert.rejects(store.readPollForViewer(draft.id, 'different-admin', true), (error) => error.statusCode === 404)
  assert.equal((await store.readPollForViewer(draft.id, 'admin', true)).id, draft.id)
})

test('a different authorized admin cannot manage another poll owner’s poll', async () => {
  const { store, createPoll } = setup()
  const poll = createPoll('poll-owned')
  await assert.rejects(store.lifecycle(poll.id, 'different-admin', 'close'), (error) => error.statusCode === 404)
})

test('Admin poll listing paginates more than 50 owned polls and returns complete dashboard totals only once', async () => {
  const { store, createPoll, records, queryInputs } = setup()
  const expectedVotes = Array.from({ length: 55 }, (_, index) => index + 1).reduce((sum, value) => sum + value, 0)
  for (let index = 0; index < 55; index += 1) {
    const poll = createPoll(`many-${String(index).padStart(2, '0')}`)
    records.get(`POLL#${poll.id}#RESULTS#0|TOTALS`).ballotCount = index + 1
  }

  const firstPage = await store.listPolls('admin')
  assert.equal(firstPage.polls.length, 50)
  assert.ok(firstPage.nextCursor)
  assert.deepEqual(firstPage.dashboard, { pollCount: 55, activePollCount: 55, totalVotes: expectedVotes })
  const queriesAfterDashboard = queryInputs.length

  const secondPage = await store.listPolls('admin', firstPage.nextCursor)
  assert.equal(secondPage.polls.length, 5)
  assert.equal(secondPage.nextCursor, null)
  assert.equal(Object.hasOwn(secondPage, 'dashboard'), false)
  assert.equal(queryInputs.length, queriesAfterDashboard + 1)
  assert.ok(queryInputs.at(-1).ExclusiveStartKey)
})

test('voter discovery keeps an empty normalized page cursor so callers can continue', async () => {
  const { store, createPoll, records, key } = setup()
  for (let index = 0; index < 50; index += 1) {
    const missing = { PK: `POLL#stale-${index}`, SK: 'DISCOVERY', GSI1PK: 'VOTER#AVAILABLE',
      GSI1SK: `POLL#${String(index).padStart(3, '0')}`, pollId: `stale-${index}` }
    records.set(key(missing), missing)
  }
  const poll = createPoll('last-published')
  const discovery = { PK: `POLL#${poll.id}`, SK: 'DISCOVERY', GSI1PK: 'VOTER#AVAILABLE', GSI1SK: 'POLL#999', pollId: poll.id }
  records.set(key(discovery), discovery)

  const first = await store.listVoterPolls()
  assert.deepEqual(first.polls, [])
  assert.ok(first.nextCursor)
  const second = await store.listVoterPolls(first.nextCursor)
  assert.deepEqual(second.polls.map((item) => item.id), [poll.id])
  assert.equal(second.nextCursor, null)
})
