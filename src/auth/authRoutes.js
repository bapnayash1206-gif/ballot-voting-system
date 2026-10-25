export function accountAuthPage(pathname) {
  const path = String(pathname || '/').replace(/\/$/, '') || '/'
  if (path === '/' || path === '/welcome' || path === '/signin') return 'signin'
  if (path === '/signup') return 'signup'
  if (path === '/change-password') return 'change-password'
  return null
}

export function accountAuthPath(destination) {
  const value = String(destination || '').trim()
  const path = value.startsWith('/') ? value : `/${value}`
  if (path === '/' || path === '/welcome' || path === '/signin') return '/signin'
  if (path === '/signup' || path === '/change-password') return path
  return '/signin'
}
