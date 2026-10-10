#!/usr/bin/env node
/**
 * Install this agent into a dsh profile, so the GUI and the CLI can select it.
 *
 * WHAT IT DOES, AND WHY IT IS ONE COMMAND
 * ---------------------------------------
 * A preset becomes selectable by being DECLARED in a profile composition; dsh 0.2
 * does not discover presets on disk, so a directory of files on its own stays
 * inert. This script puts the files where the declaration expects them and writes
 * the declaration:
 *
 *   1. copy `agent/` to `$DSH_HOME/design-agent-test/agent/`
 *   2. write one `@deepseek-ai/dsh-agent-preset` row into the target profile's
 *      `cordis.patch.yml`
 *
 * Two path forms are resolved at install time, because both are machine-specific
 * and neither works from a relative row:
 *
 *   `design-policy.mjs` and `design-tools.mjs` become `file://` URLS. A relative row
 *   resolves against the composition's `baseUrl`, which in the desktop host is the
 *   PROFILE directory rather than the preset's own; and a bare absolute path like
 *   `C:/…` is not an importable specifier at all — Node's default ESM loader accepts
 *   only the `file`, `data` and `node` schemes.
 *
 *   `engineDir` becomes this checkout's real `engine` path. It is the one value that
 *   genuinely differs per machine.
 *
 * `--check` writes nothing and its exit code is the verdict: 0 in sync, 1 drift,
 * 2 unusable source. Re-running is safe — the declaration is delimited by sentinel
 * comments, so it is replaced rather than appended.
 *
 * Usage:
 *   node bootstrap.mjs                      # install into the desktop profile
 *   node bootstrap.mjs --profile web        # a different profile
 *   node bootstrap.mjs --check              # report only; exit code is the verdict
 *   node bootstrap.mjs --uninstall          # remove the declaration (files stay)
 *   node bootstrap.mjs --target DIR         # stage the files somewhere else
 */
import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'

const REPO = import.meta.dirname
const HARNESS_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** The preset id, its directory name under the harness home, and its sort position. */
const PRESET_ID = 'design-test'
const STAGE_DIRNAME = 'design-agent-test'
const ORDER = 30

/** Local modules the composition declares as `./x.mjs`, rewritten to `file://` URLs. */
const LOCAL_MODULES = ['design-policy.mjs', 'design-tools.mjs']

const BEGIN = `# ── agent:${PRESET_ID} — written by bootstrap.mjs; edits here are overwritten ──`
const END = `# ── end agent:${PRESET_ID} ──`

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}

const PROFILE = value('--profile', process.env.DSH_PROFILE ?? 'desktop')
const PATCH = join(HARNESS_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
const STAGE = value('--target', join(HARNESS_HOME, STAGE_DIRNAME))
const CHECK = flag('--check')
const UNINSTALL = flag('--uninstall')

const slash = (p) => p.split(sep).join('/')
const toFileUrl = (p) => 'file:///' + slash(p).replace(/^\/+/, '')

/** Every file under `dir`, as POSIX relative paths. */
async function listFiles(dir, base = dir, out = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch (e) {
    if (e.code === 'ENOENT') return out
    throw e
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, base, out)
    else out.push(slash(relative(base, full)))
  }
  return out
}

