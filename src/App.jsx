import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mockBackend } from './api/mockBackend'
import { canUseLocalOnlyFeatures, createAwsBackend, listPollsForView, resolveApiMode } from './api/awsBackend.js'
import { googleBackend } from './api/googleBackend'
import { accountBackend } from './api/accountBackend'
import { clearGoogleIdToken, getGoogleIdToken, setGoogleIdToken } from './auth/googleIdentity.js'
import AccountAuthPage from './auth/AuthPages.jsx'
import { accountAuthPage, accountAuthPath } from './auth/authRoutes.js'
import { canVoterSeePollCounts, isClosingSoon, matchesVoterPoll, voterEmptyState, voterIdentityNotice } from './api/voterPresentation.js'
import { moveRankingItem } from './voting/ranking.js'
import { checkLocalApiHealth } from './api/localHealth.js'
import { localChatApi } from './api/localChat.js'
import { createAdminCommands, filterAdminCommands } from './admin/commandPalette.js'
import QRCode from 'qrcode'
import { buildVoterPollUrl, canSharePoll, isLoopbackVoterUrl } from './admin/pollSharing.js'
import { buildPollReportsCsv, closePollsIndividually, collectPollReports, togglePollSelection, toggleVisiblePollSelection } from './admin/reportExport.js'
import './App.css'

const DUPLICATE_VOTE = 'You have already voted in this poll. You cannot vote again.'
const STATUS_LABEL = { active: 'Live', expired: 'Ended', closed: 'Closed', draft: 'Draft' }
const configuredAuthMode = import.meta.env.VITE_AUTH_MODE || 'accounts'
const configuredApiMode = resolveApiMode(import.meta.env.VITE_API_MODE || '')
const awsMode = configuredApiMode === 'aws'
const accountMode = !awsMode && configuredAuthMode === 'accounts'
const googleMode = awsMode || configuredAuthMode === 'google'
const configuredGoogleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const backend = awsMode
  ? createAwsBackend({ httpBaseUrl: import.meta.env.VITE_HTTP_API_URL || '', getIdentityToken: getGoogleIdToken })
  : googleMode ? googleBackend : accountMode ? accountBackend : mockBackend

function voterPollUrl(pollId) {
  return buildVoterPollUrl(pollId, {
    configuredOrigin: import.meta.env.VITE_APP_ORIGIN || '',
    currentOrigin: globalThis.location?.origin || '',
  })
}

function fromApiPoll(poll) {
  return {
    ...poll,
    options: poll.options.map((option) => ({ id: option.id, label: option.label, count: option.count ?? 0, percentage: option.percentage ?? 0 })),
    voteCount: poll.ballotCount ?? 0,
    resultLoaded: poll.options.every((option) => Number.isInteger(option.count)),
    audience: poll.votingMode,
    visibility: ({ afterVote: 'after-vote', afterClose: 'after-close' })[poll.resultVisibility] || poll.resultVisibility,
  }
}

function toApiPoll(poll, disableChat = false) {
  return {
    question: poll.question,
    options: poll.options,
    votingType: poll.votingType,
    votingMode: poll.audience,
    durationMinutes: poll.durationMinutes,
    resultVisibility: ({ 'after-vote': 'afterVote', 'after-close': 'afterClose' })[poll.visibility] || poll.visibility,
    chatEnabled: disableChat ? false : poll.chatEnabled,
  }
}

function routeFromLocation() {
  const path = location.pathname.replace(/\/$/, '') || '/'
  const authPage = accountMode ? accountAuthPage(path) : null
  if (authPage) return { area: 'auth', page: authPage }
  const decodeRouteId = (value) => {
    try { return decodeURIComponent(value) }
    catch { return value }
  }
  const voterMatch = path.match(/^\/(?:poll|vote)\/([^/]+)$/)
  if (voterMatch) return { area: 'voter', page: 'poll', pollId: decodeRouteId(voterMatch[1]) }
  if (path === '/vote') return { area: 'voter', page: 'home' }
  const resultMatch = path.match(/^\/admin\/results\/([^/]+)$/)
  if (resultMatch) return { area: 'admin', page: 'results', pollId: decodeRouteId(resultMatch[1]) }
  const adminPollMatch = path.match(/^\/admin\/polls\/([^/]+)$/)
  if (adminPollMatch) return { area: 'admin', page: 'poll', pollId: decodeRouteId(adminPollMatch[1]) }
  if (path === '/admin/polls') return { area: 'admin', page: 'polls' }
  if (path === '/admin/analytics') return { area: 'admin', page: 'analytics' }
  return { area: 'admin', page: 'overview' }
}

