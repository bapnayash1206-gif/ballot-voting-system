import { getGoogleIdToken } from '../auth/googleIdentity.js'

function authHeaders() {
  const token = getGoogleIdToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

async function request(path, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...authHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'The local chat service did not respond in time.'
      : 'Could not reach the local chat service. Check that the backend is running.', { cause: error })
  }
  let payload
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok) throw new Error(payload.error || `Chat request failed (${response.status})`)
  return payload
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

export function subscribeChat(path, { onMessage, onStatus, onError } = {}) {
  const controller = new AbortController()
  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`/api${path}`, {
          credentials: 'same-origin', headers: authHeaders(), signal: controller.signal,
        })
        if (!response.ok) {
          let payload = {}
          try { payload = await response.json() } catch { payload = {} }
          const error = new Error(payload.error || `Chat stream failed (${response.status})`)
          if ([401, 403, 404].includes(response.status)) { onError?.(error); onStatus?.('error'); return }
          throw error
        }
        onStatus?.('connected')
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const eventName = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7)
            const dataText = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
            if (dataText) {
              try { onMessage?.({ type: eventName, ...JSON.parse(dataText) }) }
              catch (error) { onError?.(error) }
            }
          }
        }
        if (!controller.signal.aborted) onStatus?.('reconnecting')
      } catch (error) {
        if (controller.signal.aborted) return
        onStatus?.('reconnecting')
        onError?.(error)
      }
      await delay(1000, controller.signal)
    }
  }
  run()
  return controller
}

const pollPath = (pollId) => `/polls/${encodeURIComponent(pollId)}/chat`
export const localChatApi = {
  listPollMessages: (pollId) => request(pollPath(pollId)),
  sendPollMessage: (pollId, text) => request(pollPath(pollId), { method: 'POST', body: { text } }),
  streamPoll: (pollId, handlers) => subscribeChat(`${pollPath(pollId)}/stream`, handlers),
  listRooms: () => request('/admin/chat/rooms'),
  listAdminMessages: (pollId) => request(`/admin/chat/${encodeURIComponent(pollId)}`),
  moderate: (pollId, messageId, action) => request(`/admin/chat/${encodeURIComponent(pollId)}/messages/${encodeURIComponent(messageId)}/moderate`, { method: 'POST', body: { action } }),
  streamAdmin: (handlers) => subscribeChat('/admin/chat/stream', handlers),
}
