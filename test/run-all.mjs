/**
 * Run every test suite and report one line each.
 *
 * A single runner with a single exit status is what makes "all green" checkable in one
 * go; suites run one at a time by hand leave a red exit code unread.
 *
 * Usage:
 *   node test/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Cheapest first, so a broken cheap suite fails the run before the slow ones spend time.
// A file whose name starts with `_` is a helper, not a suite.
const SUITES = [
  'scale.mjs',
  'input-spellings.mjs',
  'analyze-flatness.mjs',
  'check-render.mjs',
  'render-regressions.mjs',
  'scope-conflicts.mjs',
  'scope-regions.mjs',
  'palette.mjs',
  'palette-ops.mjs',
  'presets.mjs',
  'filters.mjs',
  'effects.mjs',
  'supersample.mjs',
  'psd-roundtrip.mjs',
  'selftest.mjs',
]

const present = new Set(readdirSync(here).filter((n) => n.endsWith('.mjs')))
const missing = SUITES.filter((s) => !present.has(s))
if (missing.length > 0) {
  console.error(`run-all: suite(s) not found: ${missing.join(', ')}`)
  process.exit(2)
}

const extra = [...present].filter((n) => !SUITES.includes(n) && !n.startsWith('_') && n !== 'run-all.mjs')
if (extra.length > 0) {
  console.log(`note: ${extra.length} unlisted suite(s) will not run: ${extra.join(', ')}`)
  console.log('      add them to SUITES above, or prefix the filename with _ if it is a helper.\n')
}

let failed = 0
const results = []
for (const suite of SUITES) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [join(here, suite)], { encoding: 'utf8' })
  const ms = Date.now() - started
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const summary = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).pop() ?? ''
  const ok = r.status === 0
  if (!ok) failed++
  results.push({ suite, ok, ms, summary })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${suite.padEnd(26)} ${String(ms).padStart(6)}ms  ${summary.slice(0, 70)}`)
  if (!ok) {
    // The tail is where a suite explains itself; a bare FAIL costs a rerun to read.
    const tail = out.split(/\r?\n/).slice(-12).join('\n  ')
    console.log(`      ${tail}`)
  }
}

console.log(`\n=== ${SUITES.length - failed}/${SUITES.length} suites passed ===`)
process.exit(failed === 0 ? 0 : 1)