const secondsLeft = (poll, now) => poll.endsAt ? Math.max(0, Math.ceil((poll.endsAt - now) / 1000)) : 0
const pollStatus = (poll, now) => poll.status === 'active' && poll.endsAt && poll.endsAt <= now ? 'expired' : poll.status
const formatDuration = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
const safeFilePart = (value) => String(value || 'poll').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase() || 'poll'
const timeAgo = (time) => {
  if (!time) return 'Not started'
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function App() {
  const [route, setRoute] = useState(routeFromLocation)
  const [identity, setIdentity] = useState(null)
  const [authState, setAuthState] = useState(accountMode ? 'checking' : googleMode ? 'signed-out' : 'disabled')
  const [authError, setAuthError] = useState('')
  const [authSuccess, setAuthSuccess] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [polls, setPolls] = useState([])
  const [dashboardStats, setDashboardStats] = useState(null)
  const [apiState, setApiState] = useState('loading')
  const [apiError, setApiError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [resultData, setResultData] = useState({})
  const [resultState, setResultState] = useState({})
  const [resultUpdatedAt, setResultUpdatedAt] = useState({})
  const resultRequests = useRef(new Set())
  const [voted, setVoted] = useState({})
  const [voteCheckState, setVoteCheckState] = useState({})
  const [selected, setSelected] = useState({})
  const [notice, setNotice] = useState(null)
  const [editor, setEditor] = useState(null)
  const [formError, setFormError] = useState('')
  const [confirmation, setConfirmation] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(() => Date.now())
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [adminSection, setAdminSection] = useState('admin-dashboard')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [sharingPoll, setSharingPoll] = useState(null)
  const [sharingUrl, setSharingUrl] = useState('')
  const [selectedPollIds, setSelectedPollIds] = useState([])
  const [reportBusy, setReportBusy] = useState(false)
  const [printReports, setPrintReports] = useState(null)

  const setPath = useCallback((path, { replace = false } = {}) => {
    const target = accountMode && accountAuthPage(path) ? accountAuthPath(path) : path.startsWith('/') ? path : `/${path}`
    if (replace) history.replaceState({}, '', target)
    else history.pushState({}, '', target)
    setRoute(routeFromLocation())
    setNotice(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    if (!accountMode) return undefined
    let cancelled = false
    accountBackend.getCurrentUser().then(({ user }) => {
      if (cancelled) return
      const verifiedUser = { ...user, isAdmin: user.role === 'admin' }
      setIdentity(verifiedUser)
      setAuthState('signed-in')
      const currentRoute = routeFromLocation()
      if (user.mustChangePassword) setPath('/change-password', { replace: true })
      else if (currentRoute.area === 'auth') setPath(user.role === 'admin' ? '/admin' : '/vote', { replace: true })
      else if (user.role === 'voter' && currentRoute.area === 'admin') setPath('/vote', { replace: true })
      else if (user.role === 'admin' && currentRoute.area === 'voter') setPath('/admin', { replace: true })
    }).catch((error) => {
      if (cancelled) return
      setIdentity(null)
      setAuthState('signed-out')
      if (error.message !== 'Sign in is required.') setAuthError(error.message || 'Could not verify the local session. Check that the backend is running.')
      if (routeFromLocation().area !== 'auth') setPath('/signin', { replace: true })
    })
    return () => { cancelled = true }
  }, [setPath])

  const signInWithPassword = async (credentials) => {
    setAuthBusy(true)
    setAuthError('')
    setAuthSuccess('')
    try {
      const { user } = await accountBackend.login(credentials)
      const verifiedUser = { ...user, isAdmin: user.role === 'admin' }
      setIdentity(verifiedUser)
      setAuthState('signed-in')
      setPath(user.mustChangePassword ? '/change-password' : user.role === 'admin' ? '/admin' : '/vote', { replace: true })
    } catch (error) { setAuthError(error.message || 'Could not sign in. Check the account details and try again.') }
    finally { setAuthBusy(false) }
  }

  const signUpVoter = async (details) => {
    setAuthBusy(true)
    setAuthError('')
    setAuthSuccess('')
    try {
      await accountBackend.register(details)
      setAuthSuccess('Your voter account is ready. Sign in with your new username and password.')
      setPath('/signin', { replace: true })
      return true
    } catch (error) { setAuthError(error.message || 'Could not create the voter account.') }
    finally { setAuthBusy(false) }
    return false
  }

  const changeInitialPassword = async (details) => {
    setAuthBusy(true)
    setAuthError('')
    try {
      const { user } = await accountBackend.changePassword(details)
      const verifiedUser = { ...user, isAdmin: user.role === 'admin' }
      setIdentity(verifiedUser)
      setPath(user.role === 'admin' ? '/admin' : '/vote', { replace: true })
    } catch (error) { setAuthError(error.message || 'Could not change the password.') }
    finally { setAuthBusy(false) }
  }

  const acceptGoogleCredential = useCallback(async (token) => {
    setAuthState('loading')
    setAuthError('')
    setGoogleIdToken(token)
    try {
      const { user, isAdmin } = await backend.getCurrentUser()
      setIdentity({ ...user, isAdmin, role: isAdmin ? 'admin' : 'voter' })
      setAuthState('signed-in')
      setNotice({ kind: 'success', text: `Signed in as ${user.email || user.name || 'Google account'}.` })
      const destination = isAdmin ? '/admin' : '/vote'
      history.replaceState({}, '', destination)
      setRoute(routeFromLocation())
    } catch (error) {
      clearGoogleIdToken()
      setIdentity(null)
      setAuthState('error')
      setAuthError(error.message || 'The backend could not verify this Google sign-in.')
    }
  }, [])

  useEffect(() => {
    if (route.area !== 'admin' || route.page !== 'overview' || typeof IntersectionObserver === 'undefined') return undefined
    const sectionIds = ['admin-dashboard', 'admin-polls', 'admin-analytics', 'admin-results', 'admin-chat']
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
      if (visible) setAdminSection(visible.target.id)
    }, { rootMargin: '-110px 0px -62% 0px', threshold: 0 })
    sectionIds.forEach((id) => {
      const section = document.getElementById(id)
      if (section) observer.observe(section)
    })
    return () => observer.disconnect()
  }, [route.area, route.page])

  const signOut = async () => {
    if (accountMode) {
      try { await accountBackend.logout() }
      catch (error) { setNotice({ kind: 'error', text: error.message || 'Could not sign out. Please retry.' }); return }
    }
    clearGoogleIdToken()
    window.google?.accounts?.id?.disableAutoSelect?.()
    setIdentity(null)
    setAuthState(accountMode || googleMode ? 'signed-out' : 'disabled')
    setPolls([])
    setResultData({})
    setVoted({})
    setSharingPoll(null)
    setSharingUrl('')
    setSelectedPollIds([])
    history.replaceState({}, '', accountMode ? '/signin' : '/vote')
    setRoute(routeFromLocation())
    setNotice({ kind: 'info', text: 'You have signed out.' })
  }

  const activeId = route.pollId
  const active = polls.find((poll) => poll.id === activeId)
  const activeResults = activeId ? resultData[activeId] : null

  const refreshPolls = useCallback(async ({ silent = false } = {}) => {
    if ((googleMode || accountMode) && !identity) { setApiState('unauthenticated'); return false }
    if (!silent) setApiState('loading')
    setApiError('')
    try {
      const response = await listPollsForView(backend, configuredApiMode, route.area)
      setPolls(response.polls.map(fromApiPoll))
      setDashboardStats(awsMode ? response.dashboard || null : null)
      setApiState('ready')
      return true
    } catch (error) {
      setApiState('error')
      setApiError(error.message || 'Could not load polls from the configured backend.')
      return false
    }
  }, [identity, route.area])

  useEffect(() => {
    let cancelled = false
    Promise.resolve().then(() => { if (!cancelled) refreshPolls() })
    return () => { cancelled = true }
  }, [refreshPolls])
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000)
    const handlePop = () => {
      if ((googleMode || accountMode) && identity && !identity.isAdmin && location.pathname.startsWith('/admin')) {
        history.replaceState({}, '', '/vote')
        setRoute(routeFromLocation())
      } else if (accountMode && identity?.role === 'admin' && (location.pathname === '/vote' || location.pathname.startsWith('/poll/'))) {
        history.replaceState({}, '', '/admin')
        setRoute(routeFromLocation())
      } else if (accountMode && !identity && !location.pathname.startsWith('/sign')) {
        history.replaceState({}, '', '/signin')
        setRoute(routeFromLocation())
      } else setRoute(routeFromLocation())
      setNotice(null)
    }
    addEventListener('popstate', handlePop)
    return () => { clearInterval(timer); removeEventListener('popstate', handlePop) }
  }, [identity, route.area])

  useEffect(() => {
    if (((googleMode || accountMode) && !identity) || !activeId || route.page === 'overview' || route.page === 'polls' || route.page === 'analytics' || apiState === 'loading') return
    let cancelled = false
    backend.readPoll(activeId).then(({ poll }) => {
      if (!cancelled) {
        setDetailError('')
        setPolls((all) => {
          const normalized = fromApiPoll(poll)
          return all.some((item) => item.id === normalized.id)
            ? all.map((item) => item.id === normalized.id ? normalized : item)
            : [normalized, ...all]
        })
      }
    }).catch((error) => { if (!cancelled) setDetailError(error.message || 'Could not load this poll.') })
    return () => { cancelled = true }
  }, [activeId, route.page, apiState, identity])

  const loadResults = useCallback(async (pollId, { silent = false } = {}) => {
    if (!pollId || resultRequests.current.has(pollId)) return
    resultRequests.current.add(pollId)
    if (!silent) setResultState((all) => ({ ...all, [pollId]: 'loading' }))
    try {
      const response = await backend.getResults(pollId)
      setResultData((all) => ({ ...all, [pollId]: response.results }))
      setResultUpdatedAt((all) => ({ ...all, [pollId]: Date.now() }))
      setResultState((all) => ({ ...all, [pollId]: 'ready' }))
    } catch (error) {
      const hidden = error.message?.includes('not visible')
      if (!silent || hidden) setResultData((all) => { const next = { ...all }; delete next[pollId]; return next })
      setResultState((all) => ({ ...all, [pollId]: silent && !hidden ? 'refresh-error' : hidden ? 'hidden' : 'error' }))
      if (!hidden && !silent) setApiError(error.message || 'Could not load poll results.')
    } finally {
      resultRequests.current.delete(pollId)
    }
  }, [])

  useEffect(() => {
    if (((googleMode || accountMode) && !identity) || !active || !['poll', 'results'].includes(route.page)) return
    if (route.page !== 'results' && active.status === 'active' && active.visibility !== 'live' && !voted[active.id]) return
    let cancelled = false
    Promise.resolve().then(() => { if (!cancelled) loadResults(active.id) })
    return () => { cancelled = true }
  }, [active, route.page, voted, loadResults, identity])

  useEffect(() => {
    if (((googleMode || accountMode) && !identity) || route.area !== 'admin' || route.page !== 'results' || !activeId || apiState !== 'ready') return undefined
    const timer = setInterval(() => loadResults(activeId, { silent: true }), 5000)
    return () => clearInterval(timer)
  }, [activeId, apiState, identity, loadResults, route.area, route.page])

  useEffect(() => {
    if (((googleMode || accountMode) && !identity) || !active || route.page !== 'poll') return
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return null
      setVoteCheckState((all) => ({ ...all, [active.id]: 'loading' }))
      return backend.hasVoted(active.id)
    }).then((response) => {
      if (!response) return
      const { hasVoted } = response
      if (!cancelled) {
        setVoted((all) => ({ ...all, [active.id]: hasVoted }))
        setVoteCheckState((all) => ({ ...all, [active.id]: 'ready' }))
      }
    }).catch((error) => {
      if (!cancelled) {
        setVoteCheckState((all) => ({ ...all, [active.id]: 'error' }))
        setNotice({ kind: 'error', text: error.message || 'Could not check your voting status.' })
      }
    })
    return () => { cancelled = true }
  }, [active, route.page, identity])

  useEffect(() => {
    if (((googleMode || accountMode) && !identity) || route.area !== 'voter' || route.page !== 'home' || !polls.length) return undefined
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return null
      setVoteCheckState((all) => Object.fromEntries([...new Set([...Object.keys(all), ...polls.map((poll) => poll.id)])].map((pollId) => [pollId, polls.some((poll) => poll.id === pollId) ? 'loading' : all[pollId]])))
      return Promise.all(polls.map(async (poll) => {
        try { return [poll.id, (await backend.hasVoted(poll.id)).hasVoted, 'ready'] }
        catch { return [poll.id, undefined, 'error'] }
      }))
    }).then((entries) => {
      if (!entries) return
      if (cancelled) return
      setVoted((all) => {
        const next = { ...all }
        entries.forEach(([pollId, hasVoted]) => { if (typeof hasVoted === 'boolean') next[pollId] = hasVoted })
        return next
      })
      setVoteCheckState((all) => ({ ...all, ...Object.fromEntries(entries.map(([pollId, , state]) => [pollId, state])) }))
    })
    return () => { cancelled = true }
  }, [route.area, route.page, polls, identity])

  useEffect(() => {
    if (!active || active.status !== 'active' || !active.endsAt) return undefined
    const remaining = active.endsAt - Date.now()
    const timer = setTimeout(() => refreshPolls({ silent: true }), Math.max(0, remaining + 100))
    return () => clearTimeout(timer)
  }, [active, refreshPolls])

  const navigate = (path) => {
    if (googleMode && identity && !identity.isAdmin && path.startsWith('/admin')) path = '/vote'
    if (accountMode && identity) {
      if (identity.mustChangePassword && path !== '/change-password') path = '/change-password'
      else if (identity.role === 'voter' && path.startsWith('/admin')) path = '/vote'
      else if (identity.role === 'admin' && (path === '/vote' || path.startsWith('/poll/'))) path = '/admin'
    }
    setPath(path)
  }
  const scrollToAdminSection = (sectionId) => {
    setAdminSection(sectionId)
    const scroll = () => document.getElementById(sectionId)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    if (route.area === 'admin' && route.page === 'overview') scroll()
    else {
      navigate('/admin')
      requestAnimationFrame(() => requestAnimationFrame(scroll))
    }
  }
  const openEditor = (poll = null) => {
    const source = poll || { question: '', options: ['', ''], durationMinutes: 30, votingType: 'single', audience: 'public', visibility: 'live', chatEnabled: true }
    setDraft({ ...source, options: poll ? poll.options.map((option) => option.label) : [...source.options] })
    setFormError('')
    setEditor(poll ? 'edit' : 'new')
  }

  const savePoll = async (event) => {
    event.preventDefault()
    if (busy || !draft) return
    const options = draft.options.map((option) => option.trim()).filter(Boolean)
    if (!draft.question.trim() || options.length < 2) { setFormError('Add a question and at least two answer options.'); return }
    if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) { setFormError('Answer options must be unique.'); return }
    setBusy(true)
    setFormError('')
    try {
      if (editor === 'new') {
        const { poll } = await backend.createPoll(toApiPoll({ ...draft, options }, awsMode))
        await refreshPolls({ silent: true })
        setEditor(null)
        navigate(`/admin/polls/${poll.id}`)
        setNotice({ kind: 'success', text: 'Poll created as a draft. Start it when you are ready.' })
      } else {
        await backend.updatePoll(draft.id, toApiPoll({ ...draft, options }, awsMode))
        await refreshPolls({ silent: true })
        setNotice({ kind: 'success', text: 'Draft poll updated.' })
        setEditor(null)
      }
    } catch (error) { setFormError(error.message || 'Could not save the poll.') }
    finally { setBusy(false) }
  }

  const runLifecycleAction = async (poll, action) => {
    setBusy(true)
    try {
      await backend[`${action}Poll`](poll.id)
      await refreshPolls({ silent: true })
      if (action === 'close') await loadResults(poll.id)
      if (action === 'reopen') {
        setResultData((all) => { const next = { ...all }; delete next[poll.id]; return next })
        setResultState((all) => { const next = { ...all }; delete next[poll.id]; return next })
      }
      setNotice({ kind: 'success', text: ({ start: 'Poll started.', close: 'Poll closed.', reopen: 'Poll reopened. Previous votes and counts were preserved.' })[action] })
    } catch (error) { setNotice({ kind: 'error', text: error.message || `Could not ${action} the poll.` }) }
    finally { setBusy(false) }
  }

  const lifecycleAction = (poll, action) => {
    const titles = { start: 'Start this poll?', close: 'Close this poll?', reopen: 'Reopen this poll?' }
    const prompts = {
      start: `Start “${poll.question}” now? Its ${poll.durationMinutes}-minute voting window will begin.`,
      close: `Close “${poll.question}” now? Voters will no longer be able to submit.`,
      reopen: `Reopen “${poll.question}” with a fresh ${poll.durationMinutes}-minute voting window? Existing votes will remain.`,
    }
    setConfirmation({ title: titles[action], description: prompts[action], confirmLabel: titles[action].replace(' this poll?', ' poll'), run: () => runLifecycleAction(poll, action) })
  }

  const runDeletePoll = async (poll) => {
    setBusy(true)
    try {
      await backend.deletePoll(poll.id)
      await refreshPolls({ silent: true })
      if (activeId === poll.id) navigate('/admin/polls')
      setNotice({ kind: 'success', text: 'Draft poll deleted.' })
    } catch (error) { setNotice({ kind: 'error', text: error.message || 'Could not delete this draft.' }) }
    finally { setBusy(false) }
  }

  const deletePoll = (poll) => setConfirmation({
    title: 'Delete this draft?',
    description: `“${poll.question}” will be removed from this local in-memory backend. This cannot be undone.`,
    confirmLabel: 'Delete draft',
    danger: true,
    run: () => runDeletePoll(poll),
  })

  const submitVote = async () => {
    if (!active) return
    if (pollStatus(active, tick) !== 'active') { setNotice({ kind: 'error', text: 'This poll is closed and cannot accept votes.' }); return }
    const optionIds = selected[active.id] || []
    if (!optionIds.length) { setNotice({ kind: 'error', text: 'Choose at least one option before submitting.' }); return }
    setBusy(true)
    try {
      const ballot = active.votingType === 'ranked' ? { rankedOptionIds: optionIds }
        : active.votingType === 'single' ? { optionId: optionIds[0] } : { optionIds }
      await backend.submitVote(active.id, ballot)
      setVoted((all) => ({ ...all, [active.id]: true }))
      setVoteCheckState((all) => ({ ...all, [active.id]: 'ready' }))
      setNotice({ kind: 'success', text: 'Your vote was recorded by the ' + (awsMode ? 'AWS' : 'local') + ' backend.' })
      await refreshPolls({ silent: true })
      await loadResults(active.id)
    } catch (error) {
      const text = error.message === DUPLICATE_VOTE ? DUPLICATE_VOTE : error.message || 'The backend did not accept this vote.'
      if (text === DUPLICATE_VOTE) {
        setVoted((all) => ({ ...all, [active.id]: true }))
        setVoteCheckState((all) => ({ ...all, [active.id]: 'ready' }))
      }
      setNotice({ kind: 'error', text })
    } finally { setBusy(false) }
  }

  const copyPollLink = async (pollId) => {
    let url = ''
    try {
      url = voterPollUrl(pollId)
      await navigator.clipboard.writeText(url)
      setNotice({ kind: 'success', text: 'Voter link copied to clipboard.' })
    } catch (error) {
      setNotice(url ? { kind: 'info', text: `Copy was unavailable. Share this voter link: ${url}` } : { kind: 'error', text: error.message || 'Could not create a voter link.' })
    }
  }
  const sharePoll = (poll) => {
    if (!canSharePoll(poll)) return
    try {
      setSharingUrl(voterPollUrl(poll.id))
      setSharingPoll(poll)
    } catch (error) { setNotice({ kind: 'error', text: error.message || 'Could not create a voter link.' }) }
  }

  const downloadCsv = (reports, filename = 'ballot-voting-report.csv') => {
    const blob = new Blob([buildPollReportsCsv(reports)], { type: 'text/csv;charset=utf-8' })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }

  const exportPollReports = async (selectedPolls) => {
    setReportBusy(true)
    try {
      const { reports, failures } = await collectPollReports(selectedPolls, (pollId) => backend.getResults(pollId))
      if (reports.length) downloadCsv(reports, `ballot-voting-report-${new Date().toISOString().slice(0, 10)}.csv`)
      if (!reports.length) {
        setNotice({ kind: 'error', text: `No results were exportable. ${failures.map(({ poll, reason }) => `${poll.question}: ${reason}`).join(' · ')}` })
      } else if (failures.length) {
        setNotice({ kind: 'error', text: `CSV exported for ${reports.length} poll(s). Skipped ${failures.map(({ poll, reason }) => `${poll.question}: ${reason}`).join(' · ')}` })
      } else setNotice({ kind: 'success', text: `CSV report exported for ${reports.length} poll(s).` })
    } catch (error) {
      setNotice({ kind: 'error', text: error.message || 'Could not export poll results.' })
    } finally { setReportBusy(false) }
  }

  const exportSingleReport = (poll, results) => {
    try {
      downloadCsv([{ poll, results }], `ballot-${safeFilePart(poll.question)}-report.csv`)
      setNotice({ kind: 'success', text: 'Poll results CSV exported.' })
    } catch (error) { setNotice({ kind: 'error', text: error.message || 'Could not export poll results.' }) }
  }

  const preparePrintReport = (reports) => {
    if (typeof window.print !== 'function') {
      setNotice({ kind: 'error', text: 'This browser does not provide printing. CSV export is still available.' })
      return
    }
    setPrintReports(reports)
    setNotice({ kind: 'info', text: 'Print view opened. Choose “Save as PDF” in the browser print destination.' })
  }

  const bulkClosePolls = (selectedPolls) => {
    const activePolls = selectedPolls.filter((poll) => pollStatus(poll, tick) === 'active')
    const skippedCount = selectedPolls.length - activePolls.length
    if (!activePolls.length) {
      setNotice({ kind: 'error', text: 'No selected polls are currently active. Only active polls can be closed.' })
      return
    }
    setConfirmation({
      title: `Close ${activePolls.length} selected poll${activePolls.length === 1 ? '' : 's'}?`,
      description: `The backend will close each active poll separately. ${skippedCount ? `${skippedCount} selected draft, closed, or ended poll(s) will be skipped.` : 'All selected polls are active.'}`,
      confirmLabel: `Close ${activePolls.length} poll${activePolls.length === 1 ? '' : 's'}`,
      run: async () => {
        setBusy(true)
        const { succeeded, failures } = await closePollsIndividually(activePolls, (pollId) => backend.closePoll(pollId))
        await Promise.all(succeeded.map((poll) => loadResults(poll.id)))
        const refreshed = await refreshPolls({ silent: true })
        if (succeeded.length) {
          const closedIds = new Set(succeeded.map((poll) => poll.id))
          setSelectedPollIds((ids) => ids.filter((id) => !closedIds.has(id)))
        }
        const outcome = failures.length
          ? `Closed ${succeeded.length} of ${activePolls.length} active polls. Failed: ${failures.map(({ poll, reason }) => `${poll.question}: ${reason}`).join(' · ')}`
          : `Closed ${succeeded.length} active poll${succeeded.length === 1 ? '' : 's'}.`
        setNotice({ kind: failures.length || !refreshed ? 'error' : 'success', text: `${outcome}${!refreshed ? ' Poll list refresh failed; retry before relying on the displayed statuses.' : ''}${skippedCount ? ` ${skippedCount} non-active poll(s) skipped.` : ''}` })
        setBusy(false)
      },
    })
  }

  useEffect(() => {
    if (!printReports) return undefined
    const afterPrint = () => setPrintReports(null)
    window.addEventListener('afterprint', afterPrint)
    const timer = window.setTimeout(() => window.print(), 80)
    return () => { window.clearTimeout(timer); window.removeEventListener('afterprint', afterPrint) }
  }, [printReports])

  const totalVotes = useMemo(() => dashboardStats?.totalVotes ?? polls.reduce((sum, poll) => sum + poll.voteCount, 0), [dashboardStats, polls])
  const counts = useMemo(() => polls.reduce((all, poll) => {
    const status = pollStatus(poll, tick)
    all[status] = (all[status] || 0) + 1
    return all
  }, {}), [polls, tick])
  const visiblePolls = useMemo(() => polls.filter((poll) => {
    const status = pollStatus(poll, tick)
    const matchesSearch = poll.question.toLowerCase().includes(search.toLowerCase()) || poll.id.toLowerCase().includes(search.toLowerCase())
    return matchesSearch && (statusFilter === 'all' || status === statusFilter)
  }), [polls, search, statusFilter, tick])

  const adminCommands = createAdminCommands({
    polls,
    navigate,
    scrollToSection: scrollToAdminSection,
    openEditor: () => openEditor(),
    sharePoll,
  })

  const pageTitle = route.area === 'admin'
    ? (route.page === 'overview' ? ({ 'admin-dashboard': 'Dashboard', 'admin-polls': 'Poll management', 'admin-analytics': 'Analytics', 'admin-results': 'Results', 'admin-chat': 'Live chat' })[adminSection] || 'Dashboard' : ({ overview: 'Dashboard', polls: 'Poll management', analytics: 'Results & analytics', results: 'Poll results', poll: 'Poll details' })[route.page])
    : ({ home: 'Explore polls', poll: 'Cast your vote' })[route.page]
  const isVoter = route.area === 'voter'
  const hasAdminAccess = accountMode ? identity?.role === 'admin' : !googleMode || Boolean(identity?.isAdmin)

  useEffect(() => {
    if (!hasAdminAccess || route.area !== 'admin') return undefined
    const onShortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [hasAdminAccess, route.area])

  if (accountMode && authState === 'checking') return <AccountAuthPage view="loading" busy error="" onNavigate={() => {}} onSignIn={signInWithPassword} onSignUp={signUpVoter} onChangePassword={changeInitialPassword}/>
  if (accountMode && (!identity || route.area === 'auth' || identity.mustChangePassword)) {
    const view = identity?.mustChangePassword ? 'change-password' : route.area === 'auth' ? route.page : 'signin'
    return <AccountAuthPage
      view={view} identity={identity} busy={authBusy} error={authError} success={authSuccess}
      onNavigate={(destination) => { setAuthError(''); setAuthSuccess(''); setPath(accountAuthPath(destination)) }}
      onSignIn={signInWithPassword} onSignUp={signUpVoter} onChangePassword={changeInitialPassword}/>
  }

  return <div className={`shell ${isVoter ? 'voter-shell' : 'admin-shell'}`}>
    {!isVoter && <aside className="sidebar">
      <a className="brand" href="/admin" onClick={(event) => { event.preventDefault(); navigate('/admin') }} aria-label="Ballot home">
        <span className="brand-mark" aria-hidden="true"><i/><i/><i/></span><span>ballot<span className="brand-period">.</span><small>Campus decisions, clearly.</small></span>
      </a>
      {!isVoter && hasAdminAccess && <div className="workspace-switch"><span className="workspace-avatar">A</span><span><b>Campus workspace</b><small>{googleMode ? 'Google account' : accountMode ? `Local account · ${identity?.username || ''}` : 'Local development'}</small></span><span className="workspace-chevron">⌄</span></div>}
      <div className="nav-caption">{isVoter || !hasAdminAccess ? 'PARTICIPATE' : 'WORKSPACE'}</div>
      <nav className="side-nav" aria-label={isVoter ? 'Voter navigation' : 'Admin navigation'}>
        {isVoter || !hasAdminAccess ? <>
          <NavLink active={route.page === 'home'} onClick={() => navigate('/vote')}>Discover polls</NavLink>
          {active && <NavLink active={route.page === 'poll'} onClick={() => navigate(`/poll/${active.id}`)}>Current poll</NavLink>}
        </> : <>
          <NavLink active={route.page === 'overview' ? adminSection === 'admin-dashboard' : route.page === 'overview'} onClick={() => scrollToAdminSection('admin-dashboard')}>Dashboard</NavLink>
          <NavLink active={route.page === 'overview' ? adminSection === 'admin-polls' : route.page === 'polls' || route.page === 'poll'} onClick={() => scrollToAdminSection('admin-polls')}>Polls <span className="nav-count">{apiState === 'ready' ? polls.length : '—'}</span></NavLink>
          <NavLink active={route.page === 'overview' ? adminSection === 'admin-analytics' : route.page === 'analytics'} onClick={() => scrollToAdminSection('admin-analytics')}>Analytics</NavLink>
          <NavLink active={route.page === 'overview' ? adminSection === 'admin-results' : route.page === 'results'} onClick={() => scrollToAdminSection('admin-results')}>Results</NavLink>
          {canUseLocalOnlyFeatures(configuredApiMode) && <NavLink active={route.page === 'overview' && adminSection === 'admin-chat'} onClick={() => scrollToAdminSection('admin-chat')}>Live chat</NavLink>}
        </>}
      </nav>
      <div className="sidebar-bottom">
        <div className="environment-label"><span className="environment-dot"/>{awsMode ? 'AWS HTTP API MODE' : 'LOCAL DEVELOPMENT'}</div>
        <p>{awsMode ? 'Google OIDC token · HTTP API mode · no chat or WebSockets' : googleMode ? 'Google ID token verified locally · in-memory storage · development only' : accountMode ? 'Local account authentication · not production-secure' : 'In-memory data · development-only identity · not production-secure'}</p>
      </div>
    </aside>}
    {isVoter && <VoterTopNav route={route} active={active} navigate={navigate} apiState={apiState} identity={identity} googleMode={googleMode} accountMode={accountMode} canAccessAdmin={hasAdminAccess} signOut={signOut}/>}

    <main className={`main-area ${isVoter ? 'voter-main-area' : ''}`}>
      {!isVoter && <header className="topbar">
        <div className="breadcrumbs"><span>Ballot</span><span className="crumb-divider">/</span><b>{isVoter ? 'Voter portal' : 'Admin workspace'}</b><span className="crumb-divider">/</span><b>{pageTitle}</b></div>
        <div className="topbar-actions">
          {!canUseLocalOnlyFeatures(configuredApiMode) ? <span className="connection-pill local-health healthy" title="AWS HTTP API mode is selected. No AWS health request has been made." aria-label="AWS HTTP API mode selected; endpoint health is not verified."><i/>AWS API · not verified</span> : <LocalHealthIndicator/>}
          {hasAdminAccess && <button type="button" className="admin-command-trigger" onClick={() => setCommandPaletteOpen(true)} aria-label="Open command palette"><span aria-hidden="true">⌕</span><span>Search commands</span><kbd>Ctrl K</kbd></button>}
          {!googleMode && !accountMode && <button className="mode-switch" onClick={() => navigate(isVoter ? '/admin' : '/vote')} aria-label={isVoter ? 'Switch to local admin preview' : 'Switch to voter portal'}>{isVoter ? 'Admin preview' : 'Voter portal'} <span aria-hidden="true">↗</span></button>}
          {googleMode && identity?.isAdmin && <button className="mode-switch" onClick={() => navigate(isVoter ? '/admin' : '/vote')}>{isVoter ? 'Admin workspace' : 'Voter portal'} <span aria-hidden="true">↗</span></button>}
          {googleMode && identity && <><span className="identity-label">{identity.email || identity.name}</span><button className="mode-switch" onClick={signOut}>Sign out</button></>}
          {accountMode && identity && <><span className="identity-label">{identity.username}</span><button className="mode-switch" onClick={signOut}>Sign out</button></>}
          {!googleMode && !accountMode && <span className="user-avatar" aria-label={isVoter ? 'Local voter preview' : 'Local admin preview'}>{isVoter ? 'V' : 'A'}</span>}
        </div>
      </header>}

      <div className={`content-wrap ${isVoter ? 'voter-content-wrap' : ''}`}>
        {notice && <Notice notice={notice} dismiss={() => setNotice(null)}/>}
        {googleMode && !identity ? <GoogleAuthPanel awsMode={awsMode} clientId={configuredGoogleClientId} state={authState} error={authError} onCredential={acceptGoogleCredential}/> : <>
        {apiState === 'error' && !isVoter && <div className="backend-alert" role="alert"><div><strong>{awsMode ? 'AWS HTTP API is unavailable' : 'Local backend is unavailable'}</strong><p>{apiError}</p></div><button className="button button-outline" onClick={() => refreshPolls()}>Retry connection</button></div>}
        {isVoter || !hasAdminAccess ? <VoterPages
          route={route} navigate={navigate} polls={polls} statusAt={(poll) => pollStatus(poll, tick)} secondsLeft={(poll) => secondsLeft(poll, tick)}
          identity={identity} accountMode={accountMode} googleMode={googleMode} active={active} activeResults={activeResults} resultState={resultState} loadResults={loadResults} voted={voted} selected={selected}
          setSelected={setSelected} setConfirmation={setConfirmation} busy={busy} submitVote={submitVote} detailError={detailError} apiState={apiState} apiError={apiError} refreshPolls={refreshPolls} voteCheckState={voteCheckState} awsMode={awsMode}/>
          : <AdminPages
            route={route} navigate={navigate} polls={polls} visiblePolls={visiblePolls} counts={counts} totalVotes={totalVotes} dashboardStats={dashboardStats}
            apiState={apiState} busy={busy} search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
            openEditor={openEditor} startPoll={(poll) => lifecycleAction(poll, 'start')} closePoll={(poll) => lifecycleAction(poll, 'close')}
            reopenPoll={(poll) => lifecycleAction(poll, 'reopen')} deletePoll={deletePoll} copyPollLink={copyPollLink}
            sharePoll={sharePoll}
            selectedPollIds={selectedPollIds} setSelectedPollIds={setSelectedPollIds} onBulkClose={bulkClosePolls} onBulkExport={exportPollReports} reportBusy={reportBusy}
            onExportReport={exportSingleReport} onPrintReport={(poll, results) => preparePrintReport([{ poll, results }])}
            loadResults={loadResults} resultData={resultData} resultState={resultState} resultUpdatedAt={resultUpdatedAt} detailError={detailError} now={tick} awsMode={awsMode} onExportBackup={awsMode ? undefined : (passphrase) => backend.createEncryptedBackup(passphrase)} backupAllowed={canUseLocalOnlyFeatures(configuredApiMode) && (accountMode || googleMode)}/>
        }
        </>}
      </div>
    </main>

    {editor && <PollEditor editor={editor} draft={draft} setDraft={setDraft} busy={busy} formError={formError} close={() => setEditor(null)} save={savePoll}/>}
    {confirmation && <ConfirmDialog {...confirmation} busy={busy} close={() => setConfirmation(null)} confirm={async () => { await confirmation.run(); setConfirmation(null) }}/>}
    {sharingPoll && canSharePoll(sharingPoll) && <SharePollDialog poll={sharingPoll} url={sharingUrl} onCopy={() => copyPollLink(sharingPoll.id)} onClose={() => { setSharingPoll(null); setSharingUrl('') }}/>}
    {commandPaletteOpen && hasAdminAccess && <AdminCommandPalette commands={adminCommands} onClose={() => setCommandPaletteOpen(false)}/>}
    {printReports && <PrintableReports reports={printReports}/>}
  </div>
}

