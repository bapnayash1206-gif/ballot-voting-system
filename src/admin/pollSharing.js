export function canSharePoll(poll) {
  return Boolean(poll?.id && poll.status !== 'draft')
}

export function buildVoterPollUrl(pollId, { configuredOrigin = '', currentOrigin = '' } = {}) {
  if (typeof pollId !== 'string' || !pollId.trim()) throw new Error('A poll ID is required to create a voter link.')
  const origin = String(configuredOrigin || currentOrigin).trim()
  if (!origin) throw new Error('Set VITE_APP_ORIGIN or open the application in a browser to create a voter link.')

  let parsed
  try { parsed = new URL(origin) }
  catch { throw new Error('The configured application origin must be a valid absolute URL.') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The configured application origin must use HTTP or HTTPS.')

  return new URL(`/poll/${encodeURIComponent(pollId)}`, parsed.origin).toString()
}

export function isLoopbackVoterUrl(value) {
  try {
    const { hostname } = new URL(value)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch { return false }
}
