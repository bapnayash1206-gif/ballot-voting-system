import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createAccountService } from './accountService.js'

const initialPasswords = {
  samarth: 'Test-Samarth-Initial!123',
  vishwas: 'Test-Vishwas-Initial!123',
  sriram: 'Test-Sriram-Initial!123',
}

async function withAccounts(run, options = {}) {
  const projectRoot = resolve(process.cwd())
  const directory = await mkdtemp(join(projectRoot, '.test-accounts-'))
  const safePrefix = join(projectRoot, '.test-accounts-')
  const testPath = resolve(directory)
  if (!testPath.startsWith(safePrefix) || testPath.slice(safePrefix.length).includes(sep)) throw new Error('Refusing to clean an account test directory outside the project root.')
  try {
    const storageFile = join(directory, 'accounts.json')
    const service = createAccountService({ storageFile, ...options })
    await service.initialize(initialPasswords)
    await run({ service, storageFile })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('initializes exactly the three configured administrator accounts with forced password change', async () => {
  await withAccounts(async ({ service, storageFile }) => {
    for (const username of Object.keys(initialPasswords)) {
      const login = await service.login({ username, password: initialPasswords[username], accountType: 'admin' })
      assert.equal(login.user.role, 'admin')
      assert.equal(login.user.mustChangePassword, true)
      assert.equal(login.user.name, username[0].toUpperCase() + username.slice(1))
    }
    const saved = JSON.parse(await readFile(storageFile, 'utf8'))
    assert.equal(saved.accounts.length, 3)
    assert.ok(saved.accounts.every((account) => account.passwordHash.startsWith('scrypt$')))
    assert.ok(saved.accounts.every((account) => !Object.values(initialPasswords).includes(account.passwordHash)))
  })
})

test('fails clearly when an initial administrator password is missing', async () => {
  const service = createAccountService({ storageFile: null })
  const prior = process.env.INITIAL_ADMIN_SRIRAM_PASSWORD
  delete process.env.INITIAL_ADMIN_SRIRAM_PASSWORD
  try { await assert.rejects(service.initialize({ samarth: initialPasswords.samarth, vishwas: initialPasswords.vishwas }), /INITIAL_ADMIN_SRIRAM_PASSWORD/) }
  finally { if (prior !== undefined) process.env.INITIAL_ADMIN_SRIRAM_PASSWORD = prior }
})

test('voters register with username only and sign in with backend-assigned voter role', async () => {
  await withAccounts(async ({ service }) => {
    const user = await service.registerVoter({ username: 'Taylor.Student', password: 'VoterPass!234', confirmPassword: 'VoterPass!234', role: 'voter' })
    assert.equal(user.role, 'voter')
    assert.equal(user.name, 'taylor.student')
    assert.equal(user.username, 'taylor.student')
    const login = await service.login({ username: 'taylor.student', password: 'VoterPass!234', accountType: 'voter' })
    assert.equal(service.userForSession(login.token).id, user.id)
  })
})

test('public registration cannot create or escalate an administrator', async () => {
  await withAccounts(async ({ service }) => {
    await assert.rejects(service.registerVoter({ fullName: 'Admin User', username: 'newadmin', password: 'StrongPass!234', confirmPassword: 'StrongPass!234', role: 'admin' }), /only available for voter/)
    for (const username of ['samarth', 'vishwas', 'sriram']) {
      await assert.rejects(service.registerVoter({ username, password: 'StrongPass!234', confirmPassword: 'StrongPass!234' }), (error) => error.status === 409)
    }
    const user = await service.registerVoter({ fullName: 'Normal User', username: 'normaluser', password: 'StrongPass!234', confirmPassword: 'StrongPass!234', role: 'voter' })
    assert.equal(user.role, 'voter')
    assert.equal(Object.hasOwn(user, 'passwordHash'), false)
  })
})

test('duplicate usernames are rejected, including concurrent registrations', async () => {
  await withAccounts(async ({ service }) => {
    const input = { fullName: 'Unique User', username: 'uniqueuser', password: 'StrongPass!234', confirmPassword: 'StrongPass!234' }
    const outcomes = await Promise.allSettled([
      service.registerVoter(input),
      service.registerVoter({ ...input, username: 'UniqueUser' }),
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason.status === 409).length, 1)
  })
})

test('rejects incorrect passwords, wrong selected roles, and disabled accounts', async () => {
  await withAccounts(async ({ service, storageFile }) => {
    await assert.rejects(service.login({ username: 'samarth', password: 'wrong-password', accountType: 'admin' }), (error) => error.status === 401)
    await assert.rejects(service.login({ username: 'samarth', password: initialPasswords.samarth, accountType: 'voter' }), (error) => error.status === 403)
    const data = JSON.parse(await readFile(storageFile, 'utf8'))
    data.accounts[0].disabled = true
    await writeFile(storageFile, JSON.stringify(data))
    const disabled = createAccountService({ storageFile })
    await disabled.initialize(initialPasswords)
    await assert.rejects(disabled.login({ username: data.accounts[0].username, password: initialPasswords[data.accounts[0].username], accountType: 'admin' }), (error) => error.status === 401)
  })
})

test('admin first-login password change is required, persists, and is never overwritten on restart', async () => {
  await withAccounts(async ({ service, storageFile }) => {
    const login = await service.login({ username: 'samarth', password: initialPasswords.samarth, accountType: 'admin' })
    const user = await service.changePassword(login.user, { currentPassword: initialPasswords.samarth, newPassword: 'ChangedAdmin!456', confirmPassword: 'ChangedAdmin!456' })
    assert.equal(user.mustChangePassword, false)
    const savedBeforeRestart = JSON.parse(await readFile(storageFile, 'utf8'))
    const changedHash = savedBeforeRestart.accounts.find((account) => account.username === 'samarth').passwordHash
    const restarted = createAccountService({ storageFile })
    await restarted.initialize({ samarth: 'OtherInitial!789', vishwas: initialPasswords.vishwas, sriram: initialPasswords.sriram })
    const savedAfterRestart = JSON.parse(await readFile(storageFile, 'utf8'))
    assert.equal(savedAfterRestart.accounts.find((account) => account.username === 'samarth').passwordHash, changedHash)
    await assert.rejects(restarted.login({ username: 'samarth', password: initialPasswords.samarth, accountType: 'admin' }), (error) => error.status === 401)
    const changed = await restarted.login({ username: 'samarth', password: 'ChangedAdmin!456', accountType: 'admin' })
    assert.equal(changed.user.mustChangePassword, false)
    assert.equal((JSON.parse(await readFile(storageFile, 'utf8'))).accounts.length, 3)
    for (const username of ['vishwas', 'sriram']) {
      const unchanged = await restarted.login({ username, password: initialPasswords[username], accountType: 'admin' })
      assert.equal(unchanged.user.role, 'admin')
      assert.equal(unchanged.user.mustChangePassword, true)
    }
  })
})

test('local admin reset changes only the selected account, forces a change, and persists', async () => {
  await withAccounts(async ({ service, storageFile }) => {
    await service.resetAdminPassword('SAMARTH', 'ResetAdmin!4567')
    const restarted = createAccountService({ storageFile })
    await restarted.initialize(initialPasswords)
    const reset = await restarted.login({ username: 'samarth', password: 'ResetAdmin!4567', accountType: 'admin' })
    assert.equal(reset.user.mustChangePassword, true)
    await assert.rejects(restarted.login({ username: 'samarth', password: initialPasswords.samarth, accountType: 'admin' }), (error) => error.status === 401)
    for (const username of ['vishwas', 'sriram']) {
      assert.equal((await restarted.login({ username, password: initialPasswords[username], accountType: 'admin' })).user.role, 'admin')
    }
    assert.equal(JSON.parse(await readFile(storageFile, 'utf8')).accounts.length, 3)
    await assert.rejects(restarted.resetAdminPassword('somebody', 'ResetAdmin!4567'), (error) => error.status === 404)
  })
})

test('sessions expire and logout invalidates them', async () => {
  let clock = 1_000
  await withAccounts(async ({ service }) => {
    const login = await service.login({ username: 'sriram', password: initialPasswords.sriram, accountType: 'admin' })
    assert.ok(service.userForSession(login.token))
    service.logout(login.token)
    assert.equal(service.userForSession(login.token), null)
  }, { now: () => clock, sessionTtlMs: 1_000 })

  clock += 1_000
  await withAccounts(async ({ service }) => {
    const login = await service.login({ username: 'sriram', password: initialPasswords.sriram, accountType: 'admin' })
    clock += 1_001
    assert.equal(service.userForSession(login.token), null)
  }, { now: () => clock, sessionTtlMs: 1_000 })
})

test('rate-limits repeated failed sign-in attempts', async () => {
  await withAccounts(async ({ service }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(service.login({ username: 'samarth', password: 'wrong', accountType: 'admin' }), (error) => error.status === 401)
    }
    await assert.rejects(service.login({ username: 'samarth', password: initialPasswords.samarth, accountType: 'admin' }), (error) => error.status === 429)
  }, { rateLimitMax: 2 })
})
