import process from 'node:process'
import { resolve } from 'node:path'
import { promptLine, promptSecret } from './interactivePrompts.js'
import { validateBackupFile } from '../server/backupService.js'

async function main() {
  const filePath = process.argv[2] ? resolve(process.argv[2]) : resolve(await promptLine('Encrypted Ballot backup file path: '))
  const passphrase = await promptSecret('Backup passphrase (input hidden): ')
  const summary = await validateBackupFile(filePath, passphrase)
  console.log('Encrypted backup integrity and contents verified.')
  console.log(`Polls: ${summary.pollCount}`)
  console.log(`Ballot records: ${summary.ballotCount}`)
  console.log(`Exported at: ${summary.exportedAt}`)
  console.log(`SHA-256: ${summary.sha256}`)
}

main().catch((error) => {
  console.error(error.message || 'Backup validation failed.')
  process.exitCode = 1
})
