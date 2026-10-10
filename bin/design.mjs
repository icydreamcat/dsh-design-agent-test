#!/usr/bin/env node
/**
 * The design engine command line.
 *
 * This is the engine's only entry point, and it is deliberately a plain CLI: an
 * agent, a script or a person drives the same binary over a process boundary, so a
 * harness can be replaced without touching the engine.
 *
 * Every subcommand writes ONE machine-readable JSON object to stdout and human
 * commentary to stderr. That split is what lets a caller parse the result without
 * the report text getting in the way, while a failure still leaves a readable
 * reason behind.
 *
 * Commands
 *   render   <scene.json> --out <dir>        render a scene; write PNG + report
 *   analyze  <image>                         extract a design specification
 *   fonts                                    list usable families and axes
 *   ladder   [--base 16 --ratio 1.25]        print a typographic scale
 *   ramp     <color> [--steps 9]             print an OKLab colour ramp
 *   palette  ops|presets|show|apply|run      the filter vocabulary and library
 *   tool     [--list | --describe NAME | NAME ...]   the measurement tool roster
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute, basename, extname } from 'node:path'
import { parseArgs } from 'node:util'

import { registerFonts, fontFamilyReport } from '../src/fonts.mjs'
import { renderScene, readBuffer, writeBuffer } from '../src/render.mjs'
import { writePsd } from '../src/psd.mjs'
import { analyseReference } from '../src/analyze.mjs'
import { scaleLadder } from '../src/text.mjs'
import { scaleRamp, toOklch, contrastRatio } from '../src/color.mjs'
import { scaleScene } from '../src/scale.mjs'

// Fonts must be registered before any canvas context exists; every subcommand that
// measures or draws depends on it.
registerFonts()

/** Emit the single JSON result object. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

/** Fail with a clear reason on stderr and a non-zero exit. */
function fail(message, extra) {
  process.stderr.write('design: ' + message + '\n')
  if (extra !== undefined) process.stderr.write(JSON.stringify(extra, null, 2) + '\n')
  process.exit(1)
}

/** Read a JSON file, resolving relative to cwd. */
function readJson(path) {
  const p = isAbsolute(path) ? path : resolve(process.cwd(), path)
  if (!existsSync(p)) fail(`file not found: ${p}`)
  try {
    return { data: JSON.parse(readFileSync(p, 'utf8')), path: p }
  } catch (error) {
    fail(`could not parse JSON from ${p}: ${error.message}`)
  }
}

const argv = process.argv.slice(2)
const command = argv[0]

if (command === undefined || command === '-h' || command === '--help') {
  process.stderr.write(
    'design <command> [options]\n\n' +
    '  render  <scene.json> [--out DIR] [--name FILE] [--psd] [--scale N] [--supersample N]\n' +
    '  analyze <image> [--max-side N] [--cols N --rows N] [--bins N]\n' +
    '  palette ops    [--kind KIND]                 # the operator vocabulary\n' +
    '  palette presets                              # the named filter library\n' +
    '  palette show   <preset> [--set k=v]          # the operator graph a preset builds\n' +
    '  palette apply  <image> <preset> [--set k=v] [--out FILE] [--graph FILE]\n' +
    '  palette run    <image> --graph FILE [--out FILE]\n' +
    '  tool    [--list | --describe NAME | <name> [args...]]\n' +
    '  fonts\n' +
    '  ladder  [--base N] [--ratio N] [--steps N]\n' +
    '  ramp    <#RRGGBB> [--steps N]\n',
  )
  process.exit(command === undefined ? 1 : 0)
}

