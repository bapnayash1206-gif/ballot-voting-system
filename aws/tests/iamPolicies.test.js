import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8')
const sorted = (values) => [...values].sort()

test('initial SAM template is HTTP-only and preserves retained poll data', async () => {
  const template = await read('../template.yaml')
  assert.match(template, /Type: AWS::Serverless::HttpApi/)
  assert.match(template, /Type: AWS::Serverless::Function/)
  assert.doesNotMatch(template, /WebSocketApi|WebSocketStage|WebSocketFunction|WebSocketAuthorizer|ws-ticket|chat/i)
  assert.match(template, /DeletionPolicy: Retain/)
  assert.match(template, /UpdateReplacePolicy: Retain/)
  assert.match(template, /VoterKeyParameterName:/)
  assert.doesNotMatch(template, /VoterKeySecret:|VOTER_KEY_SECRET: !Ref/)
})

test('SAM HTTP role scopes reads and limits item writes to transactions', async () => {
  const template = await read('../template.yaml')
  const role = template.split('  HttpExecutionRole:')[1]?.split('  HttpFunction:')[0]
  assert.ok(role, 'HttpExecutionRole must exist in the SAM template')
  assert.match(role, /Action: \[dynamodb:GetItem\]\s+Resource: !GetAtt BallotData\.Arn/)
  assert.match(role, /Action: \[dynamodb:Query\]\s+Resource: \[!GetAtt BallotData\.Arn, !Sub '\$\{BallotData\.Arn\}\/index\/GSI1'\]/)
  assert.match(role, /Action: \[dynamodb:ConditionCheckItem, dynamodb:PutItem, dynamodb:UpdateItem, dynamodb:DeleteItem\]/)
  assert.match(role, /Resource: !GetAtt BallotData\.Arn\s+Condition:\s+ForAnyValue:StringEquals:\s+dynamodb:EnclosingOperation: \[TransactWriteItems\]/)
  assert.doesNotMatch(role, /dynamodb:TransactWriteItems|execute-api:ManageConnections/)
  assert.match(role, /Action: \[ssm:GetParameter\]\s+Resource: !Sub 'arn:\$\{AWS::Partition\}:ssm:\$\{AWS::Region\}:\$\{AWS::AccountId\}:parameter\$\{VoterKeyParameterName\}'/)
  assert.match(role, /Action: \[kms:Decrypt\]\s+Resource: '\*'\s+Condition:\s+StringEquals:\s+kms:ViaService: !Sub 'ssm\.\$\{AWS::Region\}\.\$\{AWS::URLSuffix\}'\s+kms:EncryptionContext:PARAMETER_ARN: !Sub 'arn:/)
})

test('standalone HTTP policy matches the scoped template and has no WebSocket permissions', async () => {
  const policy = JSON.parse(await read('../policies/http-function-policy.json'))
  const itemRead = policy.Statement.find((statement) => statement.Sid === 'ReadPollDataItems')
  const query = policy.Statement.find((statement) => statement.Sid === 'QueryPollsAndDiscoveryIndex')
  const writes = policy.Statement.find((statement) => statement.Sid === 'TransactionalPollAndBallotWrites')
  assert.ok(itemRead)
  assert.equal(itemRead.Action, 'dynamodb:GetItem')
  assert.equal(itemRead.Resource, '<TABLE_ARN>')
  assert.ok(query)
  assert.equal(query.Action, 'dynamodb:Query')
  assert.deepEqual(sorted(query.Resource), sorted(['<TABLE_ARN>', '<TABLE_ARN>/index/GSI1']))
  assert.ok(writes)
  assert.deepEqual(sorted(writes.Action), sorted([
    'dynamodb:ConditionCheckItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
  ]))
  assert.equal(writes.Resource, '<TABLE_ARN>')
  assert.deepEqual(writes.Condition['ForAnyValue:StringEquals']['dynamodb:EnclosingOperation'], ['TransactWriteItems'])
  const ssmRead = policy.Statement.find((statement) => statement.Sid === 'ReadVoterKeySecureString')
  const decrypt = policy.Statement.find((statement) => statement.Sid === 'DecryptVoterKeyOnlyThroughParameterStore')
  assert.ok(ssmRead)
  assert.equal(ssmRead.Action, 'ssm:GetParameter')
  assert.equal(ssmRead.Resource, '<VOTER_KEY_PARAMETER_ARN>')
  assert.ok(decrypt)
  assert.equal(decrypt.Action, 'kms:Decrypt')
  assert.equal(decrypt.Resource, '*')
  assert.equal(decrypt.Condition.StringEquals['kms:ViaService'], 'ssm.<REGION>.amazonaws.com')
  assert.equal(decrypt.Condition.StringEquals['kms:EncryptionContext:PARAMETER_ARN'], '<VOTER_KEY_PARAMETER_ARN>')
  assert.doesNotMatch(JSON.stringify(policy), /ManageConnections|WebSocket/i)
})
