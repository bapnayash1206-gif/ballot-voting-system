import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiError, createVotingService } from './votingService.js'
import { verifyGoogleIdentityToken } from './googleIdentity.js'
import { AccountError, accountAuth, createAccountService } from './accountService.js'
import { createChatService } from './chatService.js'
import { createBackupService } from './backupService.js'

// Node does not automatically load Vite's .env file. Load it for the local API when
// supported, while preserving variables already supplied by the shell.
try { process.loadEnvFile?.(resolve('.env')) }
catch (error) { if (error.code !== 'ENOENT') throw error }

const port = Number(process.env.MOCK_API_PORT || 8787)
const pollIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const splitSubjects = (value = '') => new Set(value.split(',').map((item) => item.trim()).filter(Boolean))

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw new ApiError(413, 'Request body is too large')
  }
  if (!body) return {}
  let parsed
  try { parsed = JSON.parse(body) } catch { throw new ApiError(400, 'Request body must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError(400, 'Request body must be a JSON object')
  return parsed
}

function send(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(payload))
}

export function createRequestHandler(service = createVotingService(), {
  chatService = createChatService(),
  backupService = createBackupService(),
  authMode = 'development',
  googleClientId = process.env.GOOGLE_CLIENT_ID,
  adminSubjects = splitSubjects(process.env.GOOGLE_ADMIN_SUBJECTS),
  verifyToken = (token) => verifyGoogleIdentityToken(token, { clientId: googleClientId }),
  accountService,
  secureCookies = process.env.NODE_ENV === 'production',
} = {}) {
  return async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`)
    const path = url.pathname
    const method = request.method
    if (method === 'GET' && path === '/health') return send(response, 200, { status: 'ok' })
    if (method === 'GET' && path === '/api/health') return send(response, 200, { ok: true, mode: 'development-only in-memory mock' })
    const bodyRoutes = ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/password']
    let body
    if (bodyRoutes.includes(`${method} ${path}`)) body = await readJson(request)
    if (authMode === 'accounts' && method === 'POST' && path === '/api/auth/register') {
      if (!accountService) throw new ApiError(503, 'Local account authentication is not configured')
      const user = await accountService.registerVoter(body)
      return send(response, 201, { user })
    }
    if (authMode === 'accounts' && method === 'POST' && path === '/api/auth/login') {
      if (!accountService) throw new ApiError(503, 'Local account authentication is not configured')
      const login = await accountService.login({ ...body, rateKey: request.socket?.remoteAddress || request.headers['x-forwarded-for'] || '' })
      return send(response, 200, { user: login.user }, { 'set-cookie': accountAuth.cookie(login.token, { secure: secureCookies }) })
    }
    if (authMode === 'accounts' && method === 'POST' && path === '/api/auth/logout') {
      accountService?.logout(accountAuth.readCookie(request.headers.cookie))
      return send(response, 200, { signedOut: true }, { 'set-cookie': accountAuth.clearCookie({ secure: secureCookies }) })
    }
    let identity
    if (authMode === 'accounts') {
      if (!accountService) throw new ApiError(503, 'Local account authentication is not configured')
      identity = accountService.userForSession(accountAuth.readCookie(request.headers.cookie))
      if (!identity) throw new ApiError(401, 'Sign in is required.')
    } else if (authMode === 'google') {
      const authorization = request.headers.authorization
      const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!token) throw new ApiError(401, 'A valid Google sign-in is required')
      identity = await verifyToken(token)
    } else if (authMode === 'development') {
      identity = { sub: String(request.headers['x-dev-voter-id'] || '').trim(), email: '', name: 'Local development user' }
    } else throw new ApiError(500, 'Unsupported authentication mode')
    const isAdmin = authMode === 'accounts'
      ? identity.role === 'admin'
      : authMode === 'development'
      ? Boolean(typeof request.headers['x-dev-admin-id'] === 'string' && request.headers['x-dev-admin-id'].trim())
      : adminSubjects.has(identity.sub)
    const requireAdmin = () => {
      if (!isAdmin) throw new ApiError(403, 'Administrator access is required')
    }
    if (path.startsWith('/api/') && path.includes('/chat') && !['accounts', 'google'].includes(authMode)) throw new ApiError(401, 'Poll chat requires a verified account session.')
    const chatWriteEvent = (event) => {
      if (!response.writableEnded) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const streamChat = (topic) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' })
      response.write(': connected\n\n')
      const unsubscribe = chatService.subscribe(topic, chatWriteEvent)
      const keepAlive = setInterval(() => { if (!response.writableEnded) response.write(': keep-alive\n\n') }, 20_000)
      keepAlive.unref?.()
      response.on('close', () => { clearInterval(keepAlive); unsubscribe() })
      return undefined
    }
    if (method === 'GET' && path === '/api/admin/chat/rooms') {
      requireAdmin()
      const rooms = await chatService.listRooms(service.listPolls())
      return send(response, 200, { rooms })
    }
    if (method === 'GET' && path === '/api/admin/chat/stream') {
      requireAdmin()
      return streamChat('*')
    }
    const adminChatMatch = path.match(/^\/api\/admin\/chat\/([^/]+)(?:\/messages\/([^/]+)\/moderate)?$/)
    if (adminChatMatch) {
      requireAdmin()
      const pollId = decodeURIComponent(adminChatMatch[1])
      if (!pollIdPattern.test(pollId)) throw new ApiError(400, 'Poll ID must be a UUID')
      const poll = service.readPoll(pollId)
      if (method === 'GET' && !adminChatMatch[2]) return send(response, 200, { messages: await chatService.listMessages(pollId, poll, { includeHidden: true }) })
      if (method === 'POST' && adminChatMatch[2]) {
        const messageId = decodeURIComponent(adminChatMatch[2])
        if (!pollIdPattern.test(messageId)) throw new ApiError(400, 'Message ID is invalid')
        const body = await readJson(request)
        const message = await chatService.moderate(pollId, poll, messageId, identity, body.action)
        return send(response, 200, { message })
      }
      return send(response, 405, { error: 'Method not allowed' })
    }
    const pollChatMatch = path.match(/^\/api\/polls\/([^/]+)\/chat(?:\/(stream))?$/)
    if (pollChatMatch) {
      const pollId = decodeURIComponent(pollChatMatch[1])
      if (!pollIdPattern.test(pollId)) throw new ApiError(400, 'Poll ID must be a UUID')
      const poll = service.readPoll(pollId)
      if (!isAdmin && poll.status === 'draft') throw new ApiError(404, 'Poll not found')
      if (method === 'GET' && pollChatMatch[2] === 'stream') return streamChat(pollId)
      if (method === 'GET' && !pollChatMatch[2]) return send(response, 200, { messages: await chatService.listMessages(pollId, poll) })
      if (method === 'POST' && !pollChatMatch[2]) {
        if (isAdmin) throw new ApiError(403, 'Voter access is required to send poll chat messages.')
        const body = await readJson(request)
        const message = await chatService.sendMessage(pollId, poll, identity, body.text)
        return send(response, 201, { message })
      }
      return send(response, 405, { error: 'Method not allowed' })
    }
    if (method === 'GET' && path === '/api/auth/me') return send(response, 200, { user: identity, isAdmin })
    if (authMode === 'accounts' && method === 'POST' && path === '/api/auth/password') {
      const user = await accountService.changePassword(identity, body)
      return send(response, 200, { user })
    }
    if (authMode === 'accounts' && identity.mustChangePassword) {
      throw new ApiError(403, 'Change the initial password before using the voting application.')
    }
    if (method === 'POST' && path === '/api/admin/backup/export') {
      if (!['accounts', 'google'].includes(authMode)) throw new ApiError(403, 'Full-data export requires verified account authentication.')
      requireAdmin()
      const backupRequest = await readJson(request)
      if (Object.keys(backupRequest).some((key) => key !== 'passphrase')) { backupRequest.passphrase = ''; throw new ApiError(400, 'Only a backup passphrase may be provided.') }
      if (typeof backupRequest.passphrase !== 'string' || backupRequest.passphrase.length < 16 || Buffer.byteLength(backupRequest.passphrase, 'utf8') > 1024) {
        backupRequest.passphrase = ''
        throw new ApiError(400, 'Backup passphrase must contain at least 16 characters and at most 1024 UTF-8 bytes.')
      }
      try {
        const snapshot = service.exportSnapshot()
        const result = await backupService.writeBackup(snapshot, backupRequest.passphrase)
        backupRequest.passphrase = ''
        return send(response, 201, { backup: result }, { 'cache-control': 'no-store' })
      } catch {
        backupRequest.passphrase = ''
        console.error(JSON.stringify({ event: 'admin_backup_failed' }))
        return send(response, 500, { error: 'Encrypted backup could not be created. No backup was reported as complete.' })
      }
    }
    if (method === 'GET' && path === '/api/polls') {
      const polls = service.listPolls().filter((poll) => authMode !== 'accounts' || isAdmin || poll.status !== 'draft').map((poll) => {
        if (!['google', 'accounts'].includes(authMode) || isAdmin) return poll
        const voterPoll = { ...poll }
        delete voterPoll.ballotCount
        return voterPoll
      })
      return send(response, 200, { polls })
    }
    if (method === 'POST' && path === '/api/polls') {
      requireAdmin()
      return send(response, 201, { poll: service.createPoll(await readJson(request)) })
    }

    const match = path.match(/^\/api\/polls\/([^/]+)(?:\/(start|close|reopen|votes|results))?$/)
    if (!match) return send(response, 404, { error: 'Route not found' })
    let pollId
    try { pollId = decodeURIComponent(match[1]) } catch { return send(response, 400, { error: 'Poll ID is invalid' }) }
    if (!pollIdPattern.test(pollId)) return send(response, 400, { error: 'Poll ID must be a UUID' })
    const action = match[2]
    if (method === 'GET' && !action) {
      const poll = service.readPoll(pollId)
      if (authMode === 'accounts' && !isAdmin && poll.status === 'draft') throw new ApiError(404, 'Poll not found')
      if (['google', 'accounts'].includes(authMode) && !isAdmin) delete poll.ballotCount
      return send(response, 200, { poll })
    }
    if (method === 'PATCH' && !action) {
      requireAdmin()
      return send(response, 200, { poll: service.updatePoll(pollId, await readJson(request)) })
    }
    if (method === 'DELETE' && !action) {
      requireAdmin()
      return send(response, 200, service.deletePoll(pollId))
    }
    if (method === 'GET' && action === 'votes') {
      if (authMode === 'accounts' && identity.role !== 'voter') throw new ApiError(403, 'Voter access is required.')
      return send(response, 200, service.hasVoted(pollId, identity.sub))
    }
    if (method === 'POST' && action === 'start') {
      requireAdmin()
      return send(response, 200, { poll: service.startPoll(pollId) })
    }
    if (method === 'POST' && action === 'close') {
      requireAdmin()
      return send(response, 200, { poll: service.closePoll(pollId) })
    }
    if (method === 'POST' && action === 'reopen') {
      requireAdmin()
      return send(response, 200, { poll: service.reopenPoll(pollId) })
    }
    if (method === 'POST' && action === 'votes') {
      if (authMode === 'accounts' && identity.role !== 'voter') throw new ApiError(403, 'Voter access is required.')
      const result = service.submitVote(pollId, identity.sub, await readJson(request))
      return send(response, 201, result)
    }
    if (method === 'GET' && action === 'results') {
      return send(response, 200, { results: service.getResults(pollId, identity.sub) })
    }
    return send(response, 405, { error: 'Method not allowed' })
  } catch (error) {
    const status = error instanceof ApiError || error instanceof AccountError ? error.status : 500
    if (status === 500) console.error(error)
    return send(response, status, { error: status === 500 ? 'Internal server error' : error.message })
  }
  }
}

export function createApiServer(service = createVotingService(), options) {
  return createServer(createRequestHandler(service, options))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const authMode = process.env.AUTH_MODE || 'accounts'
  const accountService = authMode === 'accounts'
    ? createAccountService({ storageFile: process.env.ACCOUNTS_FILE || resolve('.local-data/accounts.json') })
    : null
  const chatService = createChatService()
  const backupService = createBackupService()
  const start = async () => {
    if (accountService) await accountService.initialize()
    await chatService.initialize()
    const configuredServer = createApiServer(createVotingService(), { authMode, accountService, chatService, backupService })
    configuredServer.listen(port, '127.0.0.1', () => {
      console.log(`Local ${authMode === 'google' ? 'Google-token verified' : authMode === 'accounts' ? 'local account session' : 'development-only mock'} API listening at http://127.0.0.1:${port}`)
      if (authMode === 'accounts') console.log('Development-only account store: local file; HttpOnly session cookies; in-memory sessions; not production-ready.')
      else if (authMode === 'google') console.log('Google mode verifies ID-token signatures/claims; administrator subjects come only from GOOGLE_ADMIN_SUBJECTS. Storage remains in-memory.')
      else console.log('In-memory state and x-dev-* identity headers are not production-secure.')
    })
  }
  start().catch((error) => {
    console.error(`Could not start local authentication: ${error.message}`)
    process.exitCode = 1
  })
}
