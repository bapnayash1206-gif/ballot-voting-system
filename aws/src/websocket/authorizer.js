import { getCommands, getDocumentClient } from '../shared/awsClients.js'
import { createDynamoRepository } from '../repository/dynamoRepository.js'
import { ApiError } from '../shared/http.js'

let cachedRepository
async function repository() {
  if (!cachedRepository) cachedRepository = createDynamoRepository({
    client: await getDocumentClient(), commands: await getCommands(), env: process.env,
  })
  return cachedRepository
}

export function createWebSocketAuthorizer({ getRepository = repository } = {}) {
  return async (event) => {
    try {
      const ticket = event.queryStringParameters?.ticket
      const identity = await (await getRepository()).consumeWsTicket(ticket)
      return {
        principalId: identity.subject,
        policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Allow', Resource: event.methodArn }] },
        context: { subject: identity.subject, pollId: identity.pollId, purpose: identity.purpose },
      }
    } catch (error) {
      if (error instanceof ApiError) return {
        principalId: 'unauthorized',
        policyDocument: { Version: '2012-10-17', Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: event.methodArn }] },
      }
      console.error(JSON.stringify({ event: 'websocket_authorizer_failed', message: error?.message }))
      throw error
    }
  }
}

export const handler = createWebSocketAuthorizer()