function SharePollDialog({ poll, url, onCopy, onClose }) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 300, color: { dark: '#172554', light: '#ffffff' } })
      .then((value) => { if (!cancelled) setQrDataUrl(value) })
      .catch(() => { if (!cancelled) setError('QR code could not be generated. You can still copy the voter link.') })
    return () => { cancelled = true }
  }, [url])
  return <div className="admin-share-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <section className="admin-share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-poll-title">
      <div className="admin-share-heading"><div><span className="eyebrow">POLL SHARING</span><h2 id="share-poll-title">Share this poll</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close sharing dialog">×</button></div>
      <p className="admin-share-question">{poll.question}</p>
      <div className="admin-share-link"><a href={url} target="_blank" rel="noreferrer">{url}</a><button type="button" className="button button-primary" onClick={onCopy}>Copy link</button></div>
      {isLoopbackVoterUrl(url) && <p className="admin-share-local-note" role="note">This is a localhost link. It works only on this computer, so someone scanning the QR code on another device cannot reach your app. Set <code>VITE_APP_ORIGIN</code> to a reachable application origin before sharing with others.</p>}
      <div className="admin-share-qr-area">{qrDataUrl ? <img src={qrDataUrl} alt={`QR code for ${poll.question}`} width="210" height="210"/> : error ? <p role="alert">{error}</p> : <p role="status">Generating QR code…</p>}</div>
      <div className="admin-share-actions"><button type="button" className="button button-outline" onClick={onClose}>Close</button>{qrDataUrl && <a className="button button-primary" href={qrDataUrl} download={`ballot-poll-${poll.id}-qr.png`}>Download QR code</a>}</div>
    </section>
  </div>
}

function PrintableReports({ reports }) {
  return createPortal(<article className="admin-print-report">
    <header className="print-report-header"><div className="print-report-brand">ballot<span>.</span></div><h1>Voting results report</h1><p>Generated {new Date().toLocaleString()}</p></header>
    {reports.map(({ poll, results }) => <section className="print-report-poll" key={poll.id}>
      <h2>{poll.question}</h2>
      <dl className="print-report-meta"><div><dt>Status</dt><dd>{STATUS_LABEL[poll.status] || poll.status}</dd></div><div><dt>Format</dt><dd>{formatVotingType(poll.votingType)}</dd></div><div><dt>Total ballots</dt><dd>{results.ballotCount}</dd></div><div><dt>Created</dt><dd>{formatReportTimestamp(poll.createdAt)}</dd></div><div><dt>Started</dt><dd>{formatReportTimestamp(poll.startedAt)}</dd></div><div><dt>Ends</dt><dd>{formatReportTimestamp(poll.endsAt)}</dd></div><div><dt>Updated</dt><dd>{formatReportTimestamp(poll.updatedAt)}</dd></div></dl>
      {results.method === 'instant_runoff' ? <>
        <p className="print-report-outcome">Outcome: {results.outcome === 'winner' ? `Winner — ${results.winnerLabel}` : results.outcome}</p>
        {(results.rounds || []).map((round) => <div className="print-report-round" key={round.round}><h3>Round {round.round}</h3><p>{round.continuingBallots} continuing · {round.exhaustedBallots} exhausted</p><table><thead><tr><th>Candidate</th><th>Votes</th><th>Share</th><th>Round status</th></tr></thead><tbody>{round.tallies.map((tally) => <tr key={tally.optionId}><td>{tally.label}</td><td>{tally.votes}</td><td>{round.continuingBallots ? `${(tally.votes / round.continuingBallots * 100).toFixed(1)}%` : '0%'}</td><td>{round.eliminatedOptionId === tally.optionId ? 'Eliminated' : round.tiedLowestOptionIds?.includes(tally.optionId) ? 'Tied lowest' : results.winnerOptionId === tally.optionId && round.round === results.rounds.length ? 'Winner' : 'Continuing'}</td></tr>)}</tbody></table></div>)}
      </> : <table><thead><tr><th>Option</th><th>Votes</th><th>Percentage</th></tr></thead><tbody>{(results.options || []).map((option) => <tr key={option.id || option.optionId}><td>{option.label}</td><td>{option.count}</td><td>{Number(option.percentage ?? (results.ballotCount ? option.count / results.ballotCount * 100 : 0)).toFixed(1)}%</td></tr>)}</tbody></table>}
    </section>)}
  </article>, document.body)
}