// ── palette ─────────────────────────────────────────────────────────────────
//
// The filter vocabulary, as data a caller can inspect and run without writing
// JavaScript. A preset is a named operator graph and an operator is a record, so
// `palette show` prints the graph rather than hiding it, and `palette apply` reports
// what each step did.
if (command === 'palette') {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      kind: { type: 'string' },
      params: { type: 'string' },
      out: { type: 'string' },
      graph: { type: 'string' },
      set: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  })
  const sub = positionals[0]

  // Two ways to state parameters, because `--params '{"a":1}'` is painful in every
  // Windows shell: the quotes that protect JSON are the quotes the shell eats first.
  // `--set key=value` needs no quoting and covers what a caller actually does —
  // override one or two numbers.
  const paramsOf = () => {
    const sets = {}
    for (const raw of values.set ?? []) {
      const eq = String(raw).indexOf('=')
      if (eq <= 0) fail(`--set needs key=value, got "${raw}"`)
      const key = String(raw).slice(0, eq)
      const text = String(raw).slice(eq + 1)
      const num = Number(text)
      sets[key] = text === '' ? ''
        : Number.isFinite(num) ? num
          : text === 'true' ? true
            : text === 'false' ? false
              : text
    }
    if (values.params === undefined) return sets
    let parsed
    try { parsed = JSON.parse(values.params) } catch (e) {
      fail(`--params is not valid JSON: ${e.message}. On Windows prefer --set key=value.`)
    }
    return { ...parsed, ...sets }
  }

  if (sub === 'ops' || sub === undefined) {
    const { POINTWISE } = await import('../src/palette.mjs')
    const { KERNEL_SHAPES } = await import('../src/kernel.mjs')
    const kinds = {
      spatial: ['sample', 'rank'],
      pointwise: Object.keys(POINTWISE),
      mixing: ['blend', 'similarityMask', 'luminanceMask'],
      source: ['solid', 'noise'],
    }
    const want = values.kind === undefined ? null : values.kind
    const out = {}
    for (const [kind, names] of Object.entries(kinds)) {
      if (want !== null && want !== kind) continue
      out[kind] = names
    }
    emit({
      ok: true,
      kinds: out,
      kernels: KERNEL_SHAPES,
      constantsOfATime: ['box', 'gaussian', 'line'],
      note:
        'A filter is a list of operators. Spatial ops take a kernel. A value-producing op ' +
        '(solid, noise) declares produces:true and does not advance the current image. ' +
        'Use `palette presets` for the named library and `palette show <preset>` for its graph.',
    })
    process.exit(0)
  }

  if (sub === 'presets') {
    const { LIBRARY, DEFAULTS } = await import('../src/presets.mjs')
    emit({
      ok: true,
      presets: Object.keys(LIBRARY).map((name) => ({
        name,
        defaults: Object.fromEntries(
          Object.entries(DEFAULTS[name] ?? {}).filter(([k]) => k !== 'range'),
        ),
        range: (DEFAULTS[name] ?? {}).range ?? null,
      })),
      note: 'Parameters keep the names and ranges their documentation uses, so a description transfers.',
    })
    process.exit(0)
  }

  if (sub === 'show') {
    const name = positionals[1]
    if (name === undefined) fail('palette show needs a preset name')
    const { build } = await import('../src/presets.mjs')
    const { describeGraph } = await import('../src/palette.mjs')
    const graph = build(name, paramsOf())
    emit({ ok: true, preset: name, graph, summary: describeGraph(graph) })
    process.exit(0)
  }

  // apply / run both need an image on disk.
  const target = positionals[1]
  if (target === undefined) fail(`palette ${sub} needs an image path`)
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const { run: runGraph, describeGraph } = await import('../src/palette.mjs')
  const { build } = await import('../src/presets.mjs')
  const { measure } = await import('../src/measure.mjs')

  let graph
  if (sub === 'run') {
    if (values.graph === undefined) fail('palette run needs --graph FILE')
    graph = readJson(values.graph)
    if (!Array.isArray(graph)) fail('--graph must contain a JSON array of operators')
  } else if (sub === 'apply') {
    const name = positionals[2]
    if (name === undefined) fail('palette apply needs a preset name')
    graph = build(name, paramsOf())
  } else {
    fail(`unknown palette subcommand "${sub}". Use ops, presets, show, apply or run.`)
  }

  const img = await loadImage(resolve(target))
  const canvas = createCanvas(img.width, img.height)
  canvas.getContext('2d').drawImage(img, 0, 0)
  const before = readBuffer(canvas)

  let r
  try {
    r = runGraph(before, graph)
  } catch (e) {
    fail(`palette ${sub} failed: ${e.message}`, { graph })
  }

  const outPath = values.out === undefined
    ? resolve('out', `${basename(target, extname(target))}-${sub === 'apply' ? positionals[2] : 'graph'}.png`)
    : resolve(values.out)
  mkdirSync(dirname(outPath), { recursive: true })
  const outCanvas = createCanvas(img.width, img.height)
  writeBuffer(outCanvas, r.image)
  writeFileSync(outPath, outCanvas.toBuffer('image/png'))

  emit({
    ok: true,
    image: target,
    out: outPath,
    canvas: { width: img.width, height: img.height },
    summary: describeGraph(graph),
    before: measure(before),
    after: measure(r.image),
    // Per-step, so a step that ran and changed nothing stays visible rather than buried.
    steps: r.steps,
    inertSteps: r.steps.filter((s) => s.suspicious).length,
  })
  process.exit(0)
}

