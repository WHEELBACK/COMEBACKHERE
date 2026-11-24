/**
 * jsdom does not evaluate media queries, so these tests check the
 * stylesheets themselves: every animated component must ship a
 * prefers-reduced-motion rule that switches its motion off.
 */
import { describe, it, expect } from "vitest"

// Vitest stubs CSS imports (including ?raw) to empty strings, so read the
// stylesheets from disk. node:fs is loaded dynamically because the app
// tsconfig has no Node types.
interface Fs {
  readFileSync(path: string, encoding: "utf8"): string
  readdirSync(path: string, options: { recursive: true }): string[]
}
const nodeFs = "node:fs"
const fs = (await import(/* @vite-ignore */ nodeFs)) as Fs
// Vitest runs from the package root (where vite.config.ts lives).
const { process } = globalThis as unknown as { process: { cwd(): string } }
const SRC = `${process.cwd()}/src/`
const readCss = (path: string) => fs.readFileSync(SRC + path, "utf8")

const appCss = readCss("App.css")
const toastCss = readCss("components/Toast.css")
const skeletonCss = readCss("components/Skeleton.css")

function reducedMotionBlocks(css: string): string {
  const marker = "@media (prefers-reduced-motion: reduce)"
  return css
    .split(marker)
    .slice(1)
    .join("\n")
}

describe("prefers-reduced-motion support", () => {
  it("Toast.css removes the slide-in animation and exit slide", () => {
    const rules = reducedMotionBlocks(toastCss)
    expect(rules).toMatch(/\.toast\s*\{[^}]*animation:\s*none/)
    expect(rules).toMatch(/\.toast--exiting\s*\{[^}]*transform:\s*none/)
  })

  it("Skeleton.css replaces the pulse with a static placeholder", () => {
    const rules = reducedMotionBlocks(skeletonCss)
    expect(rules).toMatch(/\.skeleton\s*\{[^}]*animation:\s*none/)
    expect(rules).toMatch(/\.skeleton\s*\{[^}]*opacity:/)
  })

  it("App.css stops the spinner and has a global fallback", () => {
    const rules = reducedMotionBlocks(appCss)
    expect(rules).toMatch(/\.spinner\s*\{[^}]*animation:\s*none/)
    expect(rules).toMatch(/animation-duration:\s*0\.01ms\s*!important/)
    expect(rules).toMatch(/transition-duration:\s*0\.01ms\s*!important/)
  })

  it("every stylesheet with an animation also has a reduced-motion rule", () => {
    const missing = fs
      .readdirSync(SRC, { recursive: true })
      .filter((path) => path.endsWith(".css"))
      .filter((path) => /(^|[\s;{])animation\s*:/.test(readCss(path)))
      .filter((path) => !readCss(path).includes("prefers-reduced-motion: reduce"))
    expect(missing).toEqual([])
  })
})