function formatReportTimestamp(value) {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function LocalHealthIndicator() {
  const [health, setHealth] = useState({ state: 'checking', mode: '' })
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const result = await checkLocalApiHealth()
        if (!cancelled) setHealth({ state: 'healthy', mode: result.mode })
      } catch {
        if (!cancelled) setHealth({ state: 'unavailable', mode: '' })
      }
    }
    check()
    const timer = window.setInterval(check, 30_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  const label = health.state === 'healthy' ? 'Local API healthy' : health.state === 'checking' ? 'Checking local API' : 'Local API unavailable'
  return <span className={`connection-pill local-health ${health.state}`} title={health.state === 'healthy' ? `Local development API · ${health.mode} · does not indicate AWS connectivity` : 'Checks the local development backend only'} aria-label={`${label}. This status covers the local backend only.`}><i/>{label}</span>
}

function AdminCommandPalette({ commands, onClose }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const input = useRef(null)
  const filtered = useMemo(() => filterAdminCommands(commands, query), [commands, query])
  useEffect(() => { input.current?.focus() }, [])
  const runActive = (command = filtered[activeIndex]) => {
    if (!command) return
    onClose()
    command.run()
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    else if (event.key === 'ArrowDown' && filtered.length) { event.preventDefault(); setActiveIndex((index) => (index + 1) % filtered.length) }
    else if (event.key === 'ArrowUp' && filtered.length) { event.preventDefault(); setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length) }
    else if (event.key === 'Enter') { event.preventDefault(); runActive() }
  }

  return <div className="admin-command-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} onKeyDown={onKeyDown}>
    <section className="admin-command-palette" role="dialog" aria-modal="true" aria-labelledby="admin-command-title">
      <h2 id="admin-command-title" className="sr-only">Admin command palette</h2>
      <label className="admin-command-search"><span aria-hidden="true">⌕</span><input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }} placeholder="Search polls or jump to a section…" aria-label="Search admin commands" aria-controls="admin-command-list" aria-activedescendant={filtered[activeIndex] ? `admin-command-${activeIndex}` : undefined}/><kbd>ESC</kbd></label>
      <div className="admin-command-list" id="admin-command-list" role="listbox" aria-label="Admin commands">
        {filtered.length ? filtered.map((command, index) => <button type="button" role="option" id={`admin-command-${index}`} aria-selected={index === activeIndex} className={`admin-command-option ${index === activeIndex ? 'active' : ''}`} key={command.id} onMouseEnter={() => setActiveIndex(index)} onClick={() => runActive(command)}><span className="admin-command-symbol" aria-hidden="true">{command.hint === 'Poll' ? '▤' : command.hint === 'Action' ? '+' : '↗'}</span><span className="admin-command-label">{command.label}</span><small>{command.hint}</small></button>) : <p className="admin-command-empty">No matching polls or commands.</p>}
      </div>
      <footer className="admin-command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
    </section>
  </div>
}

function GoogleAuthPanel({ awsMode = false, clientId, state, error, onCredential }) {
  const button = useRef(null)
  const [scriptError, setScriptError] = useState('')
  useEffect(() => {
    if (!clientId || !button.current) return undefined
    let script = document.querySelector('script[data-ballot-google-identity]')
    const render = () => {
      const googleIdentity = window.google?.accounts?.id
      if (!googleIdentity || !button.current) return false
      button.current.replaceChildren()
      googleIdentity.initialize({
        client_id: clientId,
        callback: (response) => {
          if (!response?.credential) setScriptError('Google did not return an identity token. Please try again.')
          else onCredential(response.credential)
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      })
      googleIdentity.renderButton(button.current, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: 280 })
      return true
    }
    if (render()) return undefined
    if (!script) {
      script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.dataset.ballotGoogleIdentity = 'true'
      document.head.append(script)
    }
    const handleLoad = () => { if (!render()) setScriptError('Google Sign-In could not initialize in this browser.') }
    const handleError = () => setScriptError('Google Sign-In could not load. Check the network and try again.')
    script.addEventListener('load', handleLoad)
    script.addEventListener('error', handleError)
    return () => {
      script?.removeEventListener('load', handleLoad)
      script?.removeEventListener('error', handleError)
    }
  }, [clientId, onCredential])

  return <section className="google-auth-panel" aria-labelledby="google-auth-title">
    <span className="auth-eyebrow">BALLOT ACCOUNT</span>
    <h1 id="google-auth-title">Sign in to continue</h1>
    <p>Use your Google account to access voter features. Administrator access is assigned by the backend configuration, not by this page.</p>
    {!clientId ? <div className="auth-message" role="alert">Set VITE_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_ID in your local environment before enabling Google mode.</div>
      : <div ref={button} className="google-signin-button" aria-label="Sign in with Google"/>}
    {(state === 'loading') && <p className="auth-status" role="status">{awsMode ? 'Verifying your Google identity with the configured HTTP API…' : 'Verifying your Google identity with the local backend…'}</p>}
    {(error || scriptError) && <p className="auth-message" role="alert">{error || scriptError}</p>}
    <p className="auth-footnote">{awsMode ? 'AWS mode is opt-in. The configured HTTP API must be deployed and its OAuth audience must match this Google client ID.' : 'Development mode: the local backend verifies Google token signatures and claims, but poll data remains in memory on this machine.'}</p>
  </section>
}

