export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export const json = (statusCode, value) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(value),
})

export function claimsFrom(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims
  if (!claims?.sub) throw new ApiError(401, 'UNAUTHORIZED', 'A valid sign-in is required')
  return claims
}

export function isAdminSubject(claims, env = process.env) {
  const allowedSubjects = new Set((env.GOOGLE_ADMIN_SUBJECTS || '').split(',').map((value) => value.trim()).filter(Boolean))
  return Boolean(claims?.sub && allowedSubjects.has(claims.sub))
}

export function requireAdmin(claims, env = process.env) {
  if (!isAdminSubject(claims, env)) throw new ApiError(403, 'FORBIDDEN', 'Administrator access is required')
}

export function parseBody(event) {
  if (!event.body) return {}
  try {
    const parsed = JSON.parse(event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected object')
    return parsed
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be a JSON object')
  }
}

export function errorResponse(error) {
  if (error instanceof ApiError) return json(error.statusCode, { code: error.code, error: error.message })
  if (error?.name === 'ConditionalCheckFailedException' || error?.name === 'TransactionCanceledException') {
    return json(409, { code: 'CONFLICT', error: 'The request conflicts with the current poll state. Refresh and try again.' })
  }
  console.error(JSON.stringify({ message: error?.message || 'Unknown error', name: error?.name || 'Error' }))
  return json(500, { code: 'INTERNAL', error: 'Internal server error' })
}
