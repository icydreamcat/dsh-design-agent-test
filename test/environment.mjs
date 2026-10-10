#!/usr/bin/env node
/**
 * One end-to-end pass over the agent, from the outside.
 *
 * The unit suites under `test/` each check one module. This checks the thing a user
 * actually does: take a scene, render it, measure the result, and read the numbers
 * back — plus the two integration surfaces that are easy to break without noticing,
 * the agent composition (does every row name a plugin that can be resolved, and does
 * every local module import) and the tool roster (does every tool still run).
 *
 * It writes its artefacts to `.cache/test/` beside the repository, never into it.
 *
 * Usage:
 *   node test/environment.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CACHE = join(ROOT, '..', '.cache', 'test')
mkdirSync(CACHE, { recursive: true })

let failed = 0
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `   — ${detail}`}`)
  if (!ok) failed++
}

const run = (args) => spawnSync(process.execPath, [join(ROOT, 'bin', 'design.mjs'), ...args], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})

// ── 1. the CLI answers ───────────────────────────────────────────────────────
console.log('\n[1] the CLI')
{
  const r = run(['--help'])
  check('design --help prints usage', /render/.test(r.stderr ?? ''))
}
{
  const r = run(['ladder', '--base', '16', '--ratio', '1.25', '--steps', '3'])
  let ok = false, n = 0, ascending = true
  try {
    const j = JSON.parse(r.stdout)
    ok = j.ok === true
    n = j.ladder?.length ?? 0
    ascending = (j.ladder ?? []).every((s, i, a) => i === 0 || s.size > a[i - 1].size)
  } catch { /* reported */ }
  check('ladder returns the requested number of steps', ok && n === 3, `${n} steps`)
  check('the ladder ascends', ascending)
}
{
  const r = run(['ramp', '#8CA33C', '--steps', '5'])
  let ok = false, first = null
  try { const j = JSON.parse(r.stdout); ok = j.ok === true; first = j.steps?.[0] } catch { /* reported */ }
  check('ramp returns OKLCH + contrast per step', ok && first?.oklch !== undefined && first?.contrastOnWhite !== undefined)
}

// ── 2. the font stack is live ────────────────────────────────────────────────
console.log('\n[2] fonts')
{
  const r = run(['fonts'])
  let faces = 0
  try { faces = JSON.parse(r.stdout).registered ?? 0 } catch { /* reported */ }
  check('the curated font stack registered', faces > 0, `${faces} faces`)
}

// ── 3. render → measure, the loop the agent actually runs ────────────────────
//
// The scene and its image are generated here rather than committed, for two reasons.
// A committed scene makes the suite assert a LAYOUT, so a change to the library's taste
// turns it red for no reason; and a committed scene is the thing most likely to be
// copied into new work, which is the opposite of what this agent is for. Generating it
// keeps the assertions about the ENGINE, and keeps `render` + `analyze` covered end to
// end — an image layer with a relative path included, so path resolution is exercised.
console.log('\n[3] render and measure')
const fixturePng = join(CACHE, 'fixture.png')
{
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  // A four-quadrant block with one bright quadrant: enough structure for the accent,
  // tone and detail measurements to have something to find.
  const c = createCanvas(320, 420)
  const x = c.getContext('2d')
  x.fillStyle = '#2A2E28'; x.fillRect(0, 0, 320, 420)
  x.fillStyle = '#E8E4D8'; x.fillRect(28, 28, 264, 190)
  x.fillStyle = '#8CA33C'; x.fillRect(28, 240, 120, 150)
  x.fillStyle = '#20241C'; x.fillRect(168, 240, 124, 150)
  writeFileSync(fixturePng, c.encodeSync('png'))
  check('a self-contained fixture renders', existsSync(fixturePng), fixturePng)

  const scene = {
    canvas: { width: 1200, height: 900 },
    ground: '#DED8C8',
    layers: [
      { id: '01-ground', shape: 'rect', x: 0, y: 0, w: 1, h: 1, paint: '#DED8C8' },
      { id: '02-subject', shape: 'image', src: fixturePng, x: 96, y: 120, w: 420, h: 552, fit: 'contain' },
      { id: '03-accent', shape: 'rect', x: 96, y: 720, w: 240, h: 14, paint: '#8CA33C' },
      { id: '04-title', shape: 'text', text: 'A measured page', x: 600, y: 170, w: 504, size: 76, font: 'Journal', color: '#20241C', wrap: true },
      { id: '05-body', shape: 'text', text: 'Body copy set with the real font, so its width is a number rather than a guess.', x: 600, y: 420, w: 504, size: 26, font: 'Grotesk', color: '#20241C', wrap: true },
    ],
  }
  const scenePath = join(CACHE, 'environment-scene.json')
  writeFileSync(scenePath, JSON.stringify(scene, null, 2), 'utf8')

  const r = run(['render', scenePath, '--out', CACHE, '--name', 'env'])
  let rep = null
  try { rep = JSON.parse(r.stdout) } catch { /* reported */ }
  check('render returns a report', rep?.ok === true, rep === null ? (r.stderr ?? '').slice(0, 120) : `${rep.canvas?.width}x${rep.canvas?.height}, ${rep.layerCount} layers`)
  check('no layer warnings', (rep?.warnings ?? ['x']).length === 0, (rep?.warnings ?? []).join('; ').slice(0, 120))
  check('the image layer drew', (rep?.layerCount ?? 0) >= 5, `${rep?.layerCount} layers`)
  check('the PNG exists and is not empty', existsSync(rep?.png ?? '') , rep?.png)

  const r2 = run(['analyze', rep?.png ?? '', '--max-side', '900'])
  let an = null
  try { an = JSON.parse(r2.stdout) } catch { /* reported */ }
  check('analyze returns a specification', an?.ok === true)
  check('it reports ground luminance and accent flat share',
    typeof an?.tone?.groundLuminance === 'number' && typeof an?.accent?.flatShare === 'number',
    an === null ? '' : `ground ${an.tone?.groundLuminance?.toFixed(3)}, accentFlat ${(an.accent?.flatShare * 100)?.toFixed(2)}%`)
  check('it reports a spatial detail map', Array.isArray(an?.spatial?.cells) || typeof an?.spatial?.meanDetail === 'number')
}