function NavLink({ active, onClick, children }) {
  return <button className={`nav-link ${active ? 'selected' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}><span className="nav-indicator" aria-hidden="true"/><span className="nav-label">{children}</span></button>
}

function AdminPages(props) {
  const { route, navigate, polls, visiblePolls, counts, totalVotes, dashboardStats, apiState, busy, search, setSearch, statusFilter, setStatusFilter, now,
    openEditor, startPoll, closePoll, reopenPoll, deletePoll, copyPollLink, sharePoll, selectedPollIds, setSelectedPollIds, onBulkClose, onBulkExport, reportBusy, onExportReport, onPrintReport,
    loadResults, resultData, resultState, resultUpdatedAt, detailError, onExportBackup, backupAllowed, awsMode } = props
  const detailPoll = polls.find((poll) => poll.id === route.pollId) || null

  if (route.page === 'poll' && !detailPoll) return <LoadState state={apiState} error={detailError} retry={() => navigate('/admin/polls')} label="poll"/>
  if (route.page === 'results') return <ResultsPage poll={detailPoll} pollId={route.pollId} navigate={navigate} loadResults={loadResults} resultData={resultData} resultState={resultState} resultUpdatedAt={resultUpdatedAt?.[route.pollId]} now={now}/>
  if (route.page === 'analytics') return <AnalyticsPage polls={polls} totalVotes={totalVotes} counts={counts} state={apiState} navigate={navigate} openEditor={openEditor} now={now}/>
  if (route.page === 'poll') return <PollDetail awsMode={awsMode} poll={detailPoll} navigate={navigate} openEditor={openEditor} startPoll={startPoll} closePoll={closePoll} reopenPoll={reopenPoll} deletePoll={deletePoll} copyPollLink={copyPollLink} loadResults={loadResults} resultData={resultData} resultState={resultState} busy={busy} now={now}/>

  const latest = [...polls].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)).slice(0, 4)
  const overview = route.page === 'overview'
  return <>
    <PageHeading eyebrow={overview ? 'CAMPUS WORKSPACE' : 'POLL OPERATIONS'} title={overview ? 'A clearer view of campus voice.' : 'Poll management'} description={overview ? 'Create thoughtful questions and follow participation as it happens.' : 'Create, organize, and manage your campus polls.'} action={<button className="button button-primary" onClick={() => openEditor()}>＋ <span>Create poll</span></button>}/>
    {overview && <>
      <section id="admin-dashboard" className="admin-unified-dashboard admin-unified-section" aria-label="Dashboard summary">
        <section className="metric-grid" aria-label="Poll statistics">
          <Metric label="Total votes" value={apiState === 'ready' ? totalVotes.toLocaleString() : '—'} note={awsMode ? "Accepted by DynamoDB-backed API" : "Accepted by local backend"} icon="↗" tone="violet"/>
          <Metric label="Active polls" value={apiState === 'ready' ? (dashboardStats?.activePollCount ?? counts.active ?? 0).toLocaleString() : '—'} note="Currently accepting votes" icon="◉" tone="mint"/>
          <Metric label="Closed polls" value={apiState === 'ready' ? ((counts.closed || 0) + (counts.expired || 0)).toLocaleString() : '—'} note="Closed or ended" icon="✓" tone="amber"/>
          <Metric label="All polls" value={apiState === 'ready' ? (dashboardStats?.pollCount ?? polls.length).toLocaleString() : '—'} note="From the configured backend" icon="▤" tone="blue"/>
        </section>
        <section className="dashboard-grid">
          <div className="surface recent-surface"><SectionHeader eyebrow="RECENT ACTIVITY" title="Recently updated" action={<button className="text-button" onClick={() => document.getElementById('admin-polls')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}>View all polls ↓</button>}/>
            {apiState === 'loading' ? <InlineState>Loading polls…</InlineState> : latest.length ? <div className="recent-list">{latest.map((poll) => <RecentPoll key={poll.id} poll={poll} onClick={() => navigate(`/admin/polls/${poll.id}`)} now={now}/>)}</div> : <EmptyState title="No polls yet" description="Your polls will appear here after you create one." action={<button className="button button-outline" onClick={() => openEditor()}>Create your first poll</button>}/>}
          </div>
          <div className="surface quick-surface"><SectionHeader eyebrow="QUICK START" title="Bring a question to the table"/><p className="quick-copy">Set clear options, choose when results appear, and open the poll when you are ready.</p><button className="button button-primary full-button" onClick={() => openEditor()}>＋ Create a new poll</button><div className="quick-note"><span className="note-mark">i</span><p>{awsMode ? 'AWS polls and ballots are stored in DynamoDB.' : 'Local development mode. Polls and votes are held in backend memory and reset when it restarts.'}</p></div></div>
        </section>
      </section>
      <PollManagementSection id="admin-polls" polls={polls} visiblePolls={visiblePolls} apiState={apiState} search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter} now={now} navigate={navigate} openEditor={openEditor} startPoll={startPoll} closePoll={closePoll} reopenPoll={reopenPoll} deletePoll={deletePoll} sharePoll={sharePoll} selectedPollIds={selectedPollIds} setSelectedPollIds={setSelectedPollIds} onBulkClose={onBulkClose} onBulkExport={onBulkExport} reportBusy={reportBusy} busy={busy}/>
      <section id="admin-analytics" className="surface admin-unified-section admin-unified-analytics"><SectionHeader eyebrow="ADMIN ANALYTICS" title="Analytics"/><AnalyticsPage polls={polls} totalVotes={totalVotes} counts={counts} state={apiState} navigate={navigate} openEditor={openEditor} now={now} embedded/></section>
      <AdminBackupCard allowed={backupAllowed} awsMode={awsMode} onExport={onExportBackup}/>
      <AdminResultsSection id="admin-results" polls={polls} now={now} resultData={resultData} resultState={resultState} resultUpdatedAt={resultUpdatedAt} loadResults={loadResults} apiState={apiState} onExportReport={onExportReport} onPrintReport={onPrintReport}/>
      {canUseLocalOnlyFeatures(configuredApiMode) && <AdminChatSection apiState={apiState}/>}
    </>}
    {!overview && <PollManagementSection id="admin-polls" polls={polls} visiblePolls={visiblePolls} apiState={apiState} search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter} now={now} navigate={navigate} openEditor={openEditor} startPoll={startPoll} closePoll={closePoll} reopenPoll={reopenPoll} deletePoll={deletePoll} sharePoll={sharePoll} selectedPollIds={selectedPollIds} setSelectedPollIds={setSelectedPollIds} onBulkClose={onBulkClose} onBulkExport={onBulkExport} reportBusy={reportBusy} busy={busy}/>}
  </>
}

function AdminBackupCard({ allowed, awsMode = false, onExport }) {
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setResult(null)
    if (!allowed) { setError('Full-data backup is unavailable in development/mock authentication mode.'); return }
    if (passphrase.length < 16) { setError('Use a passphrase with at least 16 characters.'); return }
    if (passphrase !== confirmation) { setError('The passphrases do not match.'); return }
    setBusy(true)
    try { const response = await onExport(passphrase); setResult(response.backup) }
    catch (requestError) { setError(requestError.message || 'The encrypted backup could not be created.') }
    finally { setPassphrase(''); setConfirmation(''); setBusy(false) }
  }
  if (awsMode) return <section className="surface admin-unified-section admin-backup-card" aria-label="Local encrypted backup"><SectionHeader eyebrow="LOCAL-ONLY FEATURE" title="Encrypted backup unavailable"/><p className="admin-backup-warning" role="status">Encrypted export is provided only by the local backend. It is disabled in AWS HTTP API mode.</p></section>
  return <section className="surface admin-unified-section admin-backup-card" aria-label="Encrypted full backup">
    <SectionHeader eyebrow="LOCAL DATA PROTECTION" title="Encrypted full backup"/>
    <p className="admin-backup-copy">Create a new encrypted JSON snapshot of poll definitions, vote counts, and individual ballot records. Exporting does not modify application data.</p>
    {!allowed && <p className="admin-backup-warning" role="status">Available only with verified account or allowlisted Google Admin authentication. Development/mock authentication is rejected by the backend.</p>}
    <p className="admin-backup-warning">Ballot identity keys are included inside the encrypted payload to preserve duplicate-vote state on restore. Keep the passphrase separately from the backup file. Never use a passphrase you use for another account.</p>
    <form className="admin-backup-form" onSubmit={submit}>
      <label>Backup passphrase<input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={16} maxLength={1024} autoComplete="new-password" required disabled={!allowed || busy} /></label>
      <label>Confirm passphrase<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={16} maxLength={1024} autoComplete="new-password" required disabled={!allowed || busy} /></label>
      <button className="button button-primary" type="submit" disabled={!allowed || busy}>{busy ? 'Encrypting and saving…' : 'Create encrypted backup'}</button>
    </form>
    {error && <p className="admin-backup-error" role="alert">{error}</p>}
    {result && <div className="admin-backup-success" role="status"><b>Encrypted backup saved.</b><span>.local-data/backups/{result.filename}</span><span>{result.pollCount} polls · {result.ballotCount} ballots · SHA-256 {result.sha256}</span><p>Run <code>npm.cmd run backup:validate -- ".local-data/backups/{result.filename}"</code> before restarting the backend.</p></div>}
    <p className="admin-backup-footnote">The passphrase is sent only to this same-origin local backend request and is not saved or logged. The backup file contains encrypted data only. This export has no restore operation.</p>
  </section>
}
function PollManagementSection({ id, polls, visiblePolls, apiState, search, setSearch, statusFilter, setStatusFilter, now, navigate, openEditor, startPoll, closePoll, reopenPoll, deletePoll, sharePoll, selectedPollIds, setSelectedPollIds, onBulkClose, onBulkExport, reportBusy, busy }) {
  const actions = { edit: openEditor, start: startPoll, close: closePoll, reopen: reopenPoll, delete: deletePoll, share: sharePoll }
  const selectedPolls = polls.filter((poll) => selectedPollIds.includes(poll.id))
  const activeSelected = selectedPolls.filter((poll) => pollStatus(poll, now) === 'active')
  const selectedVisibleCount = visiblePolls.filter((poll) => selectedPollIds.includes(poll.id)).length
  const allVisibleSelected = visiblePolls.length > 0 && selectedVisibleCount === visiblePolls.length
  return <section id={id} className="surface management-surface admin-unified-section">
    <SectionHeader eyebrow="POLL OPERATIONS" title="Poll management" action={<button className="button button-primary" onClick={() => openEditor()}>＋ Create poll</button>}/>
    <div className="toolbar"><label className="search-control"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search polls" aria-label="Search polls"/></label><label className="select-control"><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="active">Live</option><option value="draft">Draft</option><option value="closed">Closed</option><option value="expired">Ended</option></select></label><span className="toolbar-count">{apiState === 'ready' ? `${visiblePolls.length} of ${polls.length} polls` : '—'}</span></div>
    {apiState === 'ready' && <div className="admin-bulk-toolbar"><label className="admin-select-all"><input type="checkbox" aria-label="Select all filtered polls" checked={allVisibleSelected} ref={(node) => { if (node) node.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected }} onChange={() => setSelectedPollIds((current) => toggleVisiblePollSelection(current, visiblePolls.map((poll) => poll.id)))}/><span>Select filtered ({visiblePolls.length})</span></label><div className="admin-bulk-actions">{selectedPolls.length > 0 && <><span className="admin-selected-count">{selectedPolls.length} selected</span><button className="button button-outline" type="button" disabled={busy || reportBusy} onClick={() => setSelectedPollIds([])}>Clear selection</button><button className="button button-outline" type="button" disabled={!activeSelected.length || reportBusy || busy} onClick={() => onBulkClose(selectedPolls)}>Close active ({activeSelected.length})</button><button className="button button-outline" type="button" disabled={reportBusy || busy} onClick={() => onBulkExport(selectedPolls)}>{reportBusy ? 'Preparing CSV…' : 'Export results CSV'}</button></>}</div></div>}
    {apiState === 'loading' ? <InlineState>Loading polls…</InlineState> : apiState === 'error' ? <InlineState tone="error">Polls could not be loaded. Retry using the connection notice above.</InlineState> : <PollTable polls={visiblePolls} now={now} navigate={navigate} emptyAction={() => openEditor()} actions={actions} selectedPollIds={selectedPollIds} setSelectedPollIds={setSelectedPollIds}/>}
  </section>
}

function AdminResultsSection({ id, polls, now, resultData, resultState, resultUpdatedAt, loadResults, apiState, onExportReport, onPrintReport }) {
  const resultPolls = polls.filter((poll) => pollStatus(poll, now) !== 'draft')
  const [selectedPollId, setSelectedPollId] = useState('')
  const preferredPollId = resultPolls.find((poll) => poll.voteCount > 0)?.id || resultPolls[0]?.id || ''
  const activePollId = resultPolls.some((poll) => poll.id === selectedPollId) ? selectedPollId : preferredPollId
  const selectedPoll = resultPolls.find((poll) => poll.id === activePollId) || null
  const state = activePollId ? resultState[activePollId] : undefined
  const results = activePollId ? resultData[activePollId] : null

  useEffect(() => {
    if (selectedPoll && !resultData[selectedPoll.id] && !resultState[selectedPoll.id]) loadResults(selectedPoll.id)
  }, [selectedPoll, resultData, resultState, loadResults])

  return <section id={id} className="surface admin-unified-section admin-unified-results">
    <SectionHeader eyebrow="BACKEND RESULTS" title="Poll results" action={results && selectedPoll && <div className="admin-report-actions"><button className="button button-outline" onClick={() => loadResults(selectedPoll.id, { silent: true })} disabled={state === 'loading'}>↻ Refresh results</button><button className="button button-outline" onClick={() => onExportReport(selectedPoll, results)} disabled={state === 'loading'}>Export CSV</button><button className="button button-outline" onClick={() => onPrintReport(selectedPoll, results)} disabled={state === 'loading'}>Print / Save as PDF</button></div>}/>
    {apiState === 'error' ? <InlineState tone="error">Results are unavailable because the backend could not be reached.</InlineState> : !resultPolls.length ? <EmptyState title="No started polls" description="Start a poll to make its results available here."/> : <>
      <div className="admin-results-picker" role="group" aria-label="Choose poll results">
        {resultPolls.map((poll) => <button type="button" key={poll.id} className={poll.id === activePollId ? 'selected' : ''} aria-pressed={poll.id === activePollId} onClick={() => { setSelectedPollId(poll.id); if (!resultData[poll.id] && !resultState[poll.id]) loadResults(poll.id) }}><b>{poll.question}</b><span>{poll.voteCount} accepted {poll.voteCount === 1 ? 'ballot' : 'ballots'}</span><StatusBadge status={pollStatus(poll, now)}/></button>)}
      </div>
      {selectedPoll && results ? <div className="results-layout admin-unified-result-detail"><ResultsCard poll={selectedPoll} results={results}/><article className="surface analytics-summary"><SectionHeader eyebrow="POLL SUMMARY" title="Participation"/><div className="detail-vote-total"><strong>{results.ballotCount}</strong><span>accepted ballots</span></div><DetailLine label="Voting format" value={formatVotingType(selectedPoll.votingType)}/><DetailLine label="Result visibility" value={selectedPoll.visibility}/><DetailLine label="Status" value={STATUS_LABEL[pollStatus(selectedPoll, now)]}/><DetailLine label="Last loaded" value={resultUpdatedAt[selectedPoll.id] ? new Date(resultUpdatedAt[selectedPoll.id]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Not available'}/></article></div>
        : selectedPoll && <div className="admin-results-state" aria-live="polite">{state === 'loading' ? <InlineState>Loading results from the backend…</InlineState> : state === 'hidden' ? <InlineState>Results are hidden by this poll’s visibility rules.</InlineState> : <InlineState tone="error">Results could not be loaded. <button className="text-button" onClick={() => loadResults(selectedPoll.id)}>Try again</button></InlineState>}</div>}
      <p className="admin-results-note">Results are loaded from the existing backend endpoint. Ranked-choice polls show the backend’s round-by-round IRV tally when available.</p>
    </>}
  </section>
}

function AdminChatSection({ apiState }) {
  const [rooms, setRooms] = useState([])
  const [selectedPollId, setSelectedPollId] = useState('')
  const [messages, setMessages] = useState([])
  const [streamStatus, setStreamStatus] = useState('connecting')
  const [busyMessageId, setBusyMessageId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState(null)
  const selectedRoom = rooms.find((room) => room.pollId === selectedPollId)
  const selectedRoomId = selectedRoom?.pollId
  const [loadedRoomId, setLoadedRoomId] = useState('')

  useEffect(() => {
    let cancelled = false
    const refreshRooms = () => localChatApi.listRooms().then(({ rooms: next }) => {
      if (!cancelled) {
        setRooms(next)
        setSelectedPollId((current) => next.some((room) => room.pollId === current) ? current : next[0]?.pollId || '')
      }
    }).catch((requestError) => { if (!cancelled) setError(requestError.message || 'Chat rooms could not be loaded.') })
    refreshRooms()
    const stream = localChatApi.streamAdmin({
      onStatus: (status) => { if (!cancelled) setStreamStatus(status) },
      onError: (requestError) => { if (!cancelled) setError(requestError.message || 'Admin chat stream failed.') },
      onMessage: (event) => {
        if (cancelled) return
        if (event.type === 'chat.message') {
          setRooms((current) => current.map((room) => room.pollId === event.pollId ? { ...room, messageCount: room.messageCount + 1, lastMessageAt: event.message.createdAt } : room))
          if (event.pollId === selectedPollId) setMessages((current) => current.some((message) => message.id === event.message.id) ? current : [...current, event.message])
        }
        if (event.type === 'chat.hidden' || event.type === 'chat.restored') {
          if (event.pollId === selectedPollId) localChatApi.listAdminMessages(selectedPollId).then(({ messages: next }) => setMessages(next)).catch(() => {})
          refreshRooms()
        }
      },
    })
    return () => { cancelled = true; stream.abort() }
  }, [selectedPollId])

  useEffect(() => {
    if (!selectedRoomId) return undefined
    let cancelled = false
    localChatApi.listAdminMessages(selectedRoomId).then(({ messages: next }) => { if (!cancelled) { setMessages(next); setLoadedRoomId(selectedRoomId); setError('') } }).catch((requestError) => { if (!cancelled) setError(requestError.message || 'Messages could not be loaded.') })
    return () => { cancelled = true }
  }, [selectedRoomId])

  const moderate = async (message) => {
    const action = message.hidden ? 'restore' : 'hide'
    if (confirm !== message.id) { setConfirm(message.id); return }
    setBusyMessageId(message.id)
    setError('')
    setNotice('')
    try {
      const { message: updated } = await localChatApi.moderate(selectedPollId, message.id, action)
      setMessages((current) => current.map((item) => item.id === updated.id ? updated : item))
      setNotice(action === 'hide' ? 'Message hidden from voter chat. Moderation action recorded.' : 'Message restored to voter chat. Moderation action recorded.')
      setConfirm(null)
    } catch (requestError) { setError(requestError.message || 'Moderation was rejected by the backend.') }
    finally { setBusyMessageId('') }
  }

  return <section id="admin-chat" className="surface admin-unified-section admin-chat-section">
    <SectionHeader eyebrow="MODERATION" title="Live chat" action={<span className={'chat-connection chat-' + streamStatus} role="status"><i/>{streamStatus === 'connected' ? 'Live connection' : streamStatus === 'reconnecting' ? 'Reconnecting' : streamStatus}</span>}/>
    <p className="chat-disclaimer">Monitor messages in active and closed voter polls. Draft polls are not exposed. Chat is stored separately from ballots and results.</p>
    {error && <p className="chat-error" role="alert">{error}</p>}{notice && <p className="chat-success" role="status">{notice}</p>}
    {apiState === 'loading' ? <InlineState>Loading poll list…</InlineState> : !rooms.length ? <EmptyState title="No chat rooms yet" description="Active and closed polls will appear here. A room is created automatically when its first message is sent."/> : <>
      <label className="admin-chat-picker">Poll room<select value={selectedPollId} onChange={(event) => { setSelectedPollId(event.target.value); setConfirm(null) }}>{rooms.map((room) => <option value={room.pollId} key={room.pollId}>{room.question} · {room.messageCount} messages · {STATUS_LABEL[room.status]}</option>)}</select></label>
      <div className="admin-chat-feed" aria-live="polite">{loadedRoomId !== selectedRoomId ? <InlineState>Loading chat history…</InlineState> : messages.length ? messages.map((message) => <article className={'admin-chat-message' + (message.hidden ? ' is-hidden' : '')} key={message.id}>
        <div className="admin-chat-message-body"><div className="chat-message-head"><b>{message.sender}</b><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time></div><p>{message.text}</p>{message.hidden && <small>Hidden from voters</small>}</div>
        <div className="admin-chat-moderation"><button className="button button-outline" type="button" disabled={busyMessageId === message.id} onClick={() => moderate(message)}>{confirm === message.id ? (message.hidden ? 'Confirm restore' : 'Confirm hide') : message.hidden ? 'Restore' : 'Hide'}</button>{confirm === message.id && <button className="text-button" type="button" onClick={() => setConfirm(null)}>Cancel</button>}</div>
      </article>) : <p className="chat-empty">No messages in this poll room.</p>}</div>
    </>}
  </section>
}

function VoterTopNav({ route, active, navigate, apiState, identity, googleMode, accountMode, canAccessAdmin, signOut }) {
  const name = identity?.username || identity?.name || identity?.email || (googleMode ? 'Sign in required' : 'Voter preview')
  const initial = name.slice(0, 1).toUpperCase()
  return <header className="voter-top-nav">
    <div className="voter-nav-inner">
      <a className="voter-brand" href="/vote" onClick={(event) => { event.preventDefault(); navigate('/vote') }} aria-label="Ballot voter home">
        <span className="voter-brand-mark" aria-hidden="true"><i/><i/><i/></span><span>ballot<span className="voter-brand-period">.</span><small>Campus voice, together.</small></span>
      </a>
      <nav className="voter-primary-nav" aria-label="Voter navigation">
        <button className={route.page === 'home' ? 'active' : ''} aria-current={route.page === 'home' ? 'page' : undefined} onClick={() => navigate('/vote')}>Discover polls</button>
        {active && <button className={route.page === 'poll' ? 'active' : ''} aria-current={route.page === 'poll' ? 'page' : undefined} onClick={() => navigate(`/poll/${active.id}`)}>Current poll</button>}
      </nav>
      <div className="voter-nav-account">
        <span className={`voter-connection-state ${apiState}`}><i aria-hidden="true"/>{apiState === 'ready' ? 'API ready' : apiState === 'loading' ? 'Checking' : 'Offline'}</span>
        <span className="voter-account-avatar" aria-hidden="true">{initial}</span>
        <span className="voter-account-name">{name}</span>
        <span className="voter-role-badge">{identity?.role === 'admin' ? 'Admin' : 'Voter'}</span>
        {!googleMode && !accountMode && canAccessAdmin && <button className="voter-admin-link" onClick={() => navigate('/admin')}>Admin preview <span aria-hidden="true">↗</span></button>}
        {googleMode && identity?.isAdmin && <button className="voter-admin-link" onClick={() => navigate('/admin')}>Admin workspace <span aria-hidden="true">↗</span></button>}
        {(googleMode || accountMode) && identity && <button className="voter-signout" onClick={signOut}>Sign out</button>}
      </div>
    </div>
  </header>
}

function VoterPages(props) {
  const { route, navigate, polls, statusAt, secondsLeft, active, activeResults, resultState, loadResults, voted, voteCheckState, selected, setSelected, setConfirmation, busy, identity, accountMode, googleMode, awsMode,
    submitVote, detailError, apiState, apiError, refreshPolls } = props
  const [chatMessages, setChatMessages] = useState([])
  const [chatText, setChatText] = useState('')
  const [chatStatus, setChatStatus] = useState('connecting')
  const [chatLoadedPollId, setChatLoadedPollId] = useState('')
  const [chatError, setChatError] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const activeChatStatus = active ? statusAt(active) : ''
  const activePollId = active?.id
  useEffect(() => {
    if (!canUseLocalOnlyFeatures(configuredApiMode) || route.page !== 'poll' || !activePollId || activeChatStatus === 'draft') return undefined
    let cancelled = false
    const stream = localChatApi.streamPoll(activePollId, {
      onStatus: (status) => { if (!cancelled) setChatStatus(status) },
      onError: (error) => { if (!cancelled) setChatError(error.message || 'Chat connection failed.') },
      onMessage: (event) => {
        if (cancelled) return
        if (event.type === 'chat.message' && event.message) setChatMessages((items) => items.some((item) => item.id === event.message.id) ? items : [...items, event.message].sort((a, b) => a.createdAt - b.createdAt))
        if (event.type === 'chat.hidden') setChatMessages((items) => items.filter((item) => item.id !== event.messageId))
        if (event.type === 'chat.restored') localChatApi.listPollMessages(activePollId).then(({ messages }) => setChatMessages(messages)).catch(() => {})
      },
    })
    localChatApi.listPollMessages(activePollId).then(({ messages }) => { if (!cancelled) { setChatMessages((current) => [...new Map([...current, ...messages].map((message) => [message.id, message])).values()].sort((a, b) => a.createdAt - b.createdAt)); setChatLoadedPollId(activePollId); setChatError('') } }).catch((error) => { if (!cancelled) { setChatError(error.message); setChatStatus('error') } })
    return () => { cancelled = true; stream.abort() }
  }, [activePollId, activeChatStatus, route.page, awsMode])
  const sendPollChatMessage = async (event) => {
    event.preventDefault()
    const text = chatText.trim()
    if (!canUseLocalOnlyFeatures(configuredApiMode) || !active || !text || chatSending || ['closed', 'expired'].includes(statusAt(active))) return
    setChatSending(true)
    setChatError('')
    try { await localChatApi.sendPollMessage(active.id, text); setChatText('') }
    catch (error) { setChatError(error.message || 'Message could not be sent.') }
    finally { setChatSending(false) }
  }
  const [filter, setFilter] = useState('available')
  const [query, setQuery] = useState('')
  const voterPolls = polls.filter((poll) => ['active', 'closed', 'expired'].includes(statusAt(poll)))
  const available = voterPolls.filter((poll) => statusAt(poll) === 'active')
  const closed = voterPolls.filter((poll) => ['closed', 'expired'].includes(statusAt(poll)))
  const closingSoon = available.filter((poll) => isClosingSoon(poll, statusAt(poll)))
  const pollCounts = {
    all: voterPolls.length,
    available: available.filter((poll) => voted[poll.id] !== true).length,
    active: available.length,
    closingSoon: closingSoon.length,
    completed: closed.length,
    voted: polls.filter((poll) => voted[poll.id] === true).length,
  }
  const visiblePolls = voterPolls.filter((poll) => {
    const status = statusAt(poll)
    const matchesFilter = filter === 'all'
      || (filter === 'available' && status === 'active' && voted[poll.id] !== true)
      || (filter === 'active' && status === 'active')
      || (filter === 'closingSoon' && isClosingSoon(poll, status))
      || (filter === 'completed' && ['closed', 'expired'].includes(status))
      || (filter === 'voted' && voted[poll.id] === true)
    const matchesQuery = matchesVoterPoll(poll, query)
    return matchesFilter && matchesQuery
  })
  const historyChecking = voterPolls.some((poll) => voteCheckState[poll.id] === undefined || voteCheckState[poll.id] === 'loading')
  const historyError = voterPolls.some((poll) => voteCheckState[poll.id] === 'error')
  const voterName = identity?.username || identity?.name || identity?.email
  const emptyState = voterEmptyState({ query, filter, historyError })
  if (route.page === 'home') return <>
    <section className="voter-hero">
      <div className="voter-hero-copy"><span className="voter-hero-kicker"><i/> CAMPUS VOICE, MADE COUNT</span><h1>{voterName ? <>Welcome back, <em>{voterName}.</em></> : <>Good decisions start with <em>your voice.</em></>}</h1><p>Explore campus polls, weigh your options, and cast your vote. Every poll shows its rules before you submit.</p><div className="voter-hero-proof"><span><b>{apiState === 'ready' ? available.length : '—'}</b> open polls</span><span><b>{apiState === 'ready' ? voterPolls.length : '—'}</b> listed polls</span></div></div>
      <div className="voter-hero-art" aria-hidden="true"><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/><div className="hero-check-card"><span className="hero-check-icon">✓</span><div><b>Your vote matters</b><small>One poll at a time</small></div><span className="hero-check-arrow">↗</span></div><span className="hero-spark spark-one">✦</span><span className="hero-spark spark-two">✳</span><span className="hero-pill">Make it count</span></div>
    </section>
    {apiState === 'loading' ? <section className="voter-skeleton-section" aria-label="Loading available polls" aria-busy="true"><div className="voter-skeleton-heading"><i/><i/></div><div className="voter-skeleton-grid">{[0, 1, 2].map((item) => <div className="voter-skeleton-card" key={item}><i/><i/><i/><i/></div>)}</div><span className="sr-only">Loading polls…</span></section> : apiState === 'error' ? <div className="voter-error-panel" role="alert"><span className="voter-error-icon">!</span><div><b>We couldn’t load the polls</b><p>{apiError || 'The configured backend could not be reached. Check its availability, then try again.'}</p></div><button className="voter-primary-button" onClick={() => refreshPolls()}>Try again <span>→</span></button></div> : <>
      <section className="voter-browse-section">
        <div className="voter-section-heading"><div><span className="voter-eyebrow">FIND YOUR POLL</span><h2>Make your voice heard</h2><p>Choose a poll to view the question and submit your ballot.</p></div><span className="voter-data-note"><i/> Data from local backend</span></div>
        <div className="voter-filter-toolbar"><label className="voter-search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search polls or choices" aria-label="Search polls or choices"/>{query && <button type="button" className="voter-clear-search" onClick={() => setQuery('')} aria-label="Clear poll search">×</button>}</label><button className="voter-refresh-button" onClick={() => refreshPolls()} disabled={apiState === 'loading'}>↻ Refresh</button></div>
        <div className="voter-filter-tabs" role="group" aria-label="Filter polls">{[
          ['available', 'Available'], ['active', 'All active'], ['closingSoon', 'Closing soon'], ['completed', 'Completed'], ['voted', 'Previously voted'], ['all', 'All polls'],
        ].map(([key, label]) => <button type="button" key={key} className={filter === key ? 'selected' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{key === 'voted' && historyChecking ? '…' : pollCounts[key]}</span></button>)}</div>
        {filter === 'voted' && historyError && <div className="voter-history-warning" role="status">Voting history could not be checked for some polls. Refresh to try again; those polls are omitted from this filter.</div>}
        <div className="voter-poll-grid premium-grid" aria-live="polite">{filter === 'voted' && historyChecking ? <div className="voter-skeleton-grid compact" aria-label="Checking voting history" aria-busy="true">{[0, 1].map((item) => <div className="voter-skeleton-card" key={item}><i/><i/><i/><i/></div>)}</div> : visiblePolls.length ? visiblePolls.map((poll) => <VoterPollCard key={poll.id} poll={poll} status={statusAt(poll)} voted={voted[poll.id]} voteCheckState={voteCheckState[poll.id]} onOpen={() => navigate(`/poll/${poll.id}`)}/>) : <div className="voter-empty-card"><EmptyState title={emptyState.title} description={emptyState.description} action={query ? <button className="voter-secondary-button" onClick={() => setQuery('')}>Clear search</button> : null}/></div>}</div>
      </section>
    </>}
  </>

  if (!active) return <LoadState state={apiState} error={detailError} retry={() => navigate('/vote')} label="poll"/>
  const status = statusAt(active)
  const shownResults = activeResults
  const selectedForPoll = selected[active.id] || []
  const selectedLabels = selectedForPoll.map((id) => active.options.find((option) => option.id === id)?.label).filter(Boolean)
  const identityNotice = voterIdentityNotice({ audience: active.audience, accountMode, googleMode })
  const checkState = voteCheckState[active.id]
  const checkingVote = checkState === 'loading' || checkState === undefined
  return <>
    <button className="back-control" onClick={() => navigate('/vote')}>← <span>All polls</span></button>
    <PageHeading eyebrow={`POLL · ${active.id.slice(0, 8).toUpperCase()}`} title={active.question} description={active.description?.trim() || 'Review the poll details, choose your response, and check your ballot before submitting.'}/>
    <div className="voter-detail-context" aria-label="Poll details"><span><small>Format</small><b>{formatVotingType(active.votingType)}</b></span><span><small>Voting mode</small><b>{active.audience === 'anonymous' ? 'Anonymous setting · identity checked' : 'Public'}</b></span><span><small>Voting window</small><b>{active.durationMinutes} minutes</b></span><span><small>Closes</small><b>{active.endsAt ? new Date(active.endsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'When the timer ends'}</b></span><span><small>Results</small><b>{({ live: 'During voting', 'after-vote': 'After you vote', 'after-close': 'After poll closes' })[active.visibility] || active.visibility}</b></span></div>
    <section className="voter-detail-grid">
      <article className="surface ballot-surface">
        <div className="ballot-topline"><StatusBadge status={status}/>{status === 'active' && <span className="countdown-label">{formatDuration(secondsLeft(active))} remaining</span>}</div>
        <fieldset className="choice-fieldset" disabled={status !== 'active' || busy || checkingVote || voted[active.id]} aria-describedby={active.votingType === 'ranked' ? 'ranking-help' : 'choice-help'}>
          <legend>{active.votingType === 'ranked' ? 'Build your ranking' : active.votingType === 'multiple' ? 'Choose any options that apply' : 'Choose one option'}</legend>
          {active.votingType !== 'ranked' && <p className="choice-guidance" id="choice-help">{active.votingType === 'multiple' ? 'Select each answer that applies. Your selections are submitted together as one ballot.' : 'Select one answer. You can review it before you send your ballot.'}</p>}
          {active.votingType === 'ranked' ? <>
            <p className="ranking-guidance" id="ranking-help">Add candidates, then use the arrow buttons to set your preference order. Rank at least one candidate; unranked candidates are skipped and may exhaust your ballot in a later round.</p>
            <ol className="ranking-list" aria-label="Your candidate ranking" aria-live="polite" aria-relevant="all">
              {selectedForPoll.map((id, index) => {
                const option = active.options.find((candidate) => candidate.id === id)
                if (!option) return null
                return <li className="ranking-item" key={id}><span className="ranking-grip" aria-hidden="true" title="Use the arrow buttons to reorder">⠿</span><span className="ranking-position" aria-label={`Rank ${index + 1}, preference ${index + 1}`}>#{index + 1} <small>Preference</small></span><span className="choice-label">{option.label}</span>
                  <button type="button" className="ranking-move" disabled={index === 0} onClick={() => setSelected((all) => ({ ...all, [active.id]: moveRankingItem(all[active.id] || [], index, -1) }))} aria-label={`Move ${option.label} up`}>↑</button>
                  <button type="button" className="ranking-move" disabled={index === selectedForPoll.length - 1} onClick={() => setSelected((all) => ({ ...all, [active.id]: moveRankingItem(all[active.id] || [], index, 1) }))} aria-label={`Move ${option.label} down`}>↓</button>
                  <button type="button" className="ranking-remove" onClick={() => setSelected((all) => ({ ...all, [active.id]: (all[active.id] || []).filter((candidateId) => candidateId !== id) }))} aria-label={`Remove ${option.label} from ranking`}>Remove</button>
                </li>
              })}
            </ol>
            <div className="ranking-candidates"><b>Available candidates</b>{active.options.map((option) => <button type="button" className="ranking-add" key={option.id} disabled={selectedForPoll.includes(option.id)} onClick={() => setSelected((all) => ({ ...all, [active.id]: [...(all[active.id] || []), option.id] }))}>{selectedForPoll.includes(option.id) ? 'Ranked' : '＋ Add'} <span>{option.label}</span></button>)}</div>
          </> : <div className="choice-list">{active.options.map((option) => {
            const checked = selectedForPoll.includes(option.id)
            return <label className={`choice-option ${checked ? 'checked' : ''}`} key={option.id}>
              <input type={active.votingType === 'multiple' ? 'checkbox' : 'radio'} name={`vote-${active.id}`} checked={checked} onChange={() => setSelected((all) => {
                const current = all[active.id] || []
                const next = active.votingType === 'single' ? [option.id] : current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id]
                return { ...all, [active.id]: next }
              })}/><span className="choice-indicator"/><span className="choice-label">{option.label}</span>
            </label>
          })}</div>}
        </fieldset>
        {status === 'active' && selectedForPoll.length > 0 && <p className="ballot-selection-summary" role="status">{active.votingType === 'ranked' ? `${selectedForPoll.length} ${selectedForPoll.length === 1 ? 'candidate' : 'candidates'} ranked` : active.votingType === 'multiple' ? `${selectedForPoll.length} ${selectedForPoll.length === 1 ? 'option' : 'options'} selected` : '1 option selected'}</p>}
        {voted[active.id] && <div className="inline-notice warning" role="status"><b>Ballot already submitted</b><span>{DUPLICATE_VOTE} Your accepted vote and the results are unchanged.</span></div>}
        {!voted[active.id] && checkState === 'error' && <div className="inline-notice error" role="alert"><b>Could not verify prior voting activity.</b><span>You may continue. The backend will validate the submission and reject it if this identity has already voted.</span></div>}
        {status === 'active' && voted[active.id] ? <button className="button button-outline submit-button" disabled>Ballot already submitted</button> : status === 'active' ? <button className="button button-primary submit-button" disabled={busy || checkingVote || !selectedForPoll.length} onClick={() => setConfirmation({
          title: active.votingType === 'ranked' ? 'Review your ranking' : 'Review your ballot',
          description: active.votingType === 'ranked' ? `Confirm the preference order below before sending this ballot. The backend will calculate the rounds. ${identityNotice}` : `Check your selection before submitting. ${identityNotice}`,
          reviewTitle: active.votingType === 'ranked' ? 'Preference order' : active.votingType === 'multiple' ? 'Selected options' : 'Your selection',
          reviewItems: selectedLabels,
          confirmLabel: active.votingType === 'ranked' ? 'Confirm ranking' : 'Submit ballot',
          run: submitVote,
        })}>{busy ? 'Submitting…' : checkingVote ? 'Checking ballot status…' : active.votingType === 'ranked' ? 'Review ranking' : 'Review ballot'} <span>→</span></button> : <div className="closed-notice"><strong>Voting is closed</strong><span>This poll is {STATUS_LABEL[status]?.toLowerCase() || status}. You cannot submit a ballot now.</span></div>}
        <p className="privacy-footnote">{identityNotice}</p>
      </article>
      <div className="voter-aside">
        {shownResults ? <ResultsCard poll={active} results={shownResults} voterTheme/> : <div className="surface results-placeholder"><SectionHeader eyebrow="POLL RESULTS" title={resultState[active.id] === 'loading' ? 'Loading results' : resultState[active.id] === 'error' ? 'Results could not load' : resultState[active.id] === 'hidden' ? 'Results are hidden for now' : 'Results will appear here'}/>{resultState[active.id] === 'loading' ? <InlineState>Loading results from the configured backend…</InlineState> : resultState[active.id] === 'error' ? <div className="error-copy" role="alert">Could not load results. <button className="text-button" onClick={() => loadResults(active.id)}>Try again</button></div> : <p>{active.visibility === 'after-vote' ? 'Results will appear after your ballot is accepted.' : active.visibility === 'after-close' ? 'Results will be revealed after this poll closes.' : resultState[active.id] === 'hidden' ? 'The backend is withholding results under this poll’s visibility rules.' : 'Results are being requested from the backend.'}</p>}</div>}
        {statusAt(active) !== 'draft' && (!canUseLocalOnlyFeatures(configuredApiMode) ? <article className="surface chat-panel"><SectionHeader eyebrow="POLL DISCUSSION" title="Live chat disabled"/><p className="chat-disclaimer">Live Chat and WebSockets are excluded from the initial AWS HTTP-only mode.</p></article> : <ChatPanel messages={chatMessages} text={chatText} setText={setChatText} send={sendPollChatMessage} status={chatLoadedPollId === active.id ? chatStatus : 'loading'} error={chatError} readOnly={['closed', 'expired'].includes(statusAt(active))} sending={chatSending}/>)}
      </div>
    </section>
  </>
}

function PageHeading({ eyebrow, title, description, action }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>
}

function SectionHeader({ eyebrow, title, action }) {
  return <div className="section-heading"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>{action}</div>
}

function Metric({ label, value, note, icon, tone }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`} aria-hidden="true">{icon}</div><p>{label}</p><strong>{value}</strong><small>{note}</small></article>
}