// ── tool ────────────────────────────────────────────────────────────────────
//
// The measurement and asset tools, enumerated from their own headers and run through
// this one entry point. A roster kept separately from the tools would go stale, and a
// tool nobody can find is a tool that gets written again.
if (command === 'tool') {
  const { listTools, runTool } = await import('../src/tools-roster.mjs')
  const rest = argv.slice(1)
  if (rest.length === 0 || rest[0] === '--list' || rest[0] === '-l') {
    const roster = listTools()
    emit({
      ok: true,
      count: roster.length,
      run: 'design tool <name> [args...]   — arguments go straight to the tool',
      tools: roster.map((t) => ({ name: t.name, purpose: t.purpose, usage: t.usage })),
    })
    process.exit(0)
  }
  if (rest[0] === '--describe') {
    const want = rest[1]
    const one = want === undefined ? null : listTools().find((t) => t.name === want || t.name === `${want}.mjs`)
    if (one === undefined || one === null) fail(`no such tool "${want ?? ''}". Run \`design tool --list\`.`)
    emit({ ok: true, ...one })
    process.exit(0)
  }
  // Stdio is inherited, so each tool's own tables and progress print exactly as written.
  process.exit(await runTool(rest[0], rest.slice(1)))
}

// ── fonts ───────────────────────────────────────────────────────────────────
if (command === 'fonts') {
  const report = fontFamilyReport()
  emit({
    ok: true,
    registered: report.faces.length,
    faces: report.faces.map((f) => ({
      alias: f.alias,
      label: f.label,
      class: f.class,
      scripts: f.scripts,
      variable: f.variable,
      axes: f.axes,
      path: f.path,
    })),
    // Kept separate: these resolved from the OS and are usable, but they are not
    // guaranteed to exist on another machine, so a design that must travel should
    // stick to the curated set above.
    uncuratedSystemFamilies: report.uncuratedSystemFamilies,
  })
  process.exit(0)
}

// ── ladder ──────────────────────────────────────────────────────────────────
if (command === 'ladder') {
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { base: { type: 'string' }, ratio: { type: 'string' }, steps: { type: 'string' } },
    allowPositionals: false,
  })
  const ladder = scaleLadder({
    base: values.base === undefined ? 16 : Number(values.base),
    ratio: values.ratio === undefined ? 1.25 : Number(values.ratio),
    steps: values.steps === undefined ? 7 : Number(values.steps),
  })
  emit({ ok: true, ladder })
  process.exit(0)
}

// ── ramp ────────────────────────────────────────────────────────────────────
if (command === 'ramp') {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: { steps: { type: 'string' } },
    allowPositionals: true,
  })
  const base = positionals[0]
  if (base === undefined) fail('ramp needs a base colour, e.g. `design ramp "#8CA33C"`')
  const steps = values.steps === undefined ? 9 : Number(values.steps)
  const ramp = scaleRamp(base, { steps })
  emit({
    ok: true,
    base,
    baseOklch: toOklch(base),
    steps: ramp.map((hex, i) => ({
      step: i,
      hex,
      oklch: toOklch(hex),
      contrastOnWhite: Number(contrastRatio(hex, '#FFFFFF').toFixed(2)),
      contrastOnBlack: Number(contrastRatio(hex, '#000000').toFixed(2)),
    })),
  })
  process.exit(0)
}

// ── analyze ─────────────────────────────────────────────────────────────────
if (command === 'analyze') {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      'max-side': { type: 'string' },
      cols: { type: 'string' },
      rows: { type: 'string' },
      bins: { type: 'string' },
    },
    allowPositionals: true,
  })
  const target = positionals[0]
  if (target === undefined) fail('analyze needs an image path')
  const result = await analyseReference(target, {
    maxSide: values['max-side'] === undefined ? undefined : Number(values['max-side']),
    cols: values.cols === undefined ? undefined : Number(values.cols),
    rows: values.rows === undefined ? undefined : Number(values.rows),
    bins: values.bins === undefined ? undefined : Number(values.bins),
  })
  emit({ ok: true, ...result })
  process.exit(0)
}

