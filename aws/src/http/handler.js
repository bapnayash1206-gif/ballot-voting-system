import { getCommands, getDocumentClient } from '../shared/awsClients.js'
import { createVoterKeySecretProvider } from '../shared/voterKeySecret.js'
import { ApiError, claimsFrom, errorResponse, isAdminSubject, json, parseBody, requireAdmin } from '../shared/http.js'
import { createDynamoRepository } from '../repository/dynamoRepository.js'

const getVoterKeySecret = createVoterKeySecretProvider()
let repositoryPromise
async function repository() {
  if (!repositoryPromise) {
    repositoryPromise = Promise.all([getDocumentClient(), getCommands(), getVoterKeySecret()])
      .then(([client, commands, voterKeySecret]) => createDynamoRepository({
        client, commands, env: { ...process.env, VOTER_KEY_SECRET: voterKeySecret },
      }))
      .catch((error) => {
        repositoryPromise = undefined
        throw error
      })
  }
  return repositoryPromise
}

export function createHttpHandler({ getRepository = repository, env = process.env } = {}) {
  return async (event) => {
    try {
      const method = event.requestContext?.http?.method || event.httpMethod || 'GET'
      const path = event.rawPath || event.path || '/'
      if (method === 'GET' && path === '/health') return json(200, { status: 'ok', mode: 'aws' })
      const claims = claimsFrom(event)
      if (method === 'GET' && path === '/auth/me') {
        const isAdmin = isAdminSubject(claims, env)
        return json(200, {
          user: {
            sub: claims.sub,
            email: typeof claims.email === 'string' ? claims.email : '',
            name: typeof claims.name === 'string' ? claims.name : '',
            role: isAdmin ? 'admin' : 'voter',
          },
          isAdmin,
        })
      }
      const store = await getRepository()
      const body = ['POST', 'PATCH', 'PUT'].includes(method) ? parseBody(event) : {}
      const pollMatch = path.match(/^\/polls\/([^/]+)(?:\/(start|close|reopen|votes|results))?\/?$/)
      if (method === 'GET' && path === '/polls') {
        const view = event.queryStringParameters?.view
        if (view && !['admin', 'voter'].includes(view)) throw new ApiError(400, 'INVALID_VIEW', 'Poll list view must be admin or voter')
        const admin = isAdminSubject(claims, env)
        if (view === 'admin') requireAdmin(claims, env)
        const voterView = view === 'voter' || (!view && !admin)
        const result = voterView
          ? await store.listVoterPolls(event.queryStringParameters?.cursor)
          : await store.listPolls(claims.sub, event.queryStringParameters?.cursor)
        return json(200, result)
      }
      if (method === 'POST' && path === '/polls') {
        requireAdmin(claims, env)
        return json(201, { poll: await store.createPoll(body, claims.sub) })
      }
      if (!pollMatch) throw new ApiError(404, 'NOT_FOUND', 'Route not found')
      const pollId = decodeURIComponent(pollMatch[1])
      const action = pollMatch[2]

      if (!action && method === 'GET') return json(200, { poll: await store.readPollForViewer(pollId, claims.sub, isAdminSubject(claims, env)) })
      if (!action && method === 'PATCH') {
        requireAdmin(claims, env)
        return json(200, { poll: await store.updatePoll(pollId, body, claims.sub) })
      }
      if (!action && method === 'DELETE') {
        requireAdmin(claims, env)
        return json(200, await store.deletePoll(pollId, claims.sub))
      }
      if (['start', 'close', 'reopen'].includes(action) && method === 'POST') {
        requireAdmin(claims, env)
        return json(200, { poll: await store.lifecycle(pollId, claims.sub, action) })
      }
      if (action === 'votes' && method === 'GET') return json(200, await store.hasVoted(pollId, claims.sub))
      if (action === 'votes' && method === 'POST') {
        return json(201, await store.submitVote(pollId, claims.sub, body, event.headers?.['idempotency-key']))
      }
      if (action === 'results' && method === 'GET') return json(200, { results: await store.getResults(pollId, claims.sub) })
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    } catch (error) { return errorResponse(error) }
  }
}

export const handler = createHttpHandler()
