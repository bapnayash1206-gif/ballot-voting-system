import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import { verifyGoogleIdentityToken } from './googleIdentity.js'

const clientId = 'test-google-client.apps.googleusercontent.com'
const now = Math.floor(Date.now() / 1000)
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const certificate = publicKey.export({ type: 'spki', format: 'pem' })

function makeToken(claimOverrides = {}, key = privateKey, headerOverrides = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'RS256', kid: 'test-key', ...headerOverrides })
  const payload = encode({
    iss: 'https://accounts.google.com', aud: clientId, sub: 'google-sub-123',
    exp: now + 300, iat: now - 10,
    email: 'voter@example.test', email_verified: true, ...claimOverrides,
  })
  const signed = `${header}.${payload}`
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), key).toString('base64url')}`
}

function verify(token) {
  const authClient = new OAuth2Client()
  authClient.getFederatedSignonCertsAsync = async () => ({ certs: { 'test-key': certificate } })
  return verifyGoogleIdentityToken(token, { clientId, authClient })
}

test('accepts a signed, current Google OIDC token with the configured audience', async () => {
  assert.deepEqual(await verify(makeToken()), { sub: 'google-sub-123', email: 'voter@example.test', name: '' })
})

test('rejects invalid signatures and unsupported signing algorithms', async () => {
  const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await assert.rejects(verify(makeToken({}, otherKey)), /Google identity token is invalid or expired/)
  await assert.rejects(verify(makeToken({}, privateKey, { alg: 'none' })), /Unsupported Google identity token signature/)
})

test('rejects expired, wrong-audience, wrong-issuer, and unverified-email tokens', async () => {
  await assert.rejects(verify(makeToken({ exp: now - 600 })), /Google identity token .*invalid or expired/)
  await assert.rejects(verify(makeToken({ aud: 'another-client' })), /Google identity token .*invalid or expired/)
  await assert.rejects(verify(makeToken({ aud: [clientId, 'other-audience'], azp: 'other-client' })), /Google identity token .*invalid or expired/)
  await assert.rejects(verify(makeToken({ iss: 'https://attacker.example' })), /Google identity token .*invalid or expired/)
  await assert.rejects(verify(makeToken({ email_verified: false })), /Google identity token .*invalid or expired/)
})
