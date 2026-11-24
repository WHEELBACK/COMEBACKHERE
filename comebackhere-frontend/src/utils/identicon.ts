/**
 * Deterministic identicon generator.
 *
 * Produces a reproducible 5×5 pixel-grid SVG identicon from any string
 * (typically a Stellar address). The output is purely computed from the
 * input — no network requests, no external services.
 *
 * Algorithm:
 *  1. Compute a simple 32-bit FNV-1a hash of the input string.
 *  2. Derive foreground colour from the first 3 bytes of the hash.
 *  3. Fill a 5×5 grid where each cell is "on" based on successive bits of
 *     the remaining hash bytes. The grid is mirrored horizontally so that
 *     the pattern is symmetric and recognisable (like GitHub identicons).
 */

/** FNV-1a 32-bit hash — fast, deterministic, no crypto required. */
function fnv1a32(str: string): number {
  let hash = 2166136261 // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    // Multiply by FNV prime (32-bit, allow overflow via unsigned shift)
    hash = (Math.imul(hash, 16777619) >>> 0)
  }
  return hash >>> 0
}

/**
 * Generates an array of 32-bit hashes from the input string to provide
 * enough bits for an arbitrary-length grid.
 */
function hashChain(str: string, count: number): number[] {
  const chain: number[] = []
  let seed = fnv1a32(str)
  for (let i = 0; i < count; i++) {
    seed = fnv1a32(String(seed) + String(i) + str)
    chain.push(seed)
  }
  return chain
}

export interface IdenticonOptions {
  /** Side length in pixels (default: 40). */
  size?: number
  /** Background fill (default: '#f0f0f0'). */
  background?: string
}

/**
 * Returns an SVG string representing the identicon for the given address.
 *
 * @param address  The signer address (or any string) to generate from.
 * @param options  Optional size / background overrides.
 */
export function generateIdenticon(
  address: string,
  options: IdenticonOptions = {},
): string {
  const size = options.size ?? 40
  const background = options.background ?? '#f0f0f0'

  const GRID = 5 // 5×5 cell grid (horizontally mirrored → 3 unique columns)
  const COLS = Math.ceil(GRID / 2) // 3 unique columns, mirrored to 5

  // Derive a stable colour from the address
  const colorHash = fnv1a32(address)
  const r = (colorHash >> 16) & 0xff
  const g = (colorHash >> 8) & 0xff
  const b = colorHash & 0xff
  // Boost saturation by shifting components away from mid-grey
  const boost = (v: number) => Math.round(v * 0.6 + 40)
  const fg = `rgb(${boost(r)},${boost(g)},${boost(b)})`

  // Derive cell fill pattern (5×3 unique cells = 15 bits, one hash is enough)
  const patternHash = hashChain(address, 1)[0]
  const cellSize = size / GRID

  const rects: string[] = []

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < COLS; col++) {
      const bitIndex = row * COLS + col
      const filled = (patternHash >> bitIndex) & 1

      if (!filled) continue

      // Left side
      const x1 = col * cellSize
      const y = row * cellSize
      rects.push(`<rect x="${x1}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${fg}"/>`)

      // Mirror to right side (skip centre column self-mirror)
      const mirrorCol = GRID - 1 - col
      if (mirrorCol !== col) {
        const x2 = mirrorCol * cellSize
        rects.push(`<rect x="${x2}" y="${y}" width="${cellSize}" height="${cellSize}" fill="${fg}"/>`)
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">`,
    `  <rect width="${size}" height="${size}" fill="${background}"/>`,
    ...rects,
    `</svg>`,
  ].join('\n')
}
