import { SIGNALS } from './rules.js'

/**
 * score(text) -> { score, hits, cap }: sum of the weights of the signal groups found (each counts once),
 * their names, and the cap of a capping group that hit ('review') or null. Pure.
 */
export function score(text) {
  const hits = SIGNALS.filter((s) => s.re.test(text))
  return { score: hits.reduce((n, s) => n + s.weight, 0), hits: hits.map((s) => s.name), cap: hits.find((s) => s.cap)?.cap ?? null }
}