// ── render ──────────────────────────────────────────────────────────────────
//
// A scene is a declarative JSON object — a canvas, a palette and a stack of layers —
// and this writes the PNG plus a report of what each layer contributed. Nothing here
// inspects the scene for design intent: the engine draws what it is given and reports
// what it measured, and judging the result is the caller's job.
if (command === 'render') {
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: {
      out: { type: 'string' },
      name: { type: 'string' },
      scale: { type: 'string' },
      psd: { type: 'boolean' },
      supersample: { type: 'string' },
    },
    allowPositionals: true,
  })
  const scenePath = positionals[0]
  if (scenePath === undefined) fail('render needs a scene JSON path')

  const { data: scene, path: resolvedScene } = readJson(scenePath)

  const outDir = isAbsolute(values.out === undefined ? 'out' : values.out)
    ? values.out
    : resolve(process.cwd(), values.out === undefined ? 'out' : values.out)
  mkdirSync(outDir, { recursive: true })

  const name = values.name === undefined ? basename(resolvedScene).replace(/\.json$/i, '') : values.name

  // Scale the whole scene by rewriting the canvas and any absolute lengths. The rewrite
  // lives in src/scale.mjs so it can be unit-tested directly.
  if (values.scale !== undefined) {
    const s = Number(values.scale)
    if (!(s > 0)) fail(`--scale must be positive, got ${values.scale}`)
    scaleScene(scene, s)
  }

  const t0 = Date.now()
  const wantsPsd = values.psd === true
  // Supersampled rendering: draw at N× and downsample. Curves drawn at final resolution
  // come out aliased — a wire reads as a gear-toothed band, an ink circle as a polygon —
  // and no amount of scene authoring fixes that.
  const supersample = values.supersample === undefined ? 1 : Number(values.supersample)
  if (!Number.isFinite(supersample) || supersample < 1) {
    fail(`--supersample must be a number >= 1, got ${values.supersample}`)
  }
  const { canvas, report, layers: captured } = await renderScene(scene, {
    baseDir: dirname(resolvedScene),
    // Captured in the same pass that composites them, so the delivered layers cannot
    // disagree with the delivered PNG.
    captureLayers: wantsPsd,
    supersample,
  })
  const elapsed = Date.now() - t0

  const pngPath = join(outDir, `${name}.png`)
  writeFileSync(pngPath, canvas.encodeSync('png'))

  let psdPath = null
  let psdInfo = null
  if (wantsPsd) {
    // Written by the engine rather than by an image editor. Layered delivery used to be
    // the one thing that required the application; writing the container directly removes
    // that dependency, and with it the risk that delivery depends on a process that may
    // not start.
    psdPath = join(outDir, `${name}.psd`)
    const composite = readBuffer(canvas)
    const bytes = writePsd({
      width: report.canvas.width,
      height: report.canvas.height,
      layers: captured === null ? [] : captured,
      composite,
    })
    writeFileSync(psdPath, bytes)
    psdInfo = {
      path: psdPath,
      bytes: bytes.length,
      layerCount: captured === null ? 0 : captured.length,
      layerNames: captured === null ? [] : captured.map((l) => l.name),
    }
  }

  // The report is written beside the image so a later step can diff two iterations
  // without re-rendering.
  const reportPath = join(outDir, `${name}.report.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  process.stderr.write(
    `rendered ${report.canvas.width}x${report.canvas.height} in ${elapsed}ms · ` +
    `${report.layerCount} layers · texture frequency ${report.stats.frequency.toFixed(4)} / ` +
    `contrast ${report.stats.contrast.toFixed(4)}\n` +
    (report.warnings.length > 0 ? `warnings:\n  ${report.warnings.join('\n  ')}\n` : ''),
  )

  emit({
    ok: true,
    png: pngPath,
    report: reportPath,
    psd: psdPath,
    psdInfo,
    elapsedMs: elapsed,
    canvas: report.canvas,
    layerCount: report.layerCount,
    warnings: report.warnings,
    stats: report.stats,
  })
  process.exit(0)
}

fail(`unknown command "${command}". Run \`design --help\`.`)
