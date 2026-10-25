export function validateSignIn({ username, password, accountType }) {
  if (!String(username || '').trim()) return 'Enter your username.'
  if (!password) return 'Enter your password.'
  if (!['admin', 'voter'].includes(accountType)) return 'Choose Admin or Voter account type.'
  return ''
}

export function validateRegistration({ username, password, confirmPassword }) {
  if (!String(username || '').trim()) return 'Choose a username.'
  if (!password) return 'Choose a password.'
  if (password.length < 10 || password.length > 128) return 'Password must be between 10 and 128 characters.'
  if (password !== confirmPassword) return 'Passwords do not match.'
  return ''
}

export function validatePasswordChange({ currentPassword, newPassword, confirmPassword }) {
  if (!currentPassword) return 'Enter your current password.'
  if (!newPassword || newPassword.length < 10 || newPassword.length > 128) return 'New password must be between 10 and 128 characters.'
  if (newPassword !== confirmPassword) return 'Passwords do not match.'
  if (newPassword === currentPassword) return 'Choose a password different from your current password.'
  return ''
}
