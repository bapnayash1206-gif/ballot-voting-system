import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { promptLine, promptSecret } from './interactivePrompts.js'

test('visible prompt accepts and trims a line from readline input', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk) => { shown += chunk.toString() })
  const answer = promptLine('Existing Admin username: ', { input, output })
  input.end('  samarth  \r\n')
  assert.equal(await answer, 'samarth')
  assert.match(shown, /Existing Admin username:/)
})

test('password prompt refuses non-interactive input instead of accepting a visible password', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  await assert.rejects(promptSecret('Password: ', { input, output }), /local interactive terminal/)
  assert.equal(output.read(), null)
})
