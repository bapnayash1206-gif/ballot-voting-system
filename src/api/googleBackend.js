import { getGoogleIdToken } from '../auth/googleIdentity.js'

async function request(path, { method = 'GET', body } = {}) {
  const token = getGoogleIdToken()
  if (!token) throw new Error('Sign in with Google is required to use this API.')
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'The local backend did not respond within 8 seconds.'
      : 'Could not reach the local backend. Check that npm run dev:backend is running.', { cause: error })
  }
  let payload
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok) throw new Error(payload.error || `API request failed (${response.status})`)
  return payload
}

const idPath = (pollId) => `/polls/${encodeURIComponent(pollId)}`
export const googleBackend = {
  getCurrentUser: () => request('/auth/me'),
  listPolls: () => request('/polls'),
  readPoll: (pollId) => request(idPath(pollId)),
  createPoll: (poll) => request('/polls', { method: 'POST', body: poll }),
  updatePoll: (pollId, poll) => request(idPath(pollId), { method: 'PATCH', body: poll }),
  deletePoll: (pollId) => request(idPath(pollId), { method: 'DELETE' }),
  startPoll: (pollId) => request(`${idPath(pollId)}/start`, { method: 'POST' }),
  closePoll: (pollId) => request(`${idPath(pollId)}/close`, { method: 'POST' }),
  reopenPoll: (pollId) => request(`${idPath(pollId)}/reopen`, { method: 'POST' }),
  submitVote: (pollId, vote) => request(`${idPath(pollId)}/votes`, { method: 'POST', body: vote }),
  hasVoted: (pollId) => request(`${idPath(pollId)}/votes`),
  getResults: (pollId) => request(`${idPath(pollId)}/results`),
  createEncryptedBackup: (passphrase) => request('/admin/backup/export', { method: 'POST', body: { passphrase } }),
}
