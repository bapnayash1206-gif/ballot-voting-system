export function resolveApiMode(value = '') {
  return value === 'aws' ? 'aws' : 'local'
}

export function canUseLocalOnlyFeatures(mode) {
  return resolveApiMode(mode) === 'local'
}

const MAX_POLL_LIST_PAGES = 1000

export async function listPollsForView(api, mode, area, { maxPages = MAX_POLL_LIST_PAGES } = {}) {
  const awsMode = resolveApiMode(mode) === 'aws'
  const listPage = awsMode && area === 'voter' ? api.listVoterPolls : api.listPolls
  if (!awsMode) return listPage.call(api)

  const polls = []
  const seenCursors = new Set()
  let cursor
  let dashboard
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await listPage.call(api, cursor)
    if (!page || !Array.isArray(page.polls)) throw new Error('The AWS poll-list response is invalid')
    polls.push(...page.polls)
    if (pageNumber === 0 && page.dashboard) dashboard = page.dashboard

    const nextCursor = page.nextCursor
    if (nextCursor === undefined || nextCursor === null) {
      return { ...page, polls, nextCursor: null, ...(dashboard ? { dashboard } : {}) }
    }
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
      throw new Error('The AWS poll-list cursor is invalid')
    }
    if (seenCursors.has(nextCursor)) throw new Error('The AWS poll-list cursor repeated; pagination stopped')
    seenCursors.add(nextCursor)
    if (pageNumber === maxPages - 1) throw new Error(`The AWS poll list exceeded the ${maxPages}-page safety limit`)
    cursor = nextCursor
  }
  throw new Error(`The AWS poll list exceeded the ${maxPages}-page safety limit`)
}
// AWS API client scaffold. It can send a Google OIDC ID token as Bearer auth,
// App selects this adapter only when VITE_API_MODE=aws.
export function createAwsBackend({
  httpBaseUrl = import.meta.env?.VITE_HTTP_API_URL || '',
  webSocketUrl = import.meta.env?.VITE_WEBSOCKET_API_URL || '',
  getIdentityToken,

  fetchImpl = (...args) => fetch(...args),
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    if (!httpBaseUrl) throw new Error('VITE_HTTP_API_URL is not configured')
    const getToken = getIdentityToken
    if (typeof getToken !== 'function') throw new Error('An OIDC identity-token provider is required')
    const identityToken = await getToken()
    if (!identityToken) throw new Error('Sign in is required to use the AWS voting API')
    let response
    try {
      response = await fetchImpl(`${httpBaseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${identityToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new Error('Could not reach the AWS voting API. Check its configured URL and availability.', { cause: error })
    }
    let payload
    try { payload = await response.json() } catch { payload = {} }
    if (response.status === 401) throw new Error('Google sign-in was rejected or has expired. Sign out and sign in again.')
    if (!response.ok) throw new Error(payload.error || `AWS API request failed (${response.status})`)
    return payload
  }

  const idPath = (pollId) => `/polls/${encodeURIComponent(pollId)}`
  const pollListPath = (view, cursor) => {
    const query = new URLSearchParams({ view })
    if (cursor) query.set('cursor', cursor)
    return `/polls?${query.toString()}`
  }
  const api = {
    getCurrentUser: () => request('/auth/me'),
    listPolls: (cursor) => request(pollListPath('admin', cursor)),
    listVoterPolls: (cursor) => request(pollListPath('voter', cursor)),
    readPoll: (pollId) => request(idPath(pollId)),
    createPoll: (poll) => request('/polls', { method: 'POST', body: poll }),
    updatePoll: (pollId, poll) => request(idPath(pollId), { method: 'PATCH', body: poll }),
    deletePoll: (pollId) => request(idPath(pollId), { method: 'DELETE' }),
    startPoll: (pollId) => request(`${idPath(pollId)}/start`, { method: 'POST' }),
    closePoll: (pollId) => request(`${idPath(pollId)}/close`, { method: 'POST' }),
    reopenPoll: (pollId) => request(`${idPath(pollId)}/reopen`, { method: 'POST' }),
    hasVoted: (pollId) => request(`${idPath(pollId)}/votes`),
    submitVote: (pollId, vote, idempotencyKey) => request(`${idPath(pollId)}/votes`, {
      method: 'POST', body: vote, headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }),
    getResults: (pollId) => request(`${idPath(pollId)}/results`),
    getChat: (pollId, limit = 50) => request(`${idPath(pollId)}/chat?limit=${encodeURIComponent(limit)}`),
    async connectPoll(pollId, purpose, onMessage, onState = () => {}) {
      if (!webSocketUrl) throw new Error('VITE_WEBSOCKET_API_URL is not configured')
      if (!['results', 'chat'].includes(purpose)) throw new Error('WebSocket purpose must be results or chat')
      if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is not available in this environment')
      const { ticket } = await request(`${idPath(pollId)}/ws-ticket`, { method: 'POST', body: { purpose } })
      const socket = new WebSocketImpl(`${webSocketUrl}${webSocketUrl.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`)
      socket.addEventListener('open', () => {
        onState('connected')
        if (purpose === 'results') socket.send(JSON.stringify({ action: 'results.subscribe' }))
      })
      socket.addEventListener('close', () => onState('disconnected'))
      socket.addEventListener('error', () => onState('error'))
      socket.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data)
          if (payload.type === 'results.updated') {
            api.getResults(pollId).then(({ results }) => onMessage({ type: 'results.snapshot', pollId, results }))
              .catch(() => onState('refresh-failed'))
          } else onMessage(payload)
        } catch { onState('invalid-message') }
      })
      return socket
    },
    sendChat(socket, text) {
      if (!socket || socket.readyState !== 1) throw new Error('The poll chat WebSocket is not connected')
      socket.send(JSON.stringify({ action: 'chat.send', text }))
    },
  }
  return api
}
