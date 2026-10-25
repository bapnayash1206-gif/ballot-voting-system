import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePasswordChange, validateRegistration, validateSignIn } from './authValidation.js'

test('sign-in validation requires username, password, and an explicit role', () => {
  assert.equal(validateSignIn({ username: '', password: 'password', accountType: 'voter' }), 'Enter your username.')
  assert.equal(validateSignIn({ username: 'name', password: '', accountType: 'voter' }), 'Enter your password.')
  assert.equal(validateSignIn({ username: 'name', password: 'password', accountType: 'owner' }), 'Choose Admin or Voter account type.')
  assert.equal(validateSignIn({ username: 'name', password: 'password', accountType: 'admin' }), '')
})

test('voter registration requires only username, password, and confirmation', () => {
  assert.equal(validateRegistration({ username: '', password: 'StrongPass!234', confirmPassword: 'StrongPass!234' }), 'Choose a username.')
  assert.equal(validateRegistration({ username: 'user', password: 'short', confirmPassword: 'short' }), 'Password must be between 10 and 128 characters.')
  assert.equal(validateRegistration({ username: 'user', password: 'StrongPass!234', confirmPassword: 'Different!456' }), 'Passwords do not match.')
  assert.equal(validateRegistration({ username: 'user', password: 'StrongPass!234', confirmPassword: 'StrongPass!234' }), '')
})

test('forced password change validates current password and new password confirmation', () => {
  assert.equal(validatePasswordChange({ currentPassword: '', newPassword: 'NewPass!4567', confirmPassword: 'NewPass!4567' }), 'Enter your current password.')
  assert.equal(validatePasswordChange({ currentPassword: 'OldPass!4567', newPassword: 'short', confirmPassword: 'short' }), 'New password must be between 10 and 128 characters.')
  assert.equal(validatePasswordChange({ currentPassword: 'OldPass!4567', newPassword: 'NewPass!4567', confirmPassword: 'OtherPass!789' }), 'Passwords do not match.')
  assert.equal(validatePasswordChange({ currentPassword: 'SamePass!4567', newPassword: 'SamePass!4567', confirmPassword: 'SamePass!4567' }), 'Choose a password different from your current password.')
  assert.equal(validatePasswordChange({ currentPassword: 'OldPass!4567', newPassword: 'NewPass!4567', confirmPassword: 'NewPass!4567' }), '')
})
