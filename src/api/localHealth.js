export async function checkLocalApiHealth({ fetchImpl = (...args) => fetch(...args), timeoutMs = 3000 } = {}) {
  let response
  try {
    response = await fetchImpl('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error('Local development API is unreachable.', { cause: error })
  }

  let payload
  try { payload = await response.json() } catch {
    throw new Error('Local development API returned an invalid health response.')
  }
  if (!response.ok || payload?.ok !== true) {
    throw new Error('Local development API is unavailable.')
  }
  return { mode: payload.mode || 'local development' }
}
