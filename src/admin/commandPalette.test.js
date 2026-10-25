import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminCommands, filterAdminCommands } from './commandPalette.js'

test('admin command palette only exposes supported navigation and poll actions', () => {
  const commands = createAdminCommands({
    polls: [{ id: 'poll/1', question: 'Campus lunch', status: 'active' }],
    navigate: () => {}, scrollToSection: () => {}, openEditor: () => {}, sharePoll: () => {},
  })
  assert.deepEqual(commands.map(({ id }) => id), [
    'dashboard', 'polls', 'analytics', 'results', 'create-poll',
    'open-poll/1', 'results-poll/1', 'share-poll/1',
  ])
  assert.equal(commands.some(({ label }) => /delete|close|start/i.test(label)), false)
})

test('admin palette offers share only for polls published to voters', () => {
  const commands = createAdminCommands({
    polls: [{ id: 'draft', question: 'Draft', status: 'draft' }, { id: 'live', question: 'Live', status: 'active' }],
    navigate: () => {}, scrollToSection: () => {}, openEditor: () => {}, sharePoll: () => {},
  })
  assert.equal(commands.some(({ id }) => id === 'share-draft'), false)
  assert.equal(commands.some(({ id }) => id === 'share-live'), true)
})

test('admin command palette searches destinations and actual poll metadata', () => {
  const commands = createAdminCommands({
    polls: [{ id: 'abc-123', question: 'Campus lunch', status: 'active' }],
    navigate: () => {}, scrollToSection: () => {}, openEditor: () => {}, sharePoll: () => {},
  })
  assert.deepEqual(filterAdminCommands(commands, 'analytics').map(({ id }) => id), ['analytics'])
  assert.deepEqual(filterAdminCommands(commands, 'abc-123').map(({ hint }) => hint), ['Poll', 'Poll', 'Poll'])
  assert.equal(filterAdminCommands(commands, '   ').length, commands.length)
})
