import process from 'node:process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountService } from '../server/accountService.js'

const adminUsernames = new Set(['samarth', 'vishwas', 'sriram'])

async function hiddenPrompt(label) {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so passwords can be entered without echo.')
  }
  process.stdout.write(label)
  input.setEncoding('utf8')
  input.setRawMode(true)
  input.resume()
  return new Promise((resolvePrompt, rejectPrompt) => {
    let value = ''
    const cleanup = () => {
      input.removeListener('data', onData)
      input.setRawMode(false)
      process.stdout.write('\n')
    }
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup()
          rejectPrompt(new Error('Password reset cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          cleanup()
          resolvePrompt(value)
          return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else if (character >= ' ') value += character
      }
    }
    input.on('data', onData)
  })
}

async function run() {
  if (process.loadEnvFile) {
    try { process.loadEnvFile(resolve('.env')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const username = String(process.argv[2] || '').trim().toLowerCase()
  if (!adminUsernames.has(username)) throw new Error('Choose an administrator username: samarth, vishwas, or sriram.')

  const first = await hiddenPrompt('New password (10–128 characters): ')
  const second = await hiddenPrompt('Confirm new password: ')
  if (first !== second) throw new Error('Passwords do not match.')

  const accountService = createAccountService({ storageFile: process.env.ACCOUNTS_FILE || resolve('.local-data/accounts.json') })
  await accountService.initialize()
  const account = await accountService.resetAdminPassword(username, first)
  process.stdout.write(`Password reset for ${account.username}. It must be changed at the next sign-in.\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
