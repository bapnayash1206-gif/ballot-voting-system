export function moveRankingItem(ranking, index, offset) {
  const target = index + offset
  if (index < 0 || index >= ranking.length || target < 0 || target >= ranking.length) return ranking
  const next = [...ranking]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
