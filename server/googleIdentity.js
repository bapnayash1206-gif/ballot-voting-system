import { OAuth2Client } from 'google-auth-library'
import { ApiError } from './votingService.js'

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const googleAuthClient = new OAuth2Client()

function tokenHeader(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) }
  catch { throw new ApiError(401, 'Invalid Google identity token') }
}

/** Verify a Google-issued OIDC ID token using Google's maintained Node Auth Library. */
export async function verifyGoogleIdentityToken(token, {
  clientId = process.env.GOOGLE_CLIENT_ID,
  authClient = googleAuthClient,
} = {}) {
  if (!clientId) throw new ApiError(503, 'Google authentication is not configured on the backend')
  if (typeof token !== 'string' || token.length > 16_384 || token.split('.').length !== 3) {
    throw new ApiError(401, 'A valid Google identity token is required')
  }
  const header = tokenHeader(token)
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new ApiError(401, 'Unsupported Google identity token signature')
  }

  let claims
  try {
    const ticket = await authClient.verifyIdToken({ idToken: token, audience: clientId })
    claims = ticket.getPayload()
  } catch {
    // Do not return token material or provider internals in client-facing errors.
    throw new ApiError(401, 'Google identity token is invalid or expired')
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!claims || !GOOGLE_ISSUERS.includes(claims.iss)
    || claims.aud !== clientId || (claims.azp && claims.azp !== clientId)
    || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds
    || !Number.isFinite(claims.iat) || claims.iat > nowSeconds + 60
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + 60))
    || typeof claims.sub !== 'string' || !claims.sub || claims.email_verified !== true) {
    throw new ApiError(401, 'Google identity token claims are invalid or expired')
  }
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    name: typeof claims.name === 'string' ? claims.name : '',
  }
}