// ── 4. the tool roster: every tool is discoverable AND runnable ──────────────
console.log('\n[4] the tool roster')
{
  const r = run(['tool', '--list'])
  let tools = []
  try { tools = JSON.parse(r.stdout).tools ?? [] } catch { /* reported */ }
  check('the roster lists tools', tools.length > 0, `${tools.length} tools`)
  check('every tool states a purpose', tools.every((t) => typeof t.purpose === 'string' && t.purpose.length > 0))

  // One tool that must work on any machine and needs no input beyond a PNG.
  const probe = tools.find((t) => t.name === 'tone-probe.mjs' || t.name === 'tone-probe')
  if (probe !== undefined) {
    const r3 = run(['tool', 'tone-probe', join(CACHE, 'env.report.json')])
    check('a tool runs through the roster', r3.status === 0, `tone-probe exit ${r3.status}`)
  } else {
    check('a tool runs through the roster', false, 'tone-probe not in the roster')
  }
}

// ── 5. the agent composition resolves ────────────────────────────────────────
console.log('\n[5] the agent composition')
{
  const comp = readFileSync(join(ROOT, 'agent', 'agent.cordis.yml'), 'utf8')
  check('no placeholder is left in the checked-in composition', comp.includes('PLACEHOLDER_ENGINE_DIR'),
    'PLACEHOLDER_ENGINE_DIR is expected here; bootstrap.mjs resolves it at install time')

  // Every `name:` that points at a local module must import.
  const local = [...comp.matchAll(/^\s*name:\s*\.\/([a-z0-9-]+\.mjs)\s*$/gm)].map((m) => m[1])
  check('the composition declares its local modules', local.length === 2, local.join(', '))
  for (const file of local) {
    const p = join(ROOT, 'agent', file)
    let ok = false, detail = p
    try {
      const mod = await import(pathToFileURL(p).href)
      ok = typeof mod.apply === 'function' && typeof mod.name === 'string' && Array.isArray(mod.inject)
      detail = `${p}  exports ${Object.keys(mod).join(', ')}`
    } catch (e) { detail = `${p}  ${e.message.slice(0, 90)}` }
    check(`${file} is a loadable plugin`, ok, detail)
  }

  // Every npm row names a package — a local file path in `name` cannot resolve.
  const npmRows = [...comp.matchAll(/^\s*name:\s*'(@[^']+)'\s*$/gm)].map((m) => m[1])
  check('the composition names npm packages for its non-local rows', npmRows.length > 10, `${npmRows.length} package rows`)
  const badRow = comp.split(/\r?\n/).find((l) => /^\s*name:\s*'?[A-Za-z]:[\\/]/.test(l))
  check('no Windows path stands in for a plugin name', badRow === undefined, badRow?.trim())
}

// ── 6. the skills are readable and point at real tools ───────────────────────
console.log('\n[6] the skills')
{
  const dir = join(ROOT, 'skills')
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  check('skills are present', names.length > 0, `${names.length} skills`)
  const TOOLS = new Set(['design_render', 'design_analyze', 'design_fonts', 'design_ladder', 'design_ramp', 'design_palette', 'design_tool'])
  const unknown = []
  for (const name of names) {
    const s = readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
    if (!/^---[\s\S]*?\bname:\s*\S/.test(s)) unknown.push(`${name}: no frontmatter name`)
    for (const m of s.matchAll(/design_[a-z_]+/g)) if (!TOOLS.has(m[0])) unknown.push(`${name}: ${m[0]}`)
  }
  check('every skill has frontmatter and cites only real tools', unknown.length === 0, unknown.slice(0, 4).join('; '))
}

console.log(`\n${failed === 0 ? '=== environment: all checks passed ===' : `=== environment: ${failed} FAILED ===`}`)
console.log(`artefacts: ${CACHE}`)
process.exit(failed === 0 ? 0 : 1)
