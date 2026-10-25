import { getParameterStoreClient } from './awsClients.js'

/**
 * Retrieves the stable HMAC key from a pre-created SSM Standard SecureString.
 * The successful value is cached per Lambda execution environment. Failed
 * retrievals are not cached, allowing a later invocation to retry safely.
 */
export function createVoterKeySecretProvider({
  parameterName = process.env.VOTER_KEY_PARAMETER_NAME,
  getClient = getParameterStoreClient,
  createCommand = async (input) => {
    const { GetParameterCommand } = await import('@aws-sdk/client-ssm')
    return new GetParameterCommand(input)
  },
} = {}) {
  let secretPromise

  return async function getVoterKeySecret() {
    if (typeof parameterName !== 'string' || !/^\/[A-Za-z0-9_.\-/]+$/.test(parameterName)) {
      throw new Error('VOTER_KEY_PARAMETER_NAME must be a valid hierarchical SSM parameter name')
    }
    if (!secretPromise) {
      secretPromise = (async () => {
        const [client, command] = await Promise.all([
          getClient(),
          createCommand({ Name: parameterName, WithDecryption: true }),
        ])
        const response = await client.send(command)
        const secret = response?.Parameter?.Value
        if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error('SSM parameter is missing or does not meet the minimum key length')
        }
        return secret
      })().catch(() => {
        secretPromise = undefined
        throw new Error('Voter key secret is unavailable from Parameter Store')
      })
    }
    return secretPromise
  }
}