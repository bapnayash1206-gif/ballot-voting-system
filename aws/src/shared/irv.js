/** Shared instant-runoff validation and tally logic for local and Lambda backends. */
export function validateRanking(rankedOptionIds, candidateIds) {
  if (!Array.isArray(rankedOptionIds) || rankedOptionIds.length === 0) {
    return 'Rank at least one candidate.'
  }
  const allowed = new Set(candidateIds)
  if (rankedOptionIds.some((id) => typeof id !== 'string' || !allowed.has(id))) {
    return 'Rankings must contain valid poll options.'
  }
  if (new Set(rankedOptionIds).size !== rankedOptionIds.length) {
    return 'A candidate may appear only once in the ranking.'
  }
  return null
}

export function calculateIrvResults(options, ballots) {
  const candidates = options.map((option) => ({ id: option.optionId || option.id, label: option.label }))
  const active = new Set(candidates.map((candidate) => candidate.id))
  const rounds = []
  let outcome
  let winnerOptionId = null
  let tieOptionIds = []

  while (true) {
    const counts = new Map([...active].map((id) => [id, 0]))
    let exhaustedBallots = 0
    for (const ballot of ballots) {
      const ranking = ballot.voteData?.rankedOptionIds || ballot.rankedOptionIds || []
      const choice = ranking.find((id) => active.has(id))
      if (choice) counts.set(choice, counts.get(choice) + 1)
      else exhaustedBallots += 1
    }
    const continuingBallots = [...counts.values()].reduce((sum, value) => sum + value, 0)
    const round = {
      round: rounds.length + 1,
      tallies: candidates.filter((candidate) => active.has(candidate.id))
        .map((candidate) => ({ optionId: candidate.id, label: candidate.label, votes: counts.get(candidate.id) })),
      continuingBallots,
      exhaustedBallots,
      eliminatedOptionId: null,
      tiedLowestOptionIds: [],
    }
    rounds.push(round)

    if (ballots.length === 0) { outcome = 'no_votes'; break }
    if (continuingBallots === 0) { outcome = 'no_continuing_ballots'; break }
    const majority = [...counts].find(([, count]) => count * 2 > continuingBallots)
    if (majority) {
      winnerOptionId = majority[0]
      outcome = 'winner'
      break
    }
    if (active.size === 1) {
      winnerOptionId = [...active][0]
      outcome = 'winner'
      break
    }

    const lowest = Math.min(...counts.values())
    tieOptionIds = [...counts].filter(([, count]) => count === lowest).map(([id]) => id)
    if (tieOptionIds.length > 1) {
      round.tiedLowestOptionIds = tieOptionIds
      outcome = 'elimination_tie'
      break
    }
    round.eliminatedOptionId = tieOptionIds[0]
    active.delete(tieOptionIds[0])
  }

  return {
    method: 'instant_runoff',
    ruleVersion: 1,
    outcome,
    winnerOptionId,
    winnerLabel: candidates.find((candidate) => candidate.id === winnerOptionId)?.label || null,
    tieOptionIds,
    ballotCount: ballots.length,
    rounds,
  }
}
