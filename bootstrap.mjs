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
import { dirname, join, relative, resolve, sep } from 'node:path'
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
const FORCE_TARGET = flag('--force-target')

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
 * Rewrite the machine-specific values in the composition.
 *
 * Three of them, all for the same reason: none works from a relative row.
 *
 *   the two local modules   `./x.mjs` resolves against the composition's `baseUrl`,
 *                           which in the desktop host is the PROFILE directory.
 *   `customSkillDirs`       the source anchors it on the harness home, which is right
 *                           only when this repository was installed to its default
 *                           name — a clone running `--target`, or an install under any
 *                           other name, would point at a directory that is not there.
 *   `engineDir`             this checkout's real path, the one value that genuinely
 *                           differs per machine.
 *
 * All three become absolute paths under `STAGE`, so the deployed composition depends on
 * nothing but where it was actually installed.
 */
function resolveComposition(composition) {
  let text = composition
  const done = []

  for (const file of LOCAL_MODULES) {
    const url = toFileUrl(join(STAGE, 'agent', file))
    const re = new RegExp(`^(\\s*name:\\s*)['"]?\\./${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm')
    if (re.test(text)) { text = text.replace(re, `$1"${url}"`); done.push(file) }
  }

  // Match the source literal whatever directory name it names, then write the real one.
  const skillsRe = /^(\s*-\s*)!!js\s+"process\.getBuiltinModule\('node:path'\)\.join\(process\.getBuiltinModule\('node:os'\)\.homedir\(\),\s*'\.dsh',\s*'[^']+',\s*'skills'\)"\s*$/m
  const skillsLiteral = `      - !!js "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), '.dsh', '${STAGE_DIRNAME}', 'skills')"`
  if (skillsRe.test(text)) {
    // Keep EXACTLY the source line's own indentation: this replacement sits inside a
    // `customSkillDirs:` list, and hard-coding six spaces produced a line that did not
    // line up with its neighbours — `bad indentation of a sequence entry`, which fails
    // the whole overlay. So the leading whitespace is captured from the match, not
    // written by hand.
    //
    // The value is written as a PLAIN QUOTED STRING, not as a `!!js` expression. The
    // source uses `!!js` because it derives the path from `homedir()` at load time; by
    // the time this runs the path is already known, so evaluating JavaScript at load
    // time buys nothing and adds a way for the value to come back as something other
    // than a string. A literal is one less thing to be wrong on the host that reads it.
    //
    // It is an ABSOLUTE path for the same reason: the source's `homedir()` join is right
    // only when the repository was installed under its default name. Quoted with `"…"`
    // because a path can contain an apostrophe (`ICED'R~1`), which inside a single-quoted
    // YAML scalar would end the string and turn a path into a parse error.
    text = text.replace(skillsRe, (_m, lead) => `${lead}"${toFileUrl(join(STAGE, 'skills'))}"`)
    done.push('customSkillDirs')
  } else if (text.includes(skillsLiteral.trim())) {
    done.push('customSkillDirs')
  }

  // The engine IS this repository: `bin/`, `src/` and `tools/` sit at its root, and
  // `engineDir` is the directory the design-tools row spawns `bin/design.mjs` from.
  //
  // Quoted with `"…"` and not `'…'`: a path can contain an apostrophe (a Windows short
  // name like `ICED'R~1` is exactly that), and inside a single-quoted YAML scalar that
  // apostrophe ends the string — producing `engineDir: 'C:/Users/ICED'R~1/…'`, which is
  // a parse error rather than a wrong path. Double quotes tolerate it.
  const engine = slash(REPO)
  if (text.includes('PLACEHOLDER_ENGINE_DIR')) {
    text = text.replace(/^(\s*engineDir:\s*)['"]PLACEHOLDER_ENGINE_DIR['"]\s*$/m, `$1"${engine}"`)
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

// A `--target` outside the deployment home would put a path into the REAL profile's
// patch that points at a directory someone is about to delete. The install then looks
// mounted to `--check` and is dead at the next restart, which is a confusing way to
// discover a test artefact. Refuse unless the caller says it means it.
//
// The check is on the resolved path, so `--target ../foo` is caught as well as
// `--target %TEMP%\x`, and it applies only to a run that WRITES (`--check` is read-only
// and is the safe way to inspect an out-of-tree stage).
const DEFAULT_STAGE = join(HARNESS_HOME, STAGE_DIRNAME)
if (!CHECK && !UNINSTALL && resolve(STAGE) !== resolve(DEFAULT_STAGE) && !FORCE_TARGET) {
  console.error(`bootstrap: refusing to point the "${PROFILE}" profile at a non-default stage.`)
  console.error(`           profile patch : ${PATCH}`)
  console.error(`           would declare : ${STAGE}`)
  console.error(`           default stage : ${DEFAULT_STAGE}`)
  if (!existsSync(STAGE)) console.error('           note          : that directory does not exist')
  console.error('')
  console.error('           The profile is shared state: a declaration pointing at a temporary')
  console.error('           directory breaks the agent as soon as that directory is removed.')
  console.error('           Pass --force-target if you really mean to install there.')
  process.exit(3)
}

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
//
//    `agent.cordis.yml` is deliberately NOT copied here: it is written in step 2 in its
//    RESOLVED form. Copying the source version first would be overwritten immediately,
//    and worse, comparing the source against a resolved destination would report drift
//    on every run — the copy loop and the resolve step would disagree forever.
const srcFiles = (await listFiles(join(REPO, 'agent'))).sort()
const skillsFiles = (await listFiles(join(REPO, 'skills'))).sort()
let copied = 0
for (const rel of [...srcFiles.map((r) => `agent/${r}`), ...skillsFiles.map((r) => `skills/${r}`)]) {
  if (rel === 'agent/agent.cordis.yml') continue
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

// 2. the deployed composition, with the machine-specific values already resolved.
//
//    The copy above brings the composition over in its SOURCE form, which still holds
//    PLACEHOLDER_ENGINE_DIR and the relative `./x.mjs` rows. Those only work after the
//    profile patch is written, so on their own they describe an install that cannot
//    load — and `--uninstall` removes the patch, leaving a stage whose composition is
//    broken. Writing the resolved text makes the staged copy a complete artifact: the
//    patch is what dsh reads, but the copy on disk is now correct by itself.
const deployedComposition = join(STAGE, 'agent', 'agent.cordis.yml')
let compositionChanged = false
if (!CHECK && !UNINSTALL) {
  let current = null
  try { current = await readFile(deployedComposition, 'utf8') } catch { /* absent */ }
  if (current !== resolved) { await mkdir(dirname(deployedComposition), { recursive: true }); await writeFile(deployedComposition, resolved, 'utf8'); compositionChanged = true }
} else {
  let current = null
  try { current = await readFile(deployedComposition, 'utf8') } catch { /* absent */ }
  compositionChanged = current !== resolved
}
if (compositionChanged) console.log(`  · wrote agent/agent.cordis.yml (resolved for this machine)`)

// 3. the pointer file, so a deployed copy with no checkout above it can still find
//    the engine even if the composition row is edited by hand
const pointerPath = join(STAGE, 'agent', 'engine-path.txt')
const enginePath = slash(REPO)
let pointerChanged = false
if (!CHECK && !UNINSTALL) {
  await mkdir(dirname(pointerPath), { recursive: true })
  let current = null
  try { current = (await readFile(pointerPath, 'utf8')).trim() } catch { /* absent */ }
  if (current !== enginePath) { await writeFile(pointerPath, enginePath + '\n', 'utf8'); pointerChanged = true }
} else {
  let current = null
  try { current = (await readFile(pointerPath, 'utf8')).trim() } catch { /* absent */ }
  pointerChanged = current !== enginePath
}
if (pointerChanged && !CHECK && !UNINSTALL) console.log(`  · wrote engine-path.txt -> ${enginePath}`)

// 4. the declaration
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
if (compositionChanged) console.log(`  deployed composition ${CHECK ? 'is out of date' : 'updated'}`)
if (pointerChanged) console.log(`  engine pointer ${CHECK ? 'is out of date' : 'updated'}`)
if (problems.length > 0) for (const p of problems) console.log(`  ! ${p}`)

if (CHECK) {
  // Drift is ANY of the three, not just the declaration: a stage holding a stale
  // composition or a pointer at another checkout is a broken install that the patch
  // alone would not reveal.
  const drift = copied > 0 || changed || compositionChanged || pointerChanged
  const why = [
    copied > 0 ? `${copied} file(s)` : null,
    changed ? 'declaration not in sync' : null,
    compositionChanged ? 'deployed composition not in sync' : null,
    pointerChanged ? 'engine pointer not in sync' : null,
  ].filter(Boolean).join(', ')
  console.log(`\nverdict: ${problems.length > 0 ? 'FAILED — source unusable (exit 2)' : drift ? `DRIFT — ${why} (exit 1)` : 'in sync (exit 0)'}`)
  process.exit(problems.length > 0 ? 2 : drift ? 1 : 0)
}

console.log(UNINSTALL
  ? '\nthe declaration is removed; the staged files are left in place.'
  : '\nRestart dsh so the profile is recomposed, then pick the agent in a New Session.')