function StatusBadge({ status }) {
  return <span className={`status-badge status-${status}`}><i/>{STATUS_LABEL[status] || status}</span>
}

function RecentPoll({ poll, onClick, now }) {
  const status = pollStatus(poll, now)
  return <button className="recent-row" onClick={onClick}><span className="recent-symbol">{poll.question.slice(0, 1).toUpperCase()}</span><span className="recent-main"><b>{poll.question}</b><small>{poll.voteCount} votes · Updated {timeAgo(poll.updatedAt || poll.createdAt)}</small></span><StatusBadge status={status}/><span className="row-chevron">›</span></button>
}

function PollTable({ polls, now, navigate, emptyAction, actions = null, selectedPollIds = [], setSelectedPollIds }) {
  if (!polls.length) return <EmptyState title="No polls match this view" description="Create a poll, or adjust your search and status filter." action={emptyAction && <button className="button button-outline" onClick={emptyAction}>Create poll</button>}/>
  return <div className="table-wrap"><table className="poll-table"><thead><tr>{actions && <th scope="col"><span className="sr-only">Select</span></th>}<th scope="col">Poll</th><th scope="col">Status</th><th scope="col">Participation</th><th scope="col">Updated</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{polls.map((poll) => <tr key={poll.id}>
    {actions && <td className="admin-row-select"><input type="checkbox" checked={selectedPollIds.includes(poll.id)} aria-label={`Select ${poll.question}`} onChange={() => setSelectedPollIds((current) => togglePollSelection(current, poll.id))}/></td>}
    <td><button className="table-poll-link" onClick={() => navigate(`/admin/polls/${poll.id}`)}><b>{poll.question}</b><small>{poll.options.length} options · {formatVotingType(poll.votingType)}</small></button></td>
    <td><StatusBadge status={pollStatus(poll, now)}/></td><td><b>{poll.voteCount}</b><small> votes</small></td><td>{timeAgo(poll.updatedAt || poll.createdAt)}</td>
    <td>{actions ? <div className="poll-row-actions"><button className="row-action" onClick={() => navigate(`/admin/polls/${poll.id}`)} aria-label={`Open ${poll.question}`}>View</button>{canSharePoll(poll) && <button className="row-action row-action-share" onClick={() => actions.share(poll)} aria-label={`Share ${poll.question}`}>Share</button>}{poll.status === 'draft' && <><button className="row-action" onClick={() => actions.edit(poll)}>Edit</button><button className="row-action" onClick={() => actions.start(poll)}>Start</button><button className="row-action row-action-danger" onClick={() => actions.delete(poll)}>Delete</button></>}{pollStatus(poll, now) === 'active' && <button className="row-action" onClick={() => actions.close(poll)}>Close</button>}{['closed', 'expired'].includes(pollStatus(poll, now)) && <button className="row-action" onClick={() => actions.reopen(poll)}>Reopen</button>}</div> : <button className="row-action" onClick={() => navigate(`/admin/polls/${poll.id}`)} aria-label={`Open ${poll.question}`}>Open →</button>}</td>
  </tr>)}</tbody></table></div>
}

