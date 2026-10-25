// Client for the local development-only API. Identity headers are mock values.
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new Error('The local backend did not respond within 5 seconds. Check that npm run dev:backend is running.', { cause: error })
    }
    throw new Error('Could not reach the local backend. Check that npm run dev:backend is running and restart Vite if you changed its proxy configuration.', { cause: error })
  }
  let payload
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok) throw new Error(payload.error || `API request failed (${response.status})`)
  return payload
}

export const mockBackend = {
  listPolls: () => request('/polls'),
  readPoll: (pollId) => request(`/polls/${encodeURIComponent(pollId)}`),
  createPoll: (poll, adminId = 'local-admin') => request('/polls', {
    method: 'POST', body: poll, headers: { 'x-dev-admin-id': adminId },
  }),
  updatePoll: (pollId, poll, adminId = 'local-admin') => request(`/polls/${encodeURIComponent(pollId)}`, {
    method: 'PATCH', body: poll, headers: { 'x-dev-admin-id': adminId },
  }),
  deletePoll: (pollId, adminId = 'local-admin') => request(`/polls/${encodeURIComponent(pollId)}`, {
    method: 'DELETE', headers: { 'x-dev-admin-id': adminId },
  }),
  startPoll: (pollId, adminId = 'local-admin') => request(`/polls/${encodeURIComponent(pollId)}/start`, {
    method: 'POST', headers: { 'x-dev-admin-id': adminId },
  }),
  closePoll: (pollId, adminId = 'local-admin') => request(`/polls/${encodeURIComponent(pollId)}/close`, {
    method: 'POST', headers: { 'x-dev-admin-id': adminId },
  }),
  reopenPoll: (pollId, adminId = 'local-admin') => request(`/polls/${encodeURIComponent(pollId)}/reopen`, {
    method: 'POST', headers: { 'x-dev-admin-id': adminId },
  }),
  submitVote: (pollId, vote, voterId = 'local-voter') => request(`/polls/${encodeURIComponent(pollId)}/votes`, {
    method: 'POST', body: vote, headers: { 'x-dev-voter-id': voterId },
  }),
  hasVoted: (pollId, voterId = 'local-voter') => request(`/polls/${encodeURIComponent(pollId)}/votes`, {
    headers: { 'x-dev-voter-id': voterId },
  }),
  getResults: (pollId, voterId = 'local-voter') => request(`/polls/${encodeURIComponent(pollId)}/results`, {
    headers: { 'x-dev-voter-id': voterId },
  }),
}
