import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import { resolve } from 'node:path'

test('Sign In and Sign Up render as separate pages with their required fields', async (context) => {
  const vite = await createServer({
    configFile: resolve('vite.config.js'),
    server: { middlewareMode: true },
    appType: 'custom',
  })
  context.after(() => vite.close())
  const { default: AccountAuthPage } = await vite.ssrLoadModule('/src/auth/AuthPages.jsx')
  const common = { busy: false, error: '', success: '', onNavigate() {}, onSignIn() {}, onSignUp() {}, onChangePassword() {} }
  const signIn = renderToStaticMarkup(createElement(AccountAuthPage, { ...common, view: 'signin' }))
  const signUp = renderToStaticMarkup(createElement(AccountAuthPage, { ...common, view: 'signup' }))

  assert.equal((signIn.match(/<form\b/g) || []).length, 1)
  assert.match(signIn, /Which interface\?/)
  assert.match(signIn, /name="username-signin"/)
  assert.match(signIn, /Don&#x27;t have an account\? <a href="\/signup"/)
  assert.doesNotMatch(signIn, /Create Account|Confirm Password/)

  assert.equal((signUp.match(/<form\b/g) || []).length, 1)
  assert.match(signUp, /name="new-username-signup"/)
  assert.match(signUp, /Confirm Password/)
  assert.match(signUp, /Already have an account\? <a href="\/signin"/)
  assert.doesNotMatch(signUp, /Which interface\?|<h2[^>]*>Sign In/)
})
