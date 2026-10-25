// Local account mode uses same-origin HttpOnly session cookies. It never sends development identity headers.
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
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

export const accountBackend = {
  getCurrentUser: () => request('/auth/me'),
  register: (input) => request('/auth/register', { method: 'POST', body: input }),
  login: (input) => request('/auth/login', { method: 'POST', body: input }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (input) => request('/auth/password', { method: 'POST', body: input }),
  listPolls: () => request('/polls'),
  readPoll: (pollId) => request(`/polls/${encodeURIComponent(pollId)}`),
  createPoll: (poll) => request('/polls', { method: 'POST', body: poll }),
  updatePoll: (pollId, poll) => request(`/polls/${encodeURIComponent(pollId)}`, { method: 'PATCH', body: poll }),
  deletePoll: (pollId) => request(`/polls/${encodeURIComponent(pollId)}`, { method: 'DELETE' }),
  startPoll: (pollId) => request(`/polls/${encodeURIComponent(pollId)}/start`, { method: 'POST' }),
  closePoll: (pollId) => request(`/polls/${encodeURIComponent(pollId)}/close`, { method: 'POST' }),
  reopenPoll: (pollId) => request(`/polls/${encodeURIComponent(pollId)}/reopen`, { method: 'POST' }),
  submitVote: (pollId, vote) => request(`/polls/${encodeURIComponent(pollId)}/votes`, { method: 'POST', body: vote }),
  hasVoted: (pollId) => request(`/polls/${encodeURIComponent(pollId)}/votes`),
  getResults: (pollId) => request(`/polls/${encodeURIComponent(pollId)}/results`),
  createEncryptedBackup: (passphrase) => request('/admin/backup/export', { method: 'POST', body: { passphrase } }),
}