function VoterPollCard({ poll, status, voted, voteCheckState, onOpen }) {
  const resultsVisible = canVoterSeePollCounts(poll, status, voted)
  const activity = voted === true
    ? 'Your ballot submitted'
    : resultsVisible
      ? `${poll.voteCount} ${poll.voteCount === 1 ? 'vote' : 'votes'}`
      : poll.visibility === 'after-close'
        ? 'Results shown after poll closes'
        : poll.visibility === 'after-vote'
          ? 'Results shown after you vote'
          : voteCheckState === 'error'
            ? 'Could not check your ballot status'
            : 'Checking your ballot status…'
  const cardDescription = poll.description?.trim() || (poll.votingType === 'ranked'
    ? 'Rank candidates in the order you prefer.'
    : poll.votingType === 'multiple'
      ? 'Select every option that applies to you.'
      : 'Choose the one option that best represents your view.')
  const timing = status === 'active' && poll.endsAt
    ? `Closes ${new Date(poll.endsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : `${poll.durationMinutes} min voting window`
  const actionLabel = status === 'active' ? voted === true ? 'View ballot' : 'Vote now' : 'View poll'
  return <article className={`surface voter-poll-card ${status === 'active' ? 'is-open' : 'is-closed'}`}>
    <div className="voter-card-top"><span className="voter-card-badges"><StatusBadge status={status}/>{voted === true && <span className="voter-voted-badge">✓ Already voted</span>}</span><span className="type-label">{formatVotingType(poll.votingType)}</span></div>
    <button className="voter-card-title" onClick={onOpen} aria-label={`${status === 'active' ? 'Open' : 'View'} poll: ${poll.question}`}>{poll.question}<span aria-hidden="true">↗</span></button>
    <p className="voter-card-description">{cardDescription}</p>
    <div className="voter-card-meta"><span>{poll.options.length} options</span><i aria-hidden="true"/><span>{timing}</span></div>
    <div className="voter-card-bottom"><span className={`voter-activity ${voted === true ? 'submitted' : ''}`}><i aria-hidden="true"/>{activity}</span><button className="voter-card-action" onClick={onOpen}>{actionLabel} <span aria-hidden="true">→</span></button></div>
  </article>
}

function PollDetail({ awsMode = false, poll, navigate, openEditor, startPoll, closePoll, reopenPoll, deletePoll, copyPollLink, loadResults, resultData, resultState, busy, now }) {
  const status = pollStatus(poll, now)
  const results = resultData[poll.id]
  useEffect(() => { if (status !== 'draft') loadResults(poll.id) }, [poll.id, status, loadResults])
  return <>
    <button className="back-control" onClick={() => navigate('/admin/polls')}>← <span>All polls</span></button>
    <PageHeading eyebrow="POLL DETAILS" title={poll.question} description={`Created ${new Date(poll.createdAt).toLocaleDateString()} · ${poll.options.length} options · ${poll.durationMinutes} minute duration`} action={<div className="action-row"><StatusBadge status={status}/>{status === 'draft' && <><button className="button button-outline" onClick={() => openEditor(poll)}>Edit draft</button><button className="button button-primary" disabled={busy} onClick={() => startPoll(poll)}>Start poll</button></>}{status === 'active' && <button className="button button-outline" disabled={busy} onClick={() => closePoll(poll)}>Close poll</button>}{['closed', 'expired'].includes(status) && <button className="button button-primary" disabled={busy} onClick={() => reopenPoll(poll)}>Reopen poll</button>}</div>}/>
    <section className="detail-grid">
    <article className="surface detail-surface"><SectionHeader eyebrow="POLL CONFIGURATION" title="Settings"/><DetailLine label="Voting type" value={formatVotingType(poll.votingType)}/><DetailLine label="Voting mode" value={poll.audience === 'anonymous' ? 'Anonymous (development identity)' : 'Public'}/><DetailLine label="Results visible" value={({ live: 'During voting', 'after-vote': 'After voter submits', 'after-close': 'After poll closes' })[poll.visibility]}/><DetailLine label="Poll chat" value={awsMode ? "Disabled in initial AWS HTTP-only mode" : "Enabled for active and closed polls"}/><DetailLine label="Poll ID" value={poll.id} mono/></article>
      <article className="surface detail-surface"><SectionHeader eyebrow="PARTICIPATION" title="Current results"/><div className="detail-vote-total"><strong>{results?.ballotCount ?? poll.voteCount}</strong><span>accepted ballots</span></div>{results ? <ResultBars poll={poll} results={results}/> : resultState[poll.id] === 'loading' ? <InlineState>Loading results…</InlineState> : <p className="muted-copy">Results are unavailable or hidden for this poll. {resultState[poll.id] === 'error' && <button className="text-button" onClick={() => loadResults(poll.id)}>Retry</button>}</p>}</article>
      <article className="surface detail-surface detail-actions"><SectionHeader eyebrow="SHARE & MANAGE" title="Poll actions"/><button className="button button-outline" onClick={() => copyPollLink(poll.id)}>Copy voter link</button>{status === 'draft' && <button className="button button-danger-outline" onClick={() => deletePoll(poll)}>Delete draft</button>}<p>{awsMode ? 'Poll management is authorized by the AWS backend.' : 'Management actions are available in the local development preview. They are not production authentication or authorization.'}</p></article>
    </section>
  </>
}

function ResultsPage({ poll, pollId, navigate, loadResults, resultData, resultState, resultUpdatedAt, now }) {
  useEffect(() => { if (pollId) loadResults(pollId) }, [pollId, loadResults])
  if (!poll) return <LoadState state={resultState[pollId] === 'error' ? 'error' : resultState[pollId] === 'loading' ? 'loading' : 'ready'} error={resultState[pollId] === 'error' ? 'Results are hidden or unavailable.' : ''} retry={() => navigate('/admin/polls')} label="poll"/>
  const results = resultData[pollId]
  return <>
    <button className="back-control" onClick={() => navigate('/admin/polls')}>← <span>Poll management</span></button>
    <PageHeading eyebrow="RESULTS & ANALYTICS" title={poll.question} description="Vote counts and percentages come from the backend." action={<div className="results-heading-actions"><StatusBadge status={pollStatus(poll, now)}/><button className="button button-outline" onClick={() => loadResults(pollId, { silent: true })} disabled={resultState[pollId] === 'loading'}>↻ <span>Refresh</span></button></div>}/>
    <div className="results-refresh-bar" role="status"><span className={`refresh-indicator ${resultState[pollId] === 'refresh-error' ? 'stale' : ''}`}/><div><b>{resultState[pollId] === 'refresh-error' ? 'Refresh delayed' : 'Automatic refresh enabled'}</b><small>Checks the local backend every 5 seconds. This is polling, not a live push connection.</small></div><span className="results-updated">{resultUpdatedAt ? `Updated ${new Date(resultUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Waiting for first response'}</span></div>
    {resultState[pollId] === 'refresh-error' && results && <p className="results-stale-note" role="alert">Could not refresh the latest results. Showing the last successful backend response.</p>}
    {results ? <section className="results-layout"><ResultsCard poll={poll} results={results}/><article className="surface analytics-summary"><SectionHeader eyebrow="POLL SUMMARY" title="Participation"/><div className="detail-vote-total"><strong>{results.ballotCount}</strong><span>accepted ballots</span></div><DetailLine label="Voting format" value={formatVotingType(poll.votingType)}/><DetailLine label="Result visibility" value={poll.visibility}/><DetailLine label="Status" value={STATUS_LABEL[pollStatus(poll, now)]}/><DetailLine label="Data source" value="Local backend"/></article></section> : <InlineState tone={resultState[pollId] === 'error' || resultState[pollId] === 'hidden' ? 'error' : undefined}>{resultState[pollId] === 'loading' ? 'Loading results from the configured backend…' : resultState[pollId] === 'hidden' ? 'Results are hidden by this poll’s visibility rules.' : 'Results could not be loaded.'} {resultState[pollId] !== 'loading' && <button className="text-button" onClick={() => loadResults(pollId)}>Retry</button>}</InlineState>}
  </>
}

function AnalyticsPage({ polls, totalVotes, counts, state, navigate, openEditor, now, embedded = false }) {
  const ranked = [...polls].sort((a, b) => b.voteCount - a.voteCount).slice(0, 6)
  const maxVotes = Math.max(1, ...ranked.map((poll) => poll.voteCount))
  const statusGroups = [
    { label: 'Live', count: counts.active || 0, tone: 'live' },
    { label: 'Draft', count: counts.draft || 0, tone: 'draft' },
    { label: 'Closed or ended', count: (counts.closed || 0) + (counts.expired || 0), tone: 'closed' },
  ]
  const totalPolls = polls.length
  return <div className={embedded ? 'analytics-embedded' : 'analytics-page'}>
    {!embedded && <PageHeading eyebrow="ADMIN ANALYTICS" title="Participation at a glance" description="A clear view of accepted ballots and poll status, based on data returned by the local backend." action={<button className="button button-primary" onClick={() => openEditor()}>＋ <span>Create poll</span></button>}/>}
    {state === 'error' && <div className="analytics-data-notice" role="alert">Analytics are unavailable because the local backend could not be reached.</div>}
    {!embedded && <section className="metric-grid metric-grid-three analytics-metrics" aria-label="Poll analytics"><Metric label="Accepted ballots" value={state === 'ready' ? totalVotes.toLocaleString() : '—'} note="Across all listed polls" icon="↗" tone="violet"/><Metric label="Live polls" value={state === 'ready' ? (counts.active || 0).toLocaleString() : '—'} note="Currently accepting votes" icon="◉" tone="mint"/><Metric label="Total polls" value={state === 'ready' ? totalPolls.toLocaleString() : '—'} note="From the configured backend" icon="▤" tone="blue"/></section>}
    <section className="analytics-charts-grid" aria-label="Poll charts">
      <article className="surface analytics-chart-card"><SectionHeader eyebrow="POLL STATUS" title="Your poll portfolio"/><p className="chart-caption">Status distribution across {state === 'ready' ? totalPolls : '—'} backend polls.</p>{state === 'loading' ? <InlineState>Loading poll summaries…</InlineState> : totalPolls ? <><div className="status-stack" role="img" aria-label={statusGroups.map(({ label, count }) => `${label}: ${count}`).join(', ')}>{statusGroups.map(({ label, count, tone }) => count > 0 && <span key={label} className={`status-segment ${tone}`} style={{ flexGrow: count }} title={`${label}: ${count}`}/>)}</div><div className="status-legend">{statusGroups.map(({ label, count, tone }) => <div key={label}><i className={tone}/><span>{label}</span><b>{count}</b></div>)}</div></> : <EmptyState title="No polls to summarize" description="Create a poll to see its status distribution." action={<button className="button button-outline" onClick={() => openEditor()}>Create a poll</button>}/>}</article>
      <article className="surface analytics-chart-card"><SectionHeader eyebrow="ACCEPTED BALLOTS" title="Participation by poll"/><p className="chart-caption">Polls with the most accepted ballots, sorted by backend counts.</p>{state === 'loading' ? <InlineState>Loading poll summaries…</InlineState> : ranked.length ? <div className="activity-list">{ranked.map((poll) => <button className="activity-row" key={poll.id} onClick={() => navigate(`/admin/results/${poll.id}`)} aria-label={`${poll.question}, ${poll.voteCount} accepted ballots. Open results.`}><span className="activity-title"><b>{poll.question}</b><small>{STATUS_LABEL[pollStatus(poll, now)]}</small></span><span className="activity-bar"><i style={{ width: `${poll.voteCount / maxVotes * 100}%` }}/></span><strong>{poll.voteCount}</strong><span aria-hidden="true">→</span></button>)}</div> : <EmptyState title="No poll activity yet" description="Polls with accepted ballots will be ranked here."/>}</article>
    </section>
    {!embedded && <section className="surface analytics-poll-list"><SectionHeader eyebrow="POLL MANAGEMENT" title="All polls" action={<button className="text-button" onClick={() => navigate('/admin/polls')}>Open poll manager →</button>}/>{state === 'loading' ? <InlineState>Loading polls…</InlineState> : polls.length ? <div className="table-wrap"><table className="poll-table"><thead><tr><th>Poll</th><th>Format</th><th>Status</th><th>Accepted ballots</th><th>Actions</th></tr></thead><tbody>{polls.map((poll) => <tr key={poll.id}><td><button className="table-poll-link" onClick={() => navigate(`/admin/polls/${poll.id}`)}><b>{poll.question}</b><small>{poll.options.length} options</small></button></td><td>{formatVotingType(poll.votingType)}</td><td><StatusBadge status={pollStatus(poll, now)}/></td><td>{poll.voteCount}</td><td><button className="row-action" onClick={() => navigate(`/admin/polls/${poll.id}`)}>Manage</button><button className="row-action" onClick={() => navigate(`/admin/results/${poll.id}`)}>Results</button></td></tr>)}</tbody></table></div> : <EmptyState title="No polls yet" description="Your polls will appear here when they are created." action={<button className="button button-primary" onClick={() => openEditor()}>Create your first poll</button>}/>}</section>}
  </div>
}

function ResultsCard({ poll, results, voterTheme = false }) {
  return <article className={`surface results-card ${voterTheme ? 'voter-results-card' : ''}`}><SectionHeader eyebrow="BACKEND RESULTS" title={results.method === 'instant_runoff' ? 'Instant-runoff count' : 'Vote breakdown'} action={<span className="result-total">{results.ballotCount} ballots</span>}/>{results.method === 'instant_runoff' ? <RankedResults results={results}/> : results.ballotCount ? poll.votingType === 'single' ? <SingleChoiceResults results={results} voterTheme={voterTheme}/> : <ResultBars results={results} voterTheme={voterTheme}/> : <EmptyState title="No ballots yet" description="Accepted votes will appear here after they are submitted."/>}<div className="results-footnote">{results.method === 'instant_runoff' ? 'IRV uses strict majority of continuing ballots. A tied lowest tally stops the count without a winner; no candidate is selected by an arbitrary tie-break.' : poll.votingType === 'multiple' ? 'Percentages show the share of ballots selecting each option and can total over 100%.' : 'Percentages are calculated from backend ballot counts.'}</div></article>
}

function SingleChoiceResults({ results, voterTheme = false }) {
  const colors = voterTheme ? ['#4f46e5', '#059669', '#2563eb', '#6366f1', '#10b981', '#818cf8'] : ['#5968c9', '#22a58a', '#d99132', '#cc6483', '#7180c9', '#599a79']
  const circumference = 2 * Math.PI * 48
  const segments = results.options.reduce((all, option, index) => {
    const share = Math.max(0, Math.min(1, Number(option.count || 0) / results.ballotCount))
    const length = share * circumference
    const offset = all.length ? all[all.length - 1].offset + all[all.length - 1].length : 0
    return [...all, { option, index, length, offset }]
  }, [])
  return <div className="single-results-chart">
    <div className="result-donut-wrap"><svg className="result-donut" viewBox="0 0 120 120" role="img" aria-label={`Vote share for ${results.options.length} choices`}>
      <circle className="donut-track" cx="60" cy="60" r="48"/>
      {segments.map(({ option, index, length, offset }) => <circle key={option.id || option.optionId} className="donut-segment" cx="60" cy="60" r="48" stroke={colors[index % colors.length]} strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset}/>)}
    </svg><div className="donut-center"><b>{results.ballotCount}</b><span>ballots</span></div></div>
    <div className="donut-legend">{results.options.map((option, index) => <div className="donut-legend-row" key={option.id || option.optionId}><i style={{ background: colors[index % colors.length] }}/><span>{option.label}</span><b>{Number(option.percentage ?? (option.count / results.ballotCount * 100)).toFixed(1)}%</b><small>{option.count} votes</small></div>)}</div>
  </div>
}

function RankedResults({ results }) {
  const outcomeCopy = results.outcome === 'winner' ? `Winner: ${results.winnerLabel}`
    : results.outcome === 'elimination_tie' ? 'No winner: lowest tally is tied.'
      : results.outcome === 'no_votes' ? 'No ballots have been submitted.' : 'No continuing ballots remain.'
  return <div className="irv-results">
    <div className={`irv-outcome ${results.outcome === 'winner' ? 'winner' : ''}`} role="status"><b>{outcomeCopy}</b>
      {results.outcome === 'elimination_tie' && <span>Tied candidates: {results.tieOptionIds.map((id) => results.rounds.at(-1)?.tallies.find((candidate) => candidate.optionId === id)?.label || id).join(', ')}</span>}
    </div>
    {results.rounds.map((round) => <section className="irv-round" key={round.round}><h3>Round {round.round}</h3><div className="irv-round-meta"><span>{round.continuingBallots} continuing</span><span>{round.exhaustedBallots} exhausted</span></div>
      <ul>{round.tallies.map((candidate) => {
        const share = round.continuingBallots ? candidate.votes / round.continuingBallots * 100 : 0
        const winner = results.winnerOptionId === candidate.optionId && results.outcome === 'winner' && round.round === results.rounds.length
        return <li className={`irv-tally ${winner ? 'winner' : ''}`} key={candidate.optionId}><div className="irv-candidate-line"><span>{candidate.label}</span><b>{candidate.votes}</b><small>{share.toFixed(1)}%</small>{round.eliminatedOptionId === candidate.optionId && <em>Eliminated</em>}{round.tiedLowestOptionIds.includes(candidate.optionId) && <em>Tied lowest</em>}{winner && <em>Winner</em>}</div><div className="irv-track" aria-label={`${candidate.label}: ${candidate.votes} votes, ${share.toFixed(1)} percent`}><i style={{ width: `${Math.min(100, share)}%` }}/></div></li>
      })}</ul>
    </section>)}
  </div>
}

function formatVotingType(votingType) {
  return ({ single: 'Single choice', multiple: 'Multiple choice', ranked: 'Ranked choice · IRV' })[votingType] || 'Single choice'
}

function ResultBars({ results, voterTheme = false }) {
  const colors = voterTheme ? ['#4f46e5', '#059669', '#2563eb', '#6366f1', '#10b981', '#818cf8'] : ['#5968c9', '#22a58a', '#d99132', '#cc6483', '#7180c9', '#599a79']
  return <div className="result-bars">{results.options.map((option, index) => <div className="result-bar-row" key={option.id || option.optionId}><div className="result-bar-label"><span>{option.label}</span><b>{Number(option.percentage ?? (results.ballotCount ? option.count / results.ballotCount * 100 : 0)).toFixed(1)}%</b></div><div className="bar-track"><i style={{ width: `${Math.min(100, option.percentage ?? (results.ballotCount ? option.count / results.ballotCount * 100 : 0))}%`, background: colors[index % colors.length] }}/></div><small>{option.count} {option.count === 1 ? 'vote' : 'votes'}</small></div>)}</div>
}

function DetailLine({ label, value, mono = false }) {
  return <div className="detail-line"><span>{label}</span><b className={mono ? 'mono' : ''}>{value}</b></div>
}

function ChatPanel({ messages, text, setText, send, status, error, readOnly, sending }) {
  const statusLabel = status === 'connected' ? 'Connected' : status === 'loading' ? 'Loading history' : status === 'reconnecting' ? 'Reconnecting' : status === 'error' ? 'Unavailable' : 'Connecting'
  return <article className="surface chat-panel"><SectionHeader eyebrow="POLL DISCUSSION" title="Live chat" action={<span className={'chat-connection chat-' + status} role="status"><i/>{statusLabel}</span>}/>
    <p className="chat-disclaimer">Chat messages are separate from ballots and results. Use respectful language.</p>
    {error && <p className="chat-error" role="alert">{error}</p>}
    <div className="chat-messages" aria-live="polite">{status === 'loading' ? <p className="chat-empty" role="status">Loading messages…</p> : messages.length ? messages.map((message) => <div className="chat-message" key={message.id}><span className="chat-avatar">{message.sender?.[0]?.toUpperCase() || 'V'}</span><div><div className="chat-message-head"><b>{message.sender}</b><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><p>{message.text}</p></div></div>) : <p className="chat-empty">No messages yet. Start the discussion.</p>}</div>
    {readOnly ? <p className="chat-readonly" role="status">This poll is closed. Its discussion remains available to read.</p> : <form className="chat-composer" onSubmit={send}><label className="sr-only" htmlFor="chat-message">Write a message</label><input id="chat-message" value={text} onChange={(event) => setText(event.target.value)} maxLength={500} placeholder="Write a message…"/><span className="chat-length">{text.length}/500</span><button className="button button-primary" disabled={sending || !text.trim()} aria-label="Send message">{sending ? 'Sending…' : 'Send'}</button></form>}
  </article>
}

function PollEditor({ editor, draft, setDraft, busy, formError, close, save }) {
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="poll-editor-title" onSubmit={save}>
    <div className="dialog-heading"><div><div className="eyebrow">POLL CONFIGURATION</div><h2 id="poll-editor-title">{editor === 'new' ? 'Create a poll' : 'Edit draft poll'}</h2></div><button type="button" className="icon-button" onClick={close} aria-label="Close dialog">×</button></div>
    {formError && <div className="inline-notice error" role="alert">{formError}</div>}
    <label className="form-field">Question<input autoFocus required maxLength={240} value={draft.question} onChange={(event) => setDraft({ ...draft, question: event.target.value })} placeholder="What would you like to ask?"/></label>
    <fieldset className="options-field"><legend>Answer options <span>At least two unique choices</span></legend>{draft.options.map((option, index) => <div className="option-edit-row" key={index}><label className="sr-only" htmlFor={`option-${index}`}>Option {index + 1}</label><input id={`option-${index}`} required maxLength={120} value={option} onChange={(event) => setDraft({ ...draft, options: draft.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} placeholder={`Option ${index + 1}`}/>{draft.options.length > 2 && <button type="button" className="remove-option" onClick={() => setDraft({ ...draft, options: draft.options.filter((_, itemIndex) => itemIndex !== index) })} aria-label={`Remove option ${index + 1}`}>Remove</button>}</div>)}<button type="button" className="add-option" onClick={() => setDraft({ ...draft, options: [...draft.options, ''] })}>＋ Add another option</button></fieldset>
    <div className="form-grid"><label className="form-field">Voting format<select value={draft.votingType} onChange={(event) => setDraft({ ...draft, votingType: event.target.value })}><option value="single">Single choice</option><option value="multiple">Multiple choice</option><option value="ranked">Ranked choice · Instant-runoff</option></select></label><label className="form-field">Duration in minutes<input required type="number" min="1" max="10080" value={draft.durationMinutes} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })}/></label></div>
    {draft.votingType === 'ranked' && <p className="ranking-guidance editor-guidance">Voters rank at least one candidate and may leave later preferences blank. Results use instant-runoff counting; an unresolved lowest-candidate tie ends the count without a winner.</p>}
    <div className="form-grid"><label className="form-field">Voting mode<select value={draft.audience} onChange={(event) => setDraft({ ...draft, audience: event.target.value })}><option value="public">Public</option><option value="anonymous">Anonymous · development identity</option></select></label><label className="form-field">Results visibility<select value={draft.visibility} onChange={(event) => setDraft({ ...draft, visibility: event.target.value })}><option value="live">During voting</option><option value="after-vote">After voter submits</option><option value="after-close">After poll closes</option></select></label></div>
    <div className="dialog-actions"><button type="button" className="button button-outline" onClick={close}>Cancel</button><button className="button button-primary" disabled={busy} type="submit">{busy ? 'Saving…' : editor === 'new' ? 'Create draft' : 'Save changes'}</button></div>
  </form></div>
}

