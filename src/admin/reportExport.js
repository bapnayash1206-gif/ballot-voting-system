import { canSharePoll } from './pollSharing.js'

const CSV_COLUMNS = [
  'record_type', 'poll_title', 'poll_id', 'status', 'voting_type', 'created_at', 'started_at', 'ends_at', 'updated_at',
  'total_ballots', 'option_or_candidate', 'votes', 'percentage', 'round', 'continuing_ballots', 'exhausted_ballots',
  'eliminated', 'tied_lowest', 'outcome',
]

function timestamp(value) {
  if (value === null || value === undefined || value === '') return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function baseRow(poll, results, recordType) {
  return {
    record_type: recordType,
    poll_title: poll.question,
    poll_id: poll.id,
    status: poll.status,
    voting_type: poll.votingType,
    created_at: timestamp(poll.createdAt),
    started_at: timestamp(poll.startedAt),
    ends_at: timestamp(poll.endsAt),
    updated_at: timestamp(poll.updatedAt),
    total_ballots: results.ballotCount,
  }
}

export async function collectPollReports(polls, getResults) {
  const reports = []
  const failures = []
  for (const poll of polls) {
    if (!canSharePoll(poll)) {
      failures.push({ poll, reason: 'Draft polls do not have voter-visible results.' })
      continue
    }
    try {
      const response = await getResults(poll.id)
      if (!response?.results || !Number.isFinite(response.results.ballotCount)) throw new Error('The backend returned no complete result data.')
      reports.push({ poll, results: response.results })
    } catch (error) {
      failures.push({ poll, reason: error?.message || 'The backend did not provide results.' })
    }
  }
  return { reports, failures }
}

export function escapeCsvCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  let first = 0
  while (first < text.length && (text.charCodeAt(first) <= 0x20 || text[first].trim() === '')) first += 1
  if ('=+-@'.includes(text[first] || '\0')) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function buildPollReportsCsv(reports) {
  const rows = []
  for (const { poll, results } of reports) {
    const outcome = results.method === 'instant_runoff'
      ? results.outcome === 'winner' ? `Winner: ${results.winnerLabel}` : results.outcome
      : ''
    rows.push({ ...baseRow(poll, results, 'poll_summary'), outcome })

    if (results.method === 'instant_runoff') {
      for (const round of results.rounds || []) {
        for (const tally of round.tallies || []) {
          rows.push({
            ...baseRow(poll, results, 'ranked_round'),
            option_or_candidate: tally.label,
            votes: tally.votes,
            percentage: round.continuingBallots ? Number((tally.votes / round.continuingBallots * 100).toFixed(2)) : 0,
            round: round.round,
            continuing_ballots: round.continuingBallots,
            exhausted_ballots: round.exhaustedBallots,
            eliminated: round.eliminatedOptionId === tally.optionId ? 'yes' : 'no',
            tied_lowest: round.tiedLowestOptionIds?.includes(tally.optionId) ? 'yes' : 'no',
            outcome,
          })
        }
      }
    } else {
      for (const option of results.options || []) {
        const percentage = Number.isFinite(option.percentage)
          ? Number(option.percentage.toFixed(2))
          : results.ballotCount ? Number((option.count / results.ballotCount * 100).toFixed(2)) : 0
        rows.push({
          ...baseRow(poll, results, 'option_result'),
          option_or_candidate: option.label,
          votes: option.count,
          percentage,
        })
      }
    }
  }

  return `\uFEFF${[CSV_COLUMNS.map(escapeCsvCell).join(','), ...rows.map((row) => CSV_COLUMNS.map((column) => escapeCsvCell(row[column])).join(','))].join('\r\n')}`
}

export function closePollsIndividually(polls, closePoll) {
  return (async () => {
    const succeeded = []
    const failures = []
    for (const poll of polls) {
      try {
        await closePoll(poll.id)
        succeeded.push(poll)
      } catch (error) {
        failures.push({ poll, reason: error?.message || 'The backend rejected the close request.' })
      }
    }
    return { succeeded, failures }
  })()
}

export function togglePollSelection(selectedIds, pollId) {
  return selectedIds.includes(pollId) ? selectedIds.filter((id) => id !== pollId) : [...selectedIds, pollId]
}

export function toggleVisiblePollSelection(selectedIds, visibleIds) {
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  if (allVisibleSelected) return selectedIds.filter((id) => !visibleIds.includes(id))
  return [...new Set([...selectedIds, ...visibleIds])]
}
