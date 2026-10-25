import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createBackupService, validateBackupFile } from './backupService.js'
import { createVotingService } from './votingService.js'

const passphrase = 'local backup passphrase with length'

function makeVotingState() {
  let timestamp = 1_800_000_000_000
  const service = createVotingService({ now: () => timestamp++ })
  const single = service.createPoll({ question: 'Which event?', options: ['Fest', 'Sports'], votingType: 'single', votingMode: 'public' })
  service.startPoll(single.id)
  service.submitVote(single.id, 'voter-secret-001', { optionId: single.options[0].id })
  const multiple = service.createPoll({ question: 'Which clubs?', options: ['Robotics', 'Arts', 'Sports'], votingType: 'multiple', votingMode: 'anonymous' })
  service.startPoll(multiple.id)
  service.submitVote(multiple.id, 'voter-secret-002', { optionIds: [multiple.options[0].id, multiple.options[2].id] })
  const ranked = service.createPoll({ question: 'Rank events?', options: ['Tech', 'Culture', 'Sports'], votingType: 'ranked' })
  service.startPoll(ranked.id)
  service.submitVote(ranked.id, 'voter-secret-003', { rankedOptionIds: [ranked.options[1].id, ranked.options[0].id] })
  service.submitVote(ranked.id, 'voter-secret-004', { rankedOptionIds: [ranked.options[0].id] })
  return service
}

test('snapshot exports definitions, aggregate counts, and all ballot forms without mutating state', () => {
  const service = makeVotingState()
  const before = service.exportSnapshot()
  const snapshot = service.exportSnapshot()
  snapshot.exportedAt = before.exportedAt
  assert.deepEqual(snapshot, before)
  assert.equal(snapshot.pollCount, 3)
  assert.equal(snapshot.ballotCount, 4)
  const single = snapshot.polls.find((poll) => poll.votingType === 'single')
  assert.equal(single.question, 'Which event?')
  assert.deepEqual(single.optionCounts.map((item) => item.count), [1, 0])
  assert.equal(single.ballots[0].voterId, 'voter-secret-001')
  assert.equal(single.ballots[0].voteData.optionIds[0], single.options[0].id)
  const ranked = snapshot.polls.find((poll) => poll.votingType === 'ranked')
  assert.equal(ranked.ballots.length, 2)
  assert.equal(ranked.rankedResults.method, 'instant_runoff')
  const after = service.exportSnapshot()
  after.exportedAt = before.exportedAt
  assert.deepEqual(after, before)
})

test('encrypted backup is complete, identity-protecting at rest, and uses unique filenames', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-backup-test-'))
  try {
    const service = createBackupService({ directory, now: () => 1_800_000_000_000, id: (() => { let n = 0; return () => `id-${++n}` })() })
    const snapshot = makeVotingState().exportSnapshot()
    const first = await service.writeBackup(snapshot, passphrase)
    const second = await service.writeBackup(snapshot, passphrase)
    assert.notEqual(first.filename, second.filename)
    assert.match(first.filename, /^ballot-backup-\d{4}-\d\d-\d\dT.*-id-1\.json$/)
    assert.equal(first.pollCount, 3)
    assert.equal(first.ballotCount, 4)
    const bytes = await readFile(join(directory, first.filename), 'utf8')
    assert.doesNotMatch(bytes, /voter-secret|Which event\?|local backup passphrase/)
    const summary = await validateBackupFile(join(directory, first.filename), passphrase)
    assert.equal(summary.pollCount, 3)
    assert.equal(summary.ballotCount, 4)
    assert.equal(summary.sha256, first.sha256)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('backup validation rejects wrong passphrases and tampered ciphertext', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-backup-test-'))
  try {
    const service = createBackupService({ directory })
    const result = await service.writeBackup(makeVotingState().exportSnapshot(), passphrase)
    const path = join(directory, result.filename)
    await assert.rejects(validateBackupFile(path, 'not the correct passphrase'), /invalid, incomplete, or has been modified/)
    const envelope = JSON.parse(await readFile(path, 'utf8'))
    const data = envelope.cipher.ciphertext
    envelope.cipher.ciphertext = (data.startsWith('A') ? 'B' : 'A') + data.slice(1)
    const tamperedPath = join(directory, 'tampered.json')
    await writeFile(tamperedPath, JSON.stringify(envelope), { flag: 'wx' })
    await assert.rejects(validateBackupFile(tamperedPath, passphrase), /invalid, incomplete, or has been modified/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('filename collisions never overwrite an existing backup', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.ballot-backup-test-'))
  try {
    const names = ['repeat', 'repeat', 'fresh']
    const service = createBackupService({ directory, now: () => 1_800_000_000_000, id: () => names.shift() })
    const snapshot = makeVotingState().exportSnapshot()
    const first = await service.writeBackup(snapshot, passphrase)
    const original = await readFile(join(directory, first.filename), 'utf8')
    const second = await service.writeBackup(snapshot, passphrase)
    assert.notEqual(second.filename, first.filename)
    assert.equal(await readFile(join(directory, first.filename), 'utf8'), original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
