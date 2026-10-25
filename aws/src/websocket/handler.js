import { getCommands, getDocumentClient } from '../shared/awsClients.js'
import { ApiError, parseBody } from '../shared/http.js'
import { createDynamoRepository } from '../repository/dynamoRepository.js'
import { sendConnection } from './broadcast.js'

let cachedRepository
async function repository() {
  if (!cachedRepository) cachedRepository = createDynamoRepository({
    client: await getDocumentClient(), commands: await getCommands(), env: process.env,
  })
  return cachedRepository
}

function connectionContext(event) {
  const auth = event.requestContext?.authorizer || {}
  const context = auth.lambda || auth
  if (!auth.principalId || !context.pollId || !context.subject || !context.purpose) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid poll connection ticket is required')
  }
  return { pollId: context.pollId, subject: context.subject, purpose: context.purpose }
}

export function createWebSocketHandler({ getRepository = repository, send = sendConnection } = {}) {
  return async (event) => {
    const store = await getRepository()
    const connectionId = event.requestContext?.connectionId
    const routeKey = event.requestContext?.routeKey
    try {
      if (!connectionId) throw new ApiError(400, 'INVALID_CONNECTION', 'Connection ID is missing')
      if (routeKey === '$disconnect') { await store.closeConnection(connectionId); return { statusCode: 200, body: 'Disconnected' } }
      if (routeKey === '$connect') {
        await store.openConnection(connectionId, connectionContext(event))
        return { statusCode: 200, body: 'Connected' }
      }

      const context = connectionContext(event)
      const body = parseBody(event)
      if (routeKey === 'results.subscribe') {
        if (context.purpose !== 'results') throw new ApiError(403, 'FORBIDDEN', 'This connection is not subscribed to results')
        const results = await store.getResults(context.pollId, context.subject)
        await send(store, connectionId, { type: 'results.snapshot', pollId: context.pollId, results })
        return { statusCode: 200, body: 'Results sent' }
      }
      if (routeKey === 'chat.send') {
        if (context.purpose !== 'chat') throw new ApiError(403, 'FORBIDDEN', 'This connection is not authorized for poll chat')
        if (body.pollId && body.pollId !== context.pollId) throw new ApiError(403, 'POLL_MISMATCH', 'A connection cannot send messages to another poll')
        const message = await store.persistChat(context.pollId, context.subject, body.text)
        const recipients = (await store.listConnections(await store.readPoll(context.pollId))).filter((item) => item.purpose === 'chat')
        await Promise.allSettled(recipients.map((item) => send(store, item.connectionId, { type: 'chat.message', pollId: context.pollId, message })))
        return { statusCode: 200, body: 'Message accepted' }
      }
      throw new ApiError(400, 'UNKNOWN_ROUTE', 'Unsupported WebSocket action')
    } catch (error) {
      const statusCode = error instanceof ApiError ? error.statusCode : 500
      if (statusCode === 500) console.error(JSON.stringify({ event: 'websocket_handler_failed', routeKey, message: error?.message }))
      return { statusCode, body: JSON.stringify({ code: error.code || 'INTERNAL', error: error.message || 'Internal server error' }) }
    }
  }
}

export const handler = createWebSocketHandler()
