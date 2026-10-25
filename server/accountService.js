import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const HASH_N = 16_384
const HASH_R = 8
const HASH_P = 1
const HASH_BYTES = 64
const SESSION_COOKIE = 'ballot_session'
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/
const ADMIN_ACCOUNTS = [
  { username: 'samarth', displayName: 'Samarth', envKey: 'INITIAL_ADMIN_SAMARTH_PASSWORD' },
  { username: 'vishwas', displayName: 'Vishwas', envKey: 'INITIAL_ADMIN_VISHWAS_PASSWORD' },
  { username: 'sriram', displayName: 'Sriram', envKey: 'INITIAL_ADMIN_SRIRAM_PASSWORD' },
]

export class AccountError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const fail = (status, message) => { throw new AccountError(status, message) }
const normalizeUsername = (value) => typeof value === 'string' ? value.trim().toLowerCase() : ''
const publicAccount = (account) => ({
  id: account.id,
  sub: account.id,
  username: account.username,
  name: account.displayName,
  role: account.role,
  mustChangePassword: Boolean(account.mustChangePassword),
})

async function hashPassword(password) {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, HASH_BYTES, { N: HASH_N, r: HASH_R, p: HASH_P, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${HASH_N}$${HASH_R}$${HASH_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, saltText, keyText] = String(encoded || '').split('$')
  if (algorithm !== 'scrypt') return false
  try {
    const expected = Buffer.from(keyText, 'base64url')
    const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    fail(400, 'Password must be between 10 and 128 characters.')
  }
}

export function createAccountService({
  storageFile = resolve('.local-data/accounts.json'),
  now = () => Date.now(),
  sessionTtlMs = 8 * 60 * 60 * 1000,
  rateLimitMax = 8,
  rateLimitWindowMs = 15 * 60 * 1000,
} = {}) {
  const accounts = new Map()
  const sessions = new Map()
  const loginAttempts = new Map()
  let writeQueue = Promise.resolve()
  let initialized = false

  function persist() {
    if (!storageFile) return Promise.resolve()
    const snapshot = JSON.stringify({ version: 1, accounts: [...accounts.values()] }, null, 2)
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(storageFile), { recursive: true })
      const temporary = `${storageFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        try {
          await rename(temporary, storageFile)
        } catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error
          const backup = `${storageFile}.${process.pid}.${randomBytes(6).toString('hex')}.bak`
          let movedExisting = false
          try {
            await rename(storageFile, backup)
            movedExisting = true
            await rename(temporary, storageFile)
            await import('node:fs/promises').then(({ rm }) => rm(backup, { force: true }))
          } catch (replaceError) {
            if (movedExisting) await rename(backup, storageFile).catch(() => {})
            throw replaceError
          }
        }
      } catch (error) {
        await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true })).catch(() => {})
        throw error
      }
    })
    return writeQueue
  }

  async function initialize(adminPasswords = {}) {
    if (initialized) return
    let saved = []
    if (storageFile) {
      try {
        const data = JSON.parse(await readFile(storageFile, 'utf8'))
        if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Unsupported account data format')
        saved = data.accounts
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Could not read local account store: ${error.message}`, { cause: error })
      }
    }
    for (const account of saved) {
      if (!account?.username || !account.passwordHash || !['admin', 'voter'].includes(account.role)) {
        throw new Error('The local account store contains an invalid account record.')
      }
      if (account.role === 'admin' && !ADMIN_ACCOUNTS.some((admin) => admin.username === normalizeUsername(account.username))) {
        throw new Error('The local account store contains an administrator outside the three configured local accounts.')
      }
      accounts.set(normalizeUsername(account.username), account)
    }
    for (const admin of ADMIN_ACCOUNTS) {
      const key = normalizeUsername(admin.username)
      const current = accounts.get(key)
      if (current) {
        if (current.role !== 'admin') throw new Error(`The reserved administrator account ${key} has an invalid role.`)
        continue
      }
      const password = adminPasswords[admin.username] ?? process.env[admin.envKey]
      if (typeof password !== 'string' || !password.trim()) {
        throw new Error(`Missing ${admin.envKey}. Set the initial local administrator password in .env before starting the backend.`)
      }
      validatePassword(password)
      accounts.set(key, {
        id: `local-admin-${key}`, username: key, displayName: admin.displayName, role: 'admin',
        passwordHash: await hashPassword(password), mustChangePassword: true, disabled: false,
        createdAt: now(), updatedAt: now(),
      })
    }
    initialized = true
    await persist()
  }

  function ensureInitialized() {
    if (!initialized) throw new Error('Account service has not been initialized.')
  }

  function userForSession(token) {
    ensureInitialized()
    if (!token) return null
    const key = createHash('sha256').update(token).digest('hex')
    const session = sessions.get(key)
    if (!session) return null
    if (session.expiresAt <= now()) {
      sessions.delete(key)
      return null
    }
    const account = accounts.get(session.username)
    if (!account || account.disabled) {
      sessions.delete(key)
      return null
    }
    return publicAccount(account)
  }

  function newSession(account) {
    const token = randomBytes(32).toString('base64url')
    const key = createHash('sha256').update(token).digest('hex')
    sessions.set(key, { username: account.username, expiresAt: now() + sessionTtlMs })
    return { token, expiresAt: now() + sessionTtlMs, user: publicAccount(account) }
  }

  function getAccount(user) {
    ensureInitialized()
    if (!user?.username) fail(401, 'Sign in is required.')
    const account = accounts.get(normalizeUsername(user.username))
    if (!account || account.disabled) fail(401, 'Sign in is required.')
    return account
  }

  async function registerVoter(input = {}) {
    ensureInitialized()
    if (input.role !== undefined && input.role !== 'voter') fail(400, 'Public registration is only available for voter accounts.')
    const username = normalizeUsername(input.username)
    if (!USERNAME_PATTERN.test(username)) fail(400, 'Username must be 3–32 characters and use letters, numbers, dots, underscores, or hyphens.')
    const suppliedName = typeof input.fullName === 'string' ? input.fullName.trim() : ''
    if (suppliedName && (suppliedName.length < 2 || suppliedName.length > 80)) fail(400, 'Enter a full name between 2 and 80 characters.')
    const displayName = suppliedName || username
    if (accounts.has(username)) fail(409, 'That username is already registered.')
    validatePassword(input.password)
    if (input.password !== input.confirmPassword) fail(400, 'Passwords do not match.')
    const account = {
      id: `local-voter-${randomBytes(16).toString('hex')}`, username, displayName, role: 'voter',
      passwordHash: await hashPassword(input.password), mustChangePassword: false, disabled: false,
      createdAt: now(), updatedAt: now(),
    }
    // No await between uniqueness check and insertion: requests are serialized within this Node process.
    if (accounts.has(username)) fail(409, 'That username is already registered.')
    accounts.set(username, account)
    await persist()
    return publicAccount(account)
  }

  async function login({ username: rawUsername, password, accountType, rateKey = '' } = {}) {
    ensureInitialized()
    const username = normalizeUsername(rawUsername)
    const key = `${String(rateKey).slice(0, 128)}:${username}`
    const attempt = loginAttempts.get(key) || { count: 0, startedAt: now() }
    if (now() - attempt.startedAt >= rateLimitWindowMs) { attempt.count = 0; attempt.startedAt = now() }
    if (attempt.count >= rateLimitMax) fail(429, 'Too many sign-in attempts. Wait a while and try again.')
    const account = accounts.get(username)
    const valid = account && typeof password === 'string' && await verifyPassword(password, account.passwordHash)
    if (!valid || account.disabled) {
      attempt.count += 1
      loginAttempts.set(key, attempt)
      fail(401, 'Username or password is incorrect.')
    }
    if (!['admin', 'voter'].includes(accountType) || account.role !== accountType) {
      fail(403, 'This account is not authorized for the selected account type.')
    }
    loginAttempts.delete(key)
    return newSession(account)
  }

  function logout(token) {
    if (token) sessions.delete(createHash('sha256').update(token).digest('hex'))
  }

  async function changePassword(user, { currentPassword, newPassword, confirmPassword } = {}) {
    const account = getAccount(user)
    if (typeof currentPassword !== 'string' || !await verifyPassword(currentPassword, account.passwordHash)) {
      fail(401, 'Current password is incorrect.')
    }
    validatePassword(newPassword)
    if (newPassword !== confirmPassword) fail(400, 'Passwords do not match.')
    if (newPassword === currentPassword) fail(400, 'Choose a password different from your current password.')
    account.passwordHash = await hashPassword(newPassword)
    account.mustChangePassword = false
    account.updatedAt = now()
    await persist()
    return publicAccount(account)
  }

  async function resetAdminPassword(username, newPassword) {
    ensureInitialized()
    const key = normalizeUsername(username)
    if (!ADMIN_ACCOUNTS.some((admin) => admin.username === key)) fail(404, 'Only one of the three predefined local administrator accounts can be reset.')
    const account = accounts.get(key)
    if (!account || account.role !== 'admin') fail(404, 'Administrator account not found.')
    validatePassword(newPassword)
    account.passwordHash = await hashPassword(newPassword)
    account.mustChangePassword = true
    account.updatedAt = now()
    for (const [sessionKey, session] of sessions) {
      if (session.username === key) sessions.delete(sessionKey)
    }
    await persist()
    return publicAccount(account)
  }

  return { initialize, registerVoter, login, userForSession, logout, changePassword, resetAdminPassword }
}

export const accountAuth = {
  cookieName: SESSION_COOKIE,
  cookie(token, { secure = false, maxAge = 8 * 60 * 60 } = {}) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  },
  clearCookie({ secure = false } = {}) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
  },
  readCookie(header = '') {
    for (const part of header.split(';')) {
      const [name, ...value] = part.trim().split('=')
      if (name === SESSION_COOKIE) return value.join('=') || ''
    }
    return ''
  },
}
