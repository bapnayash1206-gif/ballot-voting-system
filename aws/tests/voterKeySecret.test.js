import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoterKeySecretProvider } from '../src/shared/voterKeySecret.js'

const parameterName = '/ballot/test/voter-key'
const validSecret = '0123456789abcdef0123456789abcdef'

function dependencies(send) {
  const requests = []
  let clientRequests = 0
  const getClient = async () => {
    clientRequests += 1
    return { send: async (command) => { requests.push(command.input); return send(command) } }
  }
  const createCommand = async (input) => ({ input })
  return { getClient, createCommand, requests, clientRequests: () => clientRequests }
}

test('loads the SSM SecureString with decryption and caches the successful value', async () => {
  const deps = dependencies(async () => ({ Parameter: { Value: validSecret } }))
  const getSecret = createVoterKeySecretProvider({ parameterName, ...deps })
  assert.equal(await getSecret(), validSecret)
  assert.equal(await getSecret(), validSecret)
  assert.equal(deps.requests.length, 1)
  assert.deepEqual(deps.requests[0], { Name: parameterName, WithDecryption: true })
})

test('concurrent cold-start requests share one Parameter Store read', async () => {
  let resolveRead
  let reads = 0
  const getSecret = createVoterKeySecretProvider({
    parameterName,
    getClient: async () => ({ send: () => { reads += 1; return new Promise((resolve) => { resolveRead = resolve }) } }),
    createCommand: async (input) => ({ input }),
  })
  const first = getSecret()
  const second = getSecret()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  resolveRead({ Parameter: { Value: validSecret } })
  assert.deepEqual(await Promise.all([first, second]), [validSecret, validSecret])
})

test('fails safely when the parameter name is missing or invalid', async () => {
  let clientCalls = 0
  const getSecret = createVoterKeySecretProvider({
    parameterName: '',
    getClient: async () => { clientCalls += 1; return { send: async () => ({}) } },
    createCommand: async (input) => ({ input }),
  })
  await assert.rejects(getSecret(), /VOTER_KEY_PARAMETER_NAME must be a valid hierarchical SSM parameter name/)
  assert.equal(clientCalls, 0)
})

test('maps retrieval failures to a safe message and retries instead of caching failure', async () => {
  let attempts = 0
  const getSecret = createVoterKeySecretProvider({
    parameterName,
    getClient: async () => ({ send: async () => {
      attempts += 1
      if (attempts === 1) throw new Error(`provider failure with ${validSecret}`)
      return { Parameter: { Value: validSecret } }
    } }),
    createCommand: async (input) => ({ input }),
  })
  await assert.rejects(getSecret(), (error) => {
    assert.equal(error.message, 'Voter key secret is unavailable from Parameter Store')
    assert.equal(error.cause, undefined)
    assert.equal(error.message.includes(validSecret), false)
    return true
  })
  assert.equal(await getSecret(), validSecret)
  assert.equal(attempts, 2)
})

test('rejects missing or too-short parameter values without revealing them', async () => {
  for (const Parameter of [undefined, { Value: 'too-short-secret-value' }]) {
    const getSecret = createVoterKeySecretProvider({
      parameterName,
      getClient: async () => ({ send: async () => ({ Parameter }) }),
      createCommand: async (input) => ({ input }),
    })
    await assert.rejects(getSecret(), (error) => {
      assert.equal(error.message, 'Voter key secret is unavailable from Parameter Store')
      return true
    })
  }
})