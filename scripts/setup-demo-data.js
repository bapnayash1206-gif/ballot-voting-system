import { mkdir, open, readFile, writeFile, chmod } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promptLine, promptSecret } from './interactivePrompts.js'
import process from 'node:process'
import { DEMO_BALLOT_PLANS, DEMO_POLLS, DEMO_VOTERS, formatCredentialEntries, generateTemporaryPassword, parseCredentialReport } from './demoData.js'

const origin = process.env.BALLOT_API_ORIGIN || 'http://127.0.0.1:8787'
const stateFile = resolve('.local-data/demo-setup-state.json')
const credentialFile = resolve('.local-data/demo-credentials.txt')

async function request(path, { method = 'GET', body, cookie } = {}) {
  let response
  try {
    response = await fetch(new URL(path, origin), {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (error) {
    throw new Error(`Cannot reach local backend at ${origin}. Start it with npm.cmd run dev:backend, then rerun this setup.`, { cause: error })
  }
  let payload
  try { payload = await response.json() } catch { payload = {} }
  if (!response.ok) {
    const error = new Error(payload.error || `Local API request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return { payload, response }
}

function selectedPollMatches(poll, definition) {
  return poll?.question === definition.question
    && poll.votingType === definition.votingType
    && Array.isArray(poll.options)
    && poll.options.length === definition.options.length
    && poll.options.every((option, index) => option.label === definition.options[index])
}

async function saveState(state) {
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
}

async function ensureCredentialReport() {
  await mkdir(dirname(credentialFile), { recursive: true })
  const handle = await open(credentialFile, 'a', 0o600)
  await handle.close()
  await chmod(credentialFile, 0o600).catch(() => {})
}

async function main() {
  await request('/health')
  const adminUsername = (await promptLine('Existing Admin username (samarth, vishwas, or sriram): ')).toLowerCase()
  if (!['samarth', 'vishwas', 'sriram'].includes(adminUsername)) throw new Error('Use one of the three existing Admin usernames.')
  const adminPassword = await promptSecret('Existing Admin password (input hidden): ')
  const { payload: loginPayload, response: loginResponse } = await request('/api/auth/login', {
    method: 'POST', body: { username: adminUsername, password: adminPassword, accountType: 'admin' },
  })
  const admin = loginPayload.user
  if (admin?.mustChangePassword) throw new Error('This Admin account still requires its normal password-change flow. Complete that flow in the application before running demo setup.')
  const adminCookie = loginResponse.headers.get('set-cookie')?.split(';')[0]
  if (!adminCookie) throw new Error('The backend did not issue an Admin session cookie; no demo data was changed.')

  const credentialText = await readFile(credentialFile, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error))
  const knownCredentials = parseCredentialReport(credentialText)
  const accounts = new Map()
  const createdCredentials = []
  const existingAccountsWithoutKnownPassword = []
  await ensureCredentialReport()
  for (const username of DEMO_VOTERS) {
    const password = generateTemporaryPassword()
    let registered = false
    try {
      await request('/api/auth/register', { method: 'POST', body: { username, password, confirmPassword: password } })
      registered = true
    } catch (error) {
      if (error.status !== 409) throw error
      const known = knownCredentials.get(username)
      if (known) accounts.set(username, known)
      else existingAccountsWithoutKnownPassword.push(username)
    }
    if (registered) {
      const handle = await open(credentialFile, 'a', 0o600)
      try { await handle.writeFile(formatCredentialEntries([{ username, password }]), 'utf8') }
      finally { await handle.close() }
      await chmod(credentialFile, 0o600).catch(() => {})
      accounts.set(username, password)
      createdCredentials.push({ username, password })
    }
  }

  const state = await readFile(stateFile, 'utf8').then(JSON.parse).catch((error) => error.code === 'ENOENT' ? { version: 1, pollIds: {} } : Promise.reject(error))
  if (state.version !== 1 || typeof state.pollIds !== 'object' || !state.pollIds) throw new Error('Demo setup state file is invalid; preserve it and inspect before retrying.')
  const { payload: listPayload } = await request('/api/polls', { cookie: adminCookie })
  const polls = listPayload.polls || []
  const selectedPolls = new Map()
  const createdPollKeys = []
  for (const definition of DEMO_POLLS) {
    let poll = polls.find((candidate) => candidate.id === state.pollIds[definition.key] && selectedPollMatches(candidate, definition))
    if (!poll) {
      const { payload } = await request('/api/polls', {
        method: 'POST', cookie: adminCookie,
        body: {
          question: definition.question,
          options: definition.options,
          votingType: definition.votingType,
          votingMode: 'public',
          durationMinutes: 10080,
          resultVisibility: 'live',
          chatEnabled: false,
        },
      })
      poll = payload.poll
      createdPollKeys.push(definition.key)
      polls.push(poll)
      state.pollIds[definition.key] = poll.id
      await saveState(state)
    }
    selectedPolls.set(definition.key, poll)
  }

  const eligible = new Map()
  for (const [username, password] of accounts) {
    try {
      const { payload, response } = await request('/api/auth/login', {
        method: 'POST', body: { username, password, accountType: 'voter' },
      })
      const cookie = response.headers.get('set-cookie')?.split(';')[0]
      if (payload.user?.role !== 'voter' || !cookie) throw new Error('Backend did not confirm a Voter role and session.')
      eligible.set(username, { password, cookie })
    } catch {
      existingAccountsWithoutKnownPassword.push(username)
    }
  }

  const accepted = []
  const alreadyVoted = []
  const skipped = []
  for (const definition of DEMO_POLLS) {
    const poll = selectedPolls.get(definition.key)
    const plan = DEMO_BALLOT_PLANS[definition.key]
    const desiredStatus = definition.desiredStatus
    if (poll.status === 'draft') {
      const { payload } = await request(`/api/polls/${encodeURIComponent(poll.id)}/start`, { method: 'POST', cookie: adminCookie })
      Object.assign(poll, payload.poll)
    } else if (desiredStatus === 'active' && ['closed', 'expired'].includes(poll.status)) {
      const { payload } = await request(`/api/polls/${encodeURIComponent(poll.id)}/reopen`, { method: 'POST', cookie: adminCookie })
      Object.assign(poll, payload.poll)
    } else if (desiredStatus === 'closed' && ['closed', 'expired'].includes(poll.status)) {
      const { payload } = await request(`/api/polls/${encodeURIComponent(poll.id)}/reopen`, { method: 'POST', cookie: adminCookie })
      Object.assign(poll, payload.poll)
    }
    for (const [voterIndex, optionIndexes] of plan) {
      const username = DEMO_VOTERS[voterIndex]
      const voter = eligible.get(username)
      if (!voter) { skipped.push(`${username} / ${definition.key}: account password unavailable`); continue }
      try {
        const { payload: receipt } = await request(`/api/polls/${encodeURIComponent(poll.id)}/votes`, { method: 'GET', cookie: voter.cookie })
        if (receipt.hasVoted) { alreadyVoted.push(`${username} / ${definition.key}`); continue }
        let ballot
        if (definition.votingType === 'single') ballot = { optionId: poll.options[optionIndexes[0]].id }
        else if (definition.votingType === 'multiple') ballot = { optionIds: optionIndexes.map((index) => poll.options[index].id) }
        else ballot = { rankedOptionIds: optionIndexes.map((index) => poll.options[index].id) }
        await request(`/api/polls/${encodeURIComponent(poll.id)}/votes`, { method: 'POST', cookie: voter.cookie, body: ballot })
        accepted.push(`${username} / ${definition.key}`)
      } catch (error) { skipped.push(`${username} / ${definition.key}: ${error.message}`) }
    }
    if (desiredStatus === 'closed' && poll.status === 'active') {
      const { payload } = await request(`/api/polls/${encodeURIComponent(poll.id)}/close`, { method: 'POST', cookie: adminCookie })
      Object.assign(poll, payload.poll)
    }
  }

  process.stdout.write(`Demo setup complete. Accounts created: ${createdCredentials.length}; existing accounts preserved: ${DEMO_VOTERS.length - createdCredentials.length}. Polls created: ${createdPollKeys.length}; ballots accepted now: ${accepted.length}; ballots already present: ${alreadyVoted.length}; votes skipped: ${skipped.length}.\n`)
  process.stdout.write(`Credentials report (new accounts only): ${credentialFile}\n`)
  process.stdout.write(`Poll states: 2 active; 1 closed. Poll data and ballots are held in backend memory and disappear if that backend process restarts. Account records and the credentials report persist locally.\n`)
  if (existingAccountsWithoutKnownPassword.length) process.stdout.write(`Existing demo accounts that could not be authenticated were preserved; their planned ballots were skipped: ${[...new Set(existingAccountsWithoutKnownPassword)].join(', ')}\n`)
  if (skipped.length) process.stdout.write(`Some planned ballots were skipped: ${skipped.join('; ')}\n`)
}

main().catch((error) => {
  process.stderr.write(`Demo setup stopped: ${error.message}\n`)
  process.exitCode = 1
})
