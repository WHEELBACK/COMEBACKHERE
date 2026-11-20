/** Evicts expired entries first, then oldest-inserted entries, until size <= max. */
export function pruneExpiring<V extends { expiresAt: number }>(map: Map<string, V>, max: number, now = Date.now()): void {
  if (map.size <= max) return
  for (const [k, v] of map) {
    if (v.expiresAt <= now) map.delete(k)
  }
  while (map.size > max) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}
