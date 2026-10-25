export function canVoterSeePollCounts(poll, status, hasVoted) {
  return poll.visibility === 'live'
    || (poll.visibility === 'after-vote' && hasVoted === true)
    || (poll.visibility === 'after-close' && ['closed', 'expired'].includes(status))
}

export function matchesVoterPoll(poll, query) {
  const term = String(query || '').trim().toLowerCase()
  if (!term) return true
  return [poll.question, poll.description, poll.id, ...(poll.options || []).map((option) => option.label)]
    .some((value) => String(value || '').toLowerCase().includes(term))
}

export function isClosingSoon(poll, status, now = Date.now(), windowMs = 24 * 60 * 60 * 1000) {
  if (status !== 'active' || !poll.endsAt) return false
  const closesAt = typeof poll.endsAt === 'number' ? poll.endsAt : Date.parse(poll.endsAt)
  return Number.isFinite(closesAt) && closesAt > now && closesAt - now <= windowMs
}

export function voterEmptyState({ query = '', filter = 'all', historyError = false } = {}) {
  if (String(query).trim()) return { title: 'No matching polls', description: 'Try a different search term or clear your search.' }
  if (filter === 'available') return { title: 'You’re all caught up', description: 'There are no open polls waiting for your vote right now. If you expected one, confirm that an administrator has started it.' }
  if (filter === 'closingSoon') return { title: 'Nothing is closing soon', description: 'No active poll with a verified closing time in the next 24 hours was returned.' }
  if (filter === 'completed') return { title: 'No completed polls yet', description: 'Completed polls will appear here after voting closes.' }
  if (filter === 'voted' && historyError) return { title: 'Voting history is incomplete', description: 'Some ballot-status checks failed, so this view cannot confirm your activity for every published poll.' }
  if (filter === 'voted') return { title: 'No confirmed voting activity', description: 'No submitted ballot was confirmed for the voter-visible polls returned by the backend.' }
  return { title: 'No voter-visible polls', description: 'The backend returned no published polls. Drafts are hidden from voters; a poll appears here after an administrator starts it.' }
}

export function voterIdentityNotice({ audience = 'public', accountMode = false, googleMode = false } = {}) {
  if (audience === 'anonymous') {
    if (accountMode) return 'This poll is marked anonymous, but this local build uses your signed-in account to prevent repeat ballots. It is not production-secure anonymous voting.'
    if (googleMode) return 'This poll is marked anonymous, but this local build uses your verified Google identity to prevent repeat ballots. It is not production-secure anonymous voting.'
    return 'This poll is marked anonymous, but this local build uses a shared development identity to prevent repeat ballots. It is not production-secure anonymous voting.'
  }
  if (accountMode) return 'The backend checks your signed-in voter account to prevent a second ballot in this poll.'
  if (googleMode) return 'The backend checks your verified Google identity to prevent a second ballot in this poll.'
  return 'Development only: the local backend checks its shared voter identity. This is not production authentication.'
}
