import { useState } from 'react'
import { validatePasswordChange, validateRegistration, validateSignIn } from './authValidation.js'
import './Auth.css'

const screenTitle = {
  signin: 'Welcome back',
  signup: 'Create your voter account',
  'change-password': 'Secure your account',
}

export default function AccountAuthPage({ view, identity, defaultAccountType = 'voter', busy, error, success, onNavigate, onSignIn, onSignUp, onChangePassword }) {
  const [accountType, setAccountType] = useState(defaultAccountType)
  const [signInUsername, setSignInUsername] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [signUpUsername, setSignUpUsername] = useState('')
  const [signUpPassword, setSignUpPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showSignInPassword, setShowSignInPassword] = useState(false)
  const [showSignUpPassword, setShowSignUpPassword] = useState(false)
  const [formError, setFormError] = useState('')

  const submitSignIn = async (event) => {
    event.preventDefault()
    const values = { username: signInUsername, password: signInPassword, accountType }
    const validation = validateSignIn(values)
    if (validation) { setFormError(validation); return }
    setFormError('')
    await onSignIn(values)
  }

  const submitSignUp = async (event) => {
    event.preventDefault()
    const values = { username: signUpUsername, password: signUpPassword, confirmPassword }
    const validation = validateRegistration(values)
    if (validation) { setFormError(validation); return }
    setFormError('')
    await onSignUp(values)
  }

  const submitPasswordChange = async (event) => {
    event.preventDefault()
    const values = { currentPassword, newPassword: password, confirmPassword }
    const validation = validatePasswordChange(values)
    if (validation) { setFormError(validation); return }
    setFormError('')
    await onChangePassword(values)
  }

  const isSignUp = view === 'signup'
  const isSignIn = view === 'signin'
  const isPasswordChange = view === 'change-password'

  if (view === 'loading') return <main className="account-auth-page">
    <header className="account-auth-brand-row"><a className="account-auth-brand" href="/" aria-label="Ballot"><span className="account-auth-mark" aria-hidden="true"><i/><i/><i/></span><span>ballot<span>.</span><small>Campus decisions, clearly.</small></span></a><span className="account-auth-local-badge"><i/> Local development</span></header>
    <div className="account-auth-layout"><div className="account-auth-loading" role="status"><span className="auth-spinner"/> Checking your secure local session…</div></div>
    <footer className="account-auth-footer"><span>Ballot · Campus Voting</span><span>Local development</span></footer>
  </main>

  const signInCard = <form className="account-auth-card" onSubmit={submitSignIn} aria-labelledby="auth-signin-title">
    <span className="account-auth-eyebrow">YOUR BALLOT ACCOUNT</span>
    <h2 id="auth-signin-title">Sign In</h2>
    <p className="account-auth-card-intro">Use your username and password to continue.</p>
    <fieldset className="account-type-options compact"><legend>Which interface?</legend>
      <label className={accountType === 'admin' ? 'selected' : ''}><input type="radio" name={`signin-account-type-${view}`} value="admin" checked={accountType === 'admin'} onChange={() => setAccountType('admin')}/><span className="account-type-icon" aria-hidden="true">▦</span><span><b>Admin</b><small>Manage campus polls</small></span><i aria-hidden="true">✓</i></label>
      <label className={accountType === 'voter' ? 'selected' : ''}><input type="radio" name={`signin-account-type-${view}`} value="voter" checked={accountType === 'voter'} onChange={() => setAccountType('voter')}/><span className="account-type-icon" aria-hidden="true">◉</span><span><b>Voter</b><small>Discover and vote</small></span><i aria-hidden="true">✓</i></label>
    </fieldset>
    <label className="account-auth-field">Username<input autoComplete="username" name={`username-${view}`} value={signInUsername} onChange={(event) => setSignInUsername(event.target.value)} placeholder="Your username" autoCapitalize="none" spellCheck="false"/></label>
    <label className="account-auth-field">Password<span className="account-password-control"><input autoComplete="current-password" name={`password-${view}`} type={showSignInPassword ? 'text' : 'password'} value={signInPassword} onChange={(event) => setSignInPassword(event.target.value)} placeholder="Enter your password"/><button type="button" onClick={() => setShowSignInPassword((value) => !value)} aria-label={showSignInPassword ? 'Hide password' : 'Show password'}>{showSignInPassword ? 'Hide' : 'Show'}</button></span></label>
    {(formError || error) && isSignIn && <p className="account-auth-message" role="alert">{formError || error}</p>}
    {success && isSignIn && <p className="account-auth-success" role="status">{success}</p>}
    <button className="account-auth-submit" type="submit" disabled={busy}>{busy ? <><span className="auth-spinner"/> Signing in…</> : <>Sign In <span aria-hidden="true">→</span></>}</button>
    <p className="account-auth-switch">Don&apos;t have an account? <a href="/signup" onClick={(event) => { event.preventDefault(); onNavigate('/signup') }}>Sign Up</a></p>
    <p className="account-auth-footnote">The backend confirms your account type; this selection does not grant access.</p>
  </form>

  const signUpCard = <form className="account-auth-card" onSubmit={submitSignUp} aria-labelledby="auth-signup-title">
    <span className="account-auth-eyebrow">VOTER REGISTRATION</span>
    <h2 id="auth-signup-title">Create your account</h2>
    <p className="account-auth-card-intro">Join campus conversations with a voter account.</p>
    <label className="account-auth-field">Username<input autoComplete="username" name={`new-username-${view}`} value={signUpUsername} onChange={(event) => setSignUpUsername(event.target.value)} placeholder="Choose a username" autoCapitalize="none" spellCheck="false"/><small>3–32 characters: letters, numbers, dots, underscores, or hyphens.</small></label>
    <label className="account-auth-field">Password<span className="account-password-control"><input autoComplete="new-password" name={`new-password-${view}`} type={showSignUpPassword ? 'text' : 'password'} value={signUpPassword} onChange={(event) => setSignUpPassword(event.target.value)} placeholder="At least 10 characters"/><button type="button" onClick={() => setShowSignUpPassword((value) => !value)} aria-label={showSignUpPassword ? 'Hide password' : 'Show password'}>{showSignUpPassword ? 'Hide' : 'Show'}</button></span></label>
    <label className="account-auth-field">Confirm Password<input autoComplete="new-password" name={`confirm-password-${view}`} type={showSignUpPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter your password again"/></label>
    {(formError || error) && isSignUp && <p className="account-auth-message" role="alert">{formError || error}</p>}
    {success && isSignUp && <p className="account-auth-success" role="status">{success}</p>}
    <button className="account-auth-submit" type="submit" disabled={busy}>{busy ? <><span className="auth-spinner"/> Creating account…</> : <>Create Account <span aria-hidden="true">→</span></>}</button>
    <p className="account-auth-switch">Already have an account? <a href="/signin" onClick={(event) => { event.preventDefault(); onNavigate('/signin') }}>Sign In</a></p>
    <p className="account-auth-footnote">Public registration creates voter accounts only.</p>
  </form>

  return <main className="account-auth-page">
    <div className="account-auth-glow account-auth-glow-one" aria-hidden="true"/>
    <div className="account-auth-glow account-auth-glow-two" aria-hidden="true"/>
    <header className="account-auth-brand-row">
      <a className="account-auth-brand" href="/signin" onClick={(event) => { event.preventDefault(); onNavigate('/signin') }} aria-label="Ballot sign-in page">
        <span className="account-auth-mark" aria-hidden="true"><i/><i/><i/></span>
        <span>ballot<span>.</span><small>Campus decisions, clearly.</small></span>
      </a>
      <span className="account-auth-local-badge"><i/> Local development</span>
    </header>

    <section className="account-auth-layout is-single-auth">
      <div className="account-auth-story">
        <div className="account-auth-kicker"><span/> CAMPUS VOICE, MADE COUNT</div>
        <h1>{screenTitle[view] || 'Ballot account'}</h1>
        <p>{isSignUp
            ? 'Create a voter account to discover open polls and take part in campus decisions.'
            : isPasswordChange
              ? `For your protection, ${identity?.name || 'this administrator account'} must set a new password before continuing.`
              : 'Sign in to continue to the right Ballot workspace. Your account type is confirmed by the local backend.'}</p>
        <div className="account-auth-proof"><span className="proof-symbol">✓</span><span><b>Your voice, your choice</b><small>Review poll rules before submitting your ballot.</small></span></div>
        <div className="account-auth-proof"><span className="proof-symbol">↗</span><span><b>Clear by design</b><small>Results follow the visibility rules set for each poll.</small></span></div>
        <div className="account-auth-art" aria-hidden="true">
          <span className="auth-ring auth-ring-one"/><span className="auth-ring auth-ring-two"/>
          <div className="auth-ballot-card"><span className="auth-ballot-icon">✓</span><div><b>Your vote matters</b><small>A stronger campus starts with listening.</small></div><span className="auth-card-dot"/></div>
          <span className="auth-spark auth-spark-one">✳</span><span className="auth-spark auth-spark-two">✦</span>
        </div>
      </div>

      <div className="account-auth-card-wrap">
        {isSignIn && signInCard}
        {isSignUp && signUpCard}

        {isPasswordChange && <form className="account-auth-card" onSubmit={submitPasswordChange} aria-labelledby="auth-form-title">
          <span className="account-auth-eyebrow">FIRST SIGN-IN REQUIREMENT</span>
          <h2 id="auth-form-title">Change your password</h2>
          <p className="account-auth-card-intro">Set a personal password before opening the Admin workspace.</p>
          <label className="account-auth-field">Current password<input autoComplete="current-password" type={showPassword ? 'text' : 'password'} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Temporary initial password"/></label>
          <label className="account-auth-field">New password<span className="account-password-control"><input autoComplete="new-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters"/><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></span></label>
          <label className="account-auth-field">Confirm new password<input autoComplete="new-password" type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter the new password again"/></label>
          {(formError || error) && <p className="account-auth-message" role="alert">{formError || error}</p>}
          <button className="account-auth-submit" type="submit" disabled={busy}>{busy ? <><span className="auth-spinner"/> Saving…</> : <>Save new password <span aria-hidden="true">→</span></>}</button>
        </form>}
      </div>
    </section>
    <footer className="account-auth-footer"><span>© {new Date().getFullYear()} Ballot · Campus Voting</span><span>Local development · not for real elections</span></footer>
  </main>
}
