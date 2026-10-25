let documentClient
let parameterStoreClient
let managementClients = new Map()

// AWS SDK modules load only inside Lambda. Unit tests inject fakes and never contact AWS.
export async function getDocumentClient() {
  if (!documentClient) {
    const [{ DynamoDBClient }, { DynamoDBDocumentClient }] = await Promise.all([
      import('@aws-sdk/client-dynamodb'),
      import('@aws-sdk/lib-dynamodb'),
    ])
    documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    })
  }
  return documentClient
}

export async function getManagementClient(endpoint) {
  if (!managementClients.has(endpoint)) {
    const { ApiGatewayManagementApiClient } = await import('@aws-sdk/client-apigatewaymanagementapi')
    managementClients.set(endpoint, new ApiGatewayManagementApiClient({ endpoint }))
  }
  return managementClients.get(endpoint)
}

export async function getParameterStoreClient() {
  if (!parameterStoreClient) {
    const { SSMClient } = await import('@aws-sdk/client-ssm')
    parameterStoreClient = new SSMClient({})
  }
  return parameterStoreClient
}

export async function getCommands() {
  return import('@aws-sdk/lib-dynamodb')
}
