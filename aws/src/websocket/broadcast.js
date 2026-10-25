import { getCommands, getDocumentClient, getManagementClient } from '../shared/awsClients.js'
import { createDynamoRepository } from '../repository/dynamoRepository.js'

let cachedRepository
async function repository() {
  if (!cachedRepository) cachedRepository = createDynamoRepository({
    client: await getDocumentClient(), commands: await getCommands(), env: process.env,
  })
  return cachedRepository
}

export async function sendConnection(store, connectionId, payload) {
  const client = await getManagementClient(process.env.WEBSOCKET_MANAGEMENT_ENDPOINT)
  const { PostToConnectionCommand } = await getCommands()
  try {
    await client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(payload)) }))
    return true
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 410 || error?.name === 'GoneException') {
      await store.closeConnection(connectionId)
      return false
    }
    throw error
  }
}

export async function broadcastPollEvent(pollId, type, data = {}) {
  const store = await repository()
  const poll = await store.readPoll(pollId)
  const connections = (await store.listConnections(poll)).filter((item) =>
    type === 'chat.message' ? item.purpose === 'chat' : type === 'poll.updated' || item.purpose === 'results')
  const outcomes = await Promise.allSettled(connections.map((item) => sendConnection(store, item.connectionId, { type, pollId, ...data })))
  const failures = outcomes.filter((outcome) => outcome.status === 'rejected')
  for (const failure of failures) console.error(JSON.stringify({ event: 'websocket_send_failed', pollId, message: failure.reason?.message }))
  return { sent: outcomes.length - failures.length, failed: failures.length }
}