/** Read the display name and description out of `agent/preset.yml`. */
function readPresetMeta(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(raw)
    if (m === null) continue
    let v = m[2].trim()
    if (/^['"]/.test(v) && v.length > 1 && v.endsWith(v[0])) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** The declarative block: preset metadata plus the composition, indented. */
function buildBlock(composition, meta) {
  const head = [
    BEGIN,
    '- insert:',
    `    - id: preset-${PRESET_ID}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${PRESET_ID}`,
    ...(meta.name === undefined ? [] : [`        name: '${meta.name.replace(/'/g, "''")}'`]),
    ...(meta.description === undefined ? [] : [`        description: '${meta.description.replace(/'/g, "''")}'`]),
    `        order: ${ORDER}`,
    '        plugins:',
  ]
  const body = composition
    .split(/\r?\n/)
    .map((l) => (l.trim() === '' ? '' : ' '.repeat(10) + l))
    .join('\n')
    .replace(/\n+$/, '')
  return [...head, body, END].join('\n')
}

/**
 * Rewrite the two machine-specific values in the composition.
 *
 * `engineDir` arrives as PLACEHOLDER_ENGINE_DIR and the local modules as `./x.mjs`;
 * both are replaced with paths that are correct for this machine and this checkout.
 */
function resolveComposition(composition) {
  let text = composition
  const done = []

  for (const file of LOCAL_MODULES) {
    const url = toFileUrl(join(STAGE, 'agent', file))
    const re = new RegExp(`^(\\s*name:\\s*)['"]?\\./${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm')
    if (re.test(text)) { text = text.replace(re, `$1"${url}"`); done.push(file) }
  }

  const skills = toFileUrl(join(STAGE, 'skills'))
  const skillsRe = /^(\s*-\s*)!!js\s+"process\.getBuiltinModule\('node:path'\)\.join\(process\.getBuiltinModule\('node:os'\)\.homedir\(\),\s*'\.dsh',\s*'design-agent-test',\s*'skills'\)"\s*$/m
  const skillsLiteral = `      - !!js "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), '.dsh', '${STAGE_DIRNAME}', 'skills')"`
  if (skillsRe.test(text)) {
    text = text.replace(skillsRe, skillsLiteral)
    done.push('customSkillDirs')
  } else if (text.includes(skillsLiteral.trim())) {
    done.push('customSkillDirs')
  }

  // The engine IS this repository: `bin/`, `src/` and `tools/` sit at its root, and
  // `engineDir` is the directory the design-tools row spawns `bin/design.mjs` from.
  const engine = slash(REPO)
  if (text.includes('PLACEHOLDER_ENGINE_DIR')) {
    text = text.replace(/^(\s*engineDir:\s*)'PLACEHOLDER_ENGINE_DIR'\s*$/m, `$1'${engine}'`)
    done.push(`engineDir -> ${engine}`)
  }

  return { text, done, unresolved: text.includes('PLACEHOLDER_ENGINE_DIR') ? ['engineDir'] : [] }
}

/** The block currently in `text`, or null when it carries no declaration. */
function currentBlock(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === BEGIN.trim())
  if (start < 0) return null
  let stop = -1
  for (let i = start + 1; i < lines.length; i++) if (lines[i].trim() === END.trim()) { stop = i; break }
  return lines.slice(start, stop >= 0 ? stop + 1 : lines.length).join('\n')
}

/**
 * Replace or append the sentinel-delimited block; `null` removes it.
 *
 * Whether anything CHANGED is decided by comparing block text rather than by comparing
 * the rebuilt file: rebuilding normalizes the blank lines around the block, so an
 * already-correct file came back looking different from its own reconstruction and
 * `--check` reported drift forever. The only comparison that means anything is between
 * the block on disk and the block this run would write.
 */
function spliceBlock(text, block) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim() === BEGIN.trim())
  if (start >= 0) {
    let stop = -1
    for (let i = start + 1; i < lines.length; i++) if (lines[i].trim() === END.trim()) { stop = i; break }
    const before = lines.slice(0, start)
    const after = stop >= 0 ? lines.slice(stop + 1) : []
    while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
    return [...before, ...(block === null ? [] : block.split('\n')), ...after].join('\n')
  }
  if (block === null) return text
  return `${text.replace(/\s+$/, '')}\n\n${block}\n`
}

// ── run ─────────────────────────────────────────────────────────────────────

console.log(`bootstrap: repo    ${REPO}`)
console.log(`           profile ${PROFILE}`)
console.log(`           patch   ${PATCH}`)
console.log(`           stage   ${STAGE}`)
console.log(`           mode    ${CHECK ? 'check' : UNINSTALL ? 'uninstall' : 'install'}\n`)

const compositionPath = join(REPO, 'agent', 'agent.cordis.yml')
if (!existsSync(compositionPath)) {
  console.error(`bootstrap: no agent/agent.cordis.yml in ${REPO}`)
  process.exit(2)
}

let meta = {}
try { meta = readPresetMeta(await readFile(join(REPO, 'agent', 'preset.yml'), 'utf8')) } catch { /* optional */ }

const { text: resolved, done, unresolved } = resolveComposition(await readFile(compositionPath, 'utf8'))
for (const d of done) console.log(`  · resolved ${d}`)
for (const u of unresolved) console.log(`  ! unresolved ${u}`)

const problems = []
if (unresolved.length > 0) problems.push(`composition still contains a placeholder: ${unresolved.join(', ')}`)

// 1. the files
const srcFiles = (await listFiles(join(REPO, 'agent'))).sort()
const skillsFiles = (await listFiles(join(REPO, 'skills'))).sort()
let copied = 0
for (const rel of [...srcFiles.map((r) => `agent/${r}`), ...skillsFiles.map((r) => `skills/${r}`)]) {
  const from = join(REPO, rel)
  const to = join(STAGE, rel)
  let same = false
  try { same = (await readFile(from, 'utf8')) === (await readFile(to, 'utf8')) } catch { /* absent */ }
  if (same) continue
  copied++
  if (!CHECK && !UNINSTALL) {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
  }
}

// 2. the pointer file, so a deployed copy with no checkout above it can still find
//    the engine even if the composition row is edited by hand
const pointerPath = join(STAGE, 'agent', 'engine-path.txt')
const enginePath = slash(REPO)
let pointerChanged = false
if (!CHECK && !UNINSTALL) {
  await mkdir(dirname(pointerPath), { recursive: true })
  let current = null
  try { current = (await readFile(pointerPath, 'utf8')).trim() } catch { /* absent */ }
  if (current !== enginePath) { await writeFile(pointerPath, enginePath + '\n', 'utf8'); pointerChanged = true }
}
if (pointerChanged) console.log(`  · wrote engine-path.txt -> ${enginePath}`)

// 3. the declaration
let patchText = ''
try { patchText = await readFile(PATCH, 'utf8') } catch { patchText = '' }
const block = buildBlock(resolved, meta)
const present = currentBlock(patchText)
// Compare BLOCK TEXT, not the rebuilt file — see spliceBlock for why.
const changed = UNINSTALL ? present !== null : present !== block
const next = spliceBlock(patchText, UNINSTALL ? null : block)

if (!CHECK && changed) {
  await mkdir(dirname(PATCH), { recursive: true })
  await writeFile(PATCH, next, 'utf8')
}

console.log(`\n  files ${copied} to copy, declaration ${changed ? 'changed' : 'already in sync'}`)
if (problems.length > 0) for (const p of problems) console.log(`  ! ${p}`)

if (CHECK) {
  const drift = copied > 0 || changed
  console.log(`\nverdict: ${problems.length > 0 ? 'FAILED — source unusable (exit 2)' : drift ? `DRIFT — ${copied} file(s), declaration ${changed ? 'not in sync' : 'ok'} (exit 1)` : 'in sync (exit 0)'}`)
  process.exit(problems.length > 0 ? 2 : drift ? 1 : 0)
}

console.log(UNINSTALL
  ? '\nthe declaration is removed; the staged files are left in place.'
  : '\nRestart dsh so the profile is recomposed, then pick the agent in a New Session.')
