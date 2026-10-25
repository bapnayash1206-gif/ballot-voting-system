// The Google ID token is kept in memory only. Reloading the page requires signing in again.
let idToken = ''

export const setGoogleIdToken = (token) => { idToken = token || '' }
export const getGoogleIdToken = () => idToken
export const clearGoogleIdToken = () => { idToken = '' }