function ConfirmDialog({ title, description, reviewTitle, reviewItems, confirmLabel, confirm, close, busy, danger }) {
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close() }} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) close() }}><section className="dialog confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description"><div className="dialog-heading"><div><div className="eyebrow">CONFIRM ACTION</div><h2 id="confirm-title">{title}</h2></div><button className="icon-button" onClick={close} disabled={busy} aria-label="Cancel">×</button></div><p id="confirm-description">{description}</p>{reviewItems?.length > 0 && <><div className="review-list-title">{reviewTitle || 'Review items'}</div><ol className="ranking-review">{reviewItems.map((label, index) => <li key={`${index}-${label}`}><span>{index + 1}</span>{label}</li>)}</ol></>}<div className="dialog-actions"><button className="button button-outline" onClick={close} disabled={busy} autoFocus>{reviewItems?.length ? reviewTitle === 'Preference order' ? 'Change ranking' : 'Change selection' : 'Cancel'}</button><button className={`button ${danger ? 'button-danger-outline' : 'button-primary'}`} disabled={busy} onClick={confirm}>{busy ? 'Working…' : confirmLabel}</button></div></section></div>
}

function Notice({ notice, dismiss }) {
  return <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button onClick={dismiss} aria-label="Dismiss notification">×</button></div>
}

function EmptyState({ title, description, action }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">—</span><h3>{title}</h3><p>{description}</p>{action}</div>
}

function InlineState({ children, tone }) { return <div className={`inline-state ${tone || ''}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div> }

function LoadState({ state, error, retry, label }) {
  if (state === 'loading') return <InlineState>Loading {label} from the local backend…</InlineState>
  return <EmptyState title={state === 'error' ? `Could not load ${label}` : `${label[0].toUpperCase()}${label.slice(1)} not found`} description={error || `This ${label} is not available from the configured backend.`} action={<button className="button button-outline" onClick={retry}>Back to polls</button>}/>
}

export default App
