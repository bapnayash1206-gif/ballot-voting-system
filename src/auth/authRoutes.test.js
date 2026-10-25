import test from 'node:test'
import assert from 'node:assert/strict'
import { accountAuthPage, accountAuthPath } from './authRoutes.js'

test('root and /signin are the Sign In route while /signup is separate', () => {
  assert.equal(accountAuthPage('/'), 'signin')
  assert.equal(accountAuthPage('/signin'), 'signin')
  assert.equal(accountAuthPage('/signup'), 'signup')
  assert.equal(accountAuthPage('/welcome'), 'signin')
  assert.equal(accountAuthPage('/change-password'), 'change-password')
  assert.equal(accountAuthPage('/admin'), null)
})

test('authentication navigation always resolves to canonical absolute routes', () => {
  assert.equal(accountAuthPath('/'), '/signin')
  assert.equal(accountAuthPath('welcome'), '/signin')
  assert.equal(accountAuthPath('signin'), '/signin')
  assert.equal(accountAuthPath('signup'), '/signup')
  assert.equal(accountAuthPath('/change-password'), '/change-password')
  assert.equal(accountAuthPath('unknown'), '/signin')
})
