import { canSharePoll } from './pollSharing.js'

export function createAdminCommands({ polls, navigate, scrollToSection, openEditor, sharePoll }) {
  const commands = [
    { id: 'dashboard', label: 'Go to Dashboard', hint: 'Navigation', keywords: 'home overview', run: () => scrollToSection('admin-dashboard') },
    { id: 'polls', label: 'Go to Poll management', hint: 'Navigation', keywords: 'polls list', run: () => scrollToSection('admin-polls') },
    { id: 'analytics', label: 'Go to Analytics', hint: 'Navigation', keywords: 'charts metrics', run: () => scrollToSection('admin-analytics') },
    { id: 'results', label: 'Go to Results', hint: 'Navigation', keywords: 'votes outcomes', run: () => scrollToSection('admin-results') },
    { id: 'create-poll', label: 'Create a poll', hint: 'Action', keywords: 'new question', run: openEditor },
  ]

  for (const poll of polls) {
    commands.push(
      { id: `open-${poll.id}`, label: `Open poll: ${poll.question}`, hint: 'Poll', keywords: `${poll.id} ${poll.status}`, run: () => navigate(`/admin/polls/${encodeURIComponent(poll.id)}`) },
      { id: `results-${poll.id}`, label: `View results: ${poll.question}`, hint: 'Poll', keywords: `${poll.id} results votes`, run: () => navigate(`/admin/results/${encodeURIComponent(poll.id)}`) },
    )
    if (canSharePoll(poll)) commands.push({ id: `share-${poll.id}`, label: `Share poll: ${poll.question}`, hint: 'Poll', keywords: `${poll.id} share link qr code`, run: () => sharePoll(poll) })
  }
  return commands
}

export function filterAdminCommands(commands, query) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return commands
  return commands.filter((command) => `${command.label} ${command.hint} ${command.keywords}`.toLocaleLowerCase().includes(normalized))
}
