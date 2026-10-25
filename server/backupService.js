import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify, isDeepStrictEqual } from 'node:util'
import { calculateIrvResults } from '../aws/src/shared/irv.js'

const scrypt = promisify(scryptCallback)
const FORMAT = 'ballot-encrypted-backup'
const VERSION = 1
const KDF = Object.freeze({ name: 'scrypt', N: 32_768, r: 8, p: 1, keyLength: 32 })
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`, 'utf8')
const MIN_PASSPHRASE_LENGTH = 16

function invalidBackup() { throw new Error('Backup is invalid, incomplete, or has been modified.') }

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH || Buffer.byteLength(passphrase, 'utf8') > 1024) {
    throw new Error(`Backup passphrase must contain at least ${MIN_PASSPHRASE_LENGTH} characters and at most 1024 UTF-8 bytes.`)
  }
}

function countsForPoll(poll) {
  if (!poll || typeof poll.id !== 'string' || typeof poll.question !== 'string' || !poll.question.trim()
    || !Array.isArray(poll.options) || poll.options.length < 2 || !['draft', 'active', 'closed', 'expired'].includes(poll.status)
    || !['single', 'multiple', 'ranked'].includes(poll.votingType) || !['public', 'anonymous'].includes(poll.votingMode)
    || !['live', 'afterVote', 'afterClose'].includes(poll.resultVisibility) || !Array.isArray(poll.ballots)
    || !Number.isInteger(poll.durationMinutes) || poll.durationMinutes < 1 || !Number.isFinite(poll.createdAt)
    || !(poll.startedAt === null || Number.isFinite(poll.startedAt)) || !(poll.endsAt === null || Number.isFinite(poll.endsAt))
    || typeof poll.chatEnabled !== 'boolean' || !Number.isInteger(poll.ballotCount) || poll.ballotCount !== poll.ballots.length) invalidBackup()
  if (poll.options.some((option) => typeof option?.label !== 'string' || !option.label.trim())) invalidBackup()
  const optionIds = poll.options.map((option) => option?.id)
  if (optionIds.some((id) => typeof id !== 'string' || !id) || new Set(optionIds).size !== optionIds.length) invalidBackup()
  const valid = new Set(optionIds)
  const voters = new Set()
  const counts = new Map(optionIds.map((id) => [id, 0]))
  for (const ballot of poll.ballots) {
    if (typeof ballot?.voterId !== 'string' || !ballot.voterId || voters.has(ballot.voterId) || !Number.isFinite(ballot.submittedAt)) invalidBackup()
    voters.add(ballot.voterId)
    if (poll.votingType === 'ranked') {
      const ranking = ballot.voteData?.rankedOptionIds
      if (!Array.isArray(ranking) || !ranking.length || ranking.some((id) => !valid.has(id)) || new Set(ranking).size !== ranking.length) invalidBackup()
      counts.set(ranking[0], counts.get(ranking[0]) + 1)
    } else {
      const ids = ballot.voteData?.optionIds
      if (!Array.isArray(ids) || !ids.length || ids.some((id) => !valid.has(id)) || new Set(ids).size !== ids.length
        || (poll.votingType === 'single' && ids.length !== 1)) invalidBackup()
      for (const id of ids) counts.set(id, counts.get(id) + 1)
    }
  }
  if (poll.votingType !== 'ranked') {
    if (!Array.isArray(poll.optionCounts) || poll.optionCounts.length !== poll.options.length) invalidBackup()
    for (let index = 0; index < poll.options.length; index += 1) {
      if (poll.optionCounts[index]?.optionId !== optionIds[index] || poll.optionCounts[index]?.count !== counts.get(optionIds[index]) || !Number.isInteger(poll.optionCounts[index]?.count)) invalidBackup()
    }
  } else if (!isDeepStrictEqual(poll.rankedResults, calculateIrvResults(poll.options, poll.ballots.map((ballot) => ballot.voteData)))) invalidBackup()
  return poll.ballots.length
}

export function validateBackupSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== VERSION || typeof snapshot.exportedAt !== 'number' || !Array.isArray(snapshot.polls)) invalidBackup()
  const ids = new Set()
  let ballotCount = 0
  for (const poll of snapshot.polls) {
    if (ids.has(poll?.id)) invalidBackup()
    ids.add(poll.id)
    ballotCount += countsForPoll(poll)
  }
  if (snapshot.pollCount !== snapshot.polls.length || snapshot.ballotCount !== ballotCount) invalidBackup()
  return { pollCount: snapshot.polls.length, ballotCount }
}

export async function encryptBackupSnapshot(snapshot, passphrase) {
  checkPassphrase(passphrase)
  validateBackupSnapshot(snapshot)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const passphraseBytes = Buffer.from(passphrase, 'utf8')
  let key
  try {
    key = await scrypt(passphraseBytes, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 })
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(AAD)
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8')
    if (plaintext.length > 100 * 1024 * 1024) { plaintext.fill(0); throw new Error('Backup exceeds the 100 MiB validation limit.') }
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    plaintext.fill(0)
    return {
      format: FORMAT,
      version: VERSION,
      kdf: { ...KDF, salt: salt.toString('base64url') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') },
    }
  } finally {
    passphraseBytes.fill(0)
    key?.fill(0)
  }
}

async function decryptEnvelope(envelope, passphrase) {
  checkPassphrase(passphrase)
  if (envelope?.format !== FORMAT || envelope.version !== VERSION || envelope.kdf?.name !== 'scrypt'
    || envelope.kdf.N !== KDF.N || envelope.kdf.r !== KDF.r || envelope.kdf.p !== KDF.p || envelope.kdf.keyLength !== KDF.keyLength
    || envelope.cipher?.name !== 'aes-256-gcm') invalidBackup()
  let salt, iv, tag, ciphertext
  try {
    salt = Buffer.from(envelope.kdf.salt, 'base64url')
    iv = Buffer.from(envelope.cipher.iv, 'base64url')
    tag = Buffer.from(envelope.cipher.tag, 'base64url')
    ciphertext = Buffer.from(envelope.cipher.ciphertext, 'base64url')
  } catch { invalidBackup() }
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !ciphertext.length || ciphertext.length > 100 * 1024 * 1024) invalidBackup()
  const passphraseBytes = Buffer.from(passphrase, 'utf8')
  let key
  let plaintext
  try {
    key = await scrypt(passphraseBytes, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 })
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const snapshot = JSON.parse(plaintext.toString('utf8'))
    const counts = validateBackupSnapshot(snapshot)
    return { snapshot, counts }
  } catch { invalidBackup() }
  finally {
    passphraseBytes.fill(0)
    key?.fill(0)
    plaintext?.fill(0)
  }
}

export async function validateBackupFile(filePath, passphrase) {
  const fileInfo = await stat(filePath)
  if (fileInfo.size > 140 * 1024 * 1024) invalidBackup()
  const bytes = await readFile(filePath)
  let envelope
  try { envelope = JSON.parse(bytes.toString('utf8')) } catch { invalidBackup() }
  const { snapshot, counts } = await decryptEnvelope(envelope, passphrase)
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date(snapshot.exportedAt).toISOString(),
    pollCount: counts.pollCount,
    ballotCount: counts.ballotCount,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export function createBackupService({ directory = resolve('.local-data/backups'), now = () => Date.now(), id = randomUUID } = {}) {
  async function writeBackup(snapshot, passphrase) {
    const envelope = await encryptBackupSnapshot(snapshot, passphrase)
    const bytes = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
    const exportedAt = new Date(now()).toISOString()
    const timestamp = exportedAt.replace(/[:.]/g, '-')
    await mkdir(directory, { recursive: true })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const filename = `ballot-backup-${timestamp}-${id()}.json`
      const filePath = join(directory, filename)
      let handle
      let created = false
      try {
        handle = await open(filePath, 'wx', 0o600)
        created = true
        await handle.writeFile(bytes)
        await handle.sync()
        await handle.close()
        handle = null
        return {
          filename,
          pollCount: snapshot.pollCount,
          ballotCount: snapshot.ballotCount,
          createdAt: exportedAt,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }
      } catch (error) {
        await handle?.close().catch(() => {})
        if (error.code === 'EEXIST') continue
        if (created) await rm(filePath, { force: true }).catch(() => {})
        throw new Error('Could not write the encrypted backup file.', { cause: error })
      }
    }
    throw new Error('Could not allocate a unique encrypted backup filename.')
  }
  return { writeBackup }
}
