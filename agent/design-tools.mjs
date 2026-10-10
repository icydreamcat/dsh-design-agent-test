/**
 * The design engine, registered as model-facing tools.
 *
 * Each tool is a thin wrapper over one engine CLI subcommand: the tool builds argv,
 * runs the engine as a subprocess, and returns the engine's JSON. Nothing is
 * reimplemented here, so the CLI and the tools cannot disagree about what a command
 * does, and the engine stays usable from a plain terminal without dsh.
 *
 * This row only CONSUMES `tools`. It publishes no service, so it needs no isolate
 * realm and is correct as a loose top-level row.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['tools']

export const name = 'design-tools'

/**
 * Locate the engine.
 *
 * The composition normally carries `config.engineDir`, resolved by `bootstrap.mjs` to
 * this checkout's real path — that is the supported route and the one the error below
 * names. The two fallbacks exist so the plugin still works when the row is edited by
 * hand: an environment override, and a pointer file the bootstrap writes beside this
 * one, which is what makes a deployed copy (living under the harness home, with no
 * checkout anywhere above it) still find its engine.
 */
function findEngineDir() {
  const here = dirname(fileURLToPath(import.meta.url))
  try {
    const pointer = readFileSync(join(here, 'engine-path.txt'), 'utf8').trim()
    if (pointer !== '' && existsSync(join(pointer, 'bin', 'design.mjs'))) return pointer
  } catch { /* no pointer written; fall through */ }
  return null
}

/**
 * Run the engine CLI and parse its JSON.
 *
 * stderr is returned alongside the result rather than discarded: the engine writes its
 * human-readable diagnosis there and its JSON on stdout, and a caller debugging a
 * render needs both. A non-zero exit is reported as `engineExit` instead of thrown,
 * because a partially failed render still produces useful measurements for the layers
 * that did draw.
 */
function runEngine(engineDir, argv, options = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, [resolve(engineDir, 'bin', 'design.mjs'), ...argv], {
      cwd: engineDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (e) => { if (!settled) { settled = true; rejectCall(e) } }
    if (options.signal !== undefined) {
      if (options.signal.aborted) { child.kill(); return fail(new Error('design engine call was cancelled')) }
      options.signal.addEventListener('abort', () => {
        child.kill()
        fail(new Error('design engine call was cancelled'))
      }, { once: true })
    }
    child.stdout.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b) => { stderr += b.toString('utf8') })
    child.on('error', (e) => fail(new Error(`could not start the design engine: ${e.message}`)))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      let parsed = null
      try { parsed = JSON.parse(stdout) } catch {
        return rejectCall(new Error(
          `the design engine did not return JSON (exit ${code}).\n` +
          `stdout: ${stdout.slice(0, 600)}\nstderr: ${stderr.slice(0, 600)}`,
        ))
      }
      resolveCall({ result: { ...parsed, engineExit: code }, stderr: stderr.trim() })
    })
  })
}

/**
 * Build the JSON Schema for a tool's parameters.
 *
 * Stated explicitly rather than left to `defineTool`, because the registry validates the
 * schema it is given and a shorthand that silently expands differently is a mount failure
 * rather than a warning.
 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, def] of Object.entries(spec)) {
    const prop = { type: def.type }
    if (def.description !== undefined) prop.description = def.description
    if (def.enum !== undefined) prop.enum = [...def.enum]
    if (def.items !== undefined) prop.items = def.items
    properties[key] = prop
    if (def.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * The output contract every tool states: a schema, and the text the model reads.
 *
 * The registry requires BOTH. Declaring only `schema` fails the mount with "must declare
 * output { schema, render, presentationMeta? }" rather than defaulting, so every tool
 * states both explicitly.
 */
function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: true, properties: {} },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  }
}

/** Resolve a path the caller gave, against the session's working directory. */
const here = (p) => (isAbsolute(String(p)) ? String(p) : resolve(process.cwd(), String(p)))

export function apply(ctx, config) {
  const configured = config !== undefined && typeof config.engineDir === 'string'
    ? config.engineDir
    : undefined
  const fromEnv = typeof process.env.DSH_DESIGN_ENGINE === 'string' && process.env.DSH_DESIGN_ENGINE.trim() !== ''
    ? process.env.DSH_DESIGN_ENGINE.trim()
    : undefined
  const engineDir = configured ?? fromEnv ?? findEngineDir()
  if (engineDir === null || !existsSync(engineDir)) {
    throw new Error(
      `design-tools: the design engine could not be located` +
      `${engineDir === null ? '' : ` at ${engineDir}`}. ` +
      `Set this row's config.engineDir in agent.cordis.yml, or set DSH_DESIGN_ENGINE to the ` +
      `engine directory of your checkout ` +
      `(tried: ${configured !== undefined ? 'config.engineDir' : fromEnv !== undefined ? 'DSH_DESIGN_ENGINE' : 'walking up from this module'}).`,
    )
  }

  // ── design_render ───────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_render',
    description:
      'Render a scene JSON to PNG and return its measurements.\n\n' +
      'This is the primary way to make a design. A scene is declarative: a canvas, a ground, and a stack of layers ' +
      '(rect, ellipse, line, polygon, path, text, image, group, adjustment). Lengths at or below 1 are fractions of the ' +
      'canvas; above 1 they are pixels — so a value just above 1 is ONE POINT SOMETHING PIXELS, and a shape meant to ' +
      'bleed past the edge must be written in pixels.\n\n' +
      'A line is drawn from (x1, y1) to (x2, y2) and does NOT use x/y; writing a horizontal rule as {x, y, x2, y2} draws ' +
      'a diagonal from the canvas corner.\n\n' +
      'A layer supports opacity, any of 16 blend modes, a mask, and effects. The vocabulary is ten layer effects ' +
      '(dropShadow, outerGlow, innerShadow, innerGlow, stroke, colorOverlay, gradientOverlay, patternOverlay, bevel, ' +
      'satin), which read the layer\'s own alpha; five filters (gaussian, motion, radial, box, lens) whose cost is flat ' +
      'in radius; and the tone operators. Any effect may carry a `scope` — a region confining where it acts, which is how ' +
      'a treatment is kept off a face; and any effect may be replaced by `{ graph: [...] }`, a palette operator chain ' +
      '(see design_palette).\n\n' +
      'A shape also supports a shape-level `tone` array, which runs over that shape\'s own box; that is how a dot screen ' +
      'is confined to the mark that generated it rather than spilling across the canvas.\n\n' +
      'The report carries per-layer geometry as actually drawn, whether any text overflowed, which font families were ' +
      'used and whether a silent fallback occurred, mask retention, halftone dot counts and coverage, and whole-image ' +
      'texture statistics.\n\n' +
      'READ THE WARNINGS. A layer that fails records why and is skipped; the render still returns measurements for the ' +
      'rest, so a clean-looking report can be missing a layer entirely.\n\n' +
      'Iterate: render, read the report, fix the scene, render again. A full-resolution poster renders in about a ' +
      'second, so several rounds are cheap and expected. Always look at the output image before declaring a design ' +
      'finished — measurements catch what numbers can catch, not what only an eye can.',
    parameters: compileParameters({
      scene: { required: true, type: 'string', description: 'Path to the scene JSON, relative to the working directory or absolute.' },
      out: { type: 'string', description: 'Output directory. Defaults to `out` beside the engine.' },
      name: { type: 'string', description: 'Base filename for the PNG and report. Defaults to the scene filename.' },
      scale: { type: 'number', description: 'Multiply the whole canvas by this factor, e.g. 0.3 for a fast draft. Fractional lengths are scale-invariant, so only absolute ones are rewritten.' },
      supersample: { type: 'number', description: 'Draw at N× and downsample. Use 2 when a curve reads as a gear-toothed band or an ink circle as a polygon.' },
      psd: { type: 'boolean', description: 'Also write a layered PSD beside the PNG.' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const argv = ['render', here(args.scene)]
      if (args.out !== undefined) argv.push('--out', String(args.out))
      if (args.name !== undefined) argv.push('--name', String(args.name))
      if (args.scale !== undefined) argv.push('--scale', String(args.scale))
      if (args.supersample !== undefined) argv.push('--supersample', String(args.supersample))
      if (args.psd === true) argv.push('--psd')
      const { result, stderr } = await runEngine(engineDir, argv, {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })

  // ── design_analyze ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_analyze',
    description:
      'Measure an image and return it as a SPECIFICATION rather than a description.\n\n' +
      'Use this before designing from a reference, and also on your own render. It converts a picture into numbers that ' +
      'can be acted on: ground luminance and hex; the luminance band holding most of the image; accent share reported ' +
      'BOTH as every chromatic pixel and as the subset belonging to large flat fills — the second is the number an accent ' +
      'budget is about, because an illustrated reference is legitimately chromatic throughout its artwork while its ' +
      'designed accent is a few percent; a luminance histogram; the detected layout grid pitch in pixels with a ' +
      'confidence score; connected-region geometry; stroke weights; and a spatial detail map.\n\n' +
      'A grid pitch of null is a finding, not a failure: it says the image does not use one at the measured scale. ' +
      'Compare `share` against `flatShare` before concluding anything about colour.',
    parameters: compileParameters({
      image: { required: true, type: 'string', description: 'Path to the image (PNG, JPEG, WebP).' },
      maxSide: { type: 'number', description: 'Downscale the longest side to this before measuring. Default 1600, which still resolves a 24px grid.' },
      cols: { type: 'number', description: 'Spatial grid columns. Default 8.' },
      rows: { type: 'number', description: 'Spatial grid rows. Default 5.' },
      bins: { type: 'number', description: 'Histogram bins.' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const argv = ['analyze', here(args.image)]
      if (args.maxSide !== undefined) argv.push('--max-side', String(args.maxSide))
      if (args.cols !== undefined) argv.push('--cols', String(args.cols))
      if (args.rows !== undefined) argv.push('--rows', String(args.rows))
      if (args.bins !== undefined) argv.push('--bins', String(args.bins))
      const { result, stderr } = await runEngine(engineDir, argv, {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })

  // ── design_fonts ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_fonts',
    description:
      'List the font families the engine can actually set, with their axes and script coverage.\n\n' +
      'Ask this before choosing a typeface. Every entry is one the renderer was built against, so it will resolve on ' +
      'another machine; the engine also reports families it found from the operating system, and those are NOT ' +
      'guaranteed to exist elsewhere, so a design that must travel should stay inside the curated set.\n\n' +
      'The engine measures text with the real font — advance width, ink box, ascender, descender and em box all come ' +
      'from the rasteriser — so there is no reason to estimate whether a string fits. Set it and measure.',
    parameters: compileParameters({}),
    output: textOutput(),
    async execute(_args, exec) {
      const { result, stderr } = await runEngine(engineDir, ['fonts'], {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })

  // ── design_ladder ───────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_ladder',
    description:
      'Print a modular type scale, with each step\'s size in pixels and its ratio to the base.\n\n' +
      'Use this to build a type system rather than picking sizes one at a time: a scale makes the relationships ' +
      'deliberate and repeatable, so a heading is large because of its rank rather than because it looked small.\n\n' +
      'Judge the RESULT in proportion to the canvas, not in absolute pixels: a body size that reads well on a 1200px ' +
      'sheet is unreadable on a 2800px one, because what a viewer perceives is the ratio of type height to canvas ' +
      'width. Measure the rendered PNG (design_analyze) rather than trusting the declared number.',
    parameters: compileParameters({
      base: { type: 'number', description: 'Base size in pixels. Default 16.' },
      ratio: { type: 'number', description: 'Ratio between steps. Default 1.25.' },
      steps: { type: 'number', description: 'How many steps above the base. Default 7.' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const argv = ['ladder']
      if (args.base !== undefined) argv.push('--base', String(args.base))
      if (args.ratio !== undefined) argv.push('--ratio', String(args.ratio))
      if (args.steps !== undefined) argv.push('--steps', String(args.steps))
      const { result, stderr } = await runEngine(engineDir, argv, {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })

  // ── design_ramp ─────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_ramp',
    description:
      'Print a colour ramp from one base colour, with OKLCH values and contrast against white and black.\n\n' +
      'Use this to build a family from a seed rather than inventing tints by eye: six hand-picked hexes drift in hue and ' +
      'read as unrelated colours, while a ramp keeps one hue and varies lightness and chroma together.\n\n' +
      'The contrast columns are the ones to act on. Text below roughly 4.5:1 against its ground is hard to read at small ' +
      'sizes, and the failure is invisible in a hex value — it only shows up when the two are measured against each other.',
    parameters: compileParameters({
      color: { required: true, type: 'string', description: 'Base colour as #RRGGBB.' },
      steps: { type: 'number', description: 'How many steps. Default 9.' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const argv = ['ramp', String(args.color)]
      if (args.steps !== undefined) argv.push('--steps', String(args.steps))
      const { result, stderr } = await runEngine(engineDir, argv, {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })

  // ── design_palette ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_palette',
    description:
      'The filter vocabulary and library, as data: list the operators, list the named presets, print the operator graph ' +
      'a preset builds, or apply one to a PNG.\n\n' +
      'Almost every spatial filter is the same operation with a different kernel — a Gaussian blur, a lens blur, a ' +
      'motion streak, an unsharp mask and an emboss differ only in which neighbourhood they combine and with what ' +
      'weights. So a treatment is expressed as a LIST of operators, and this tool is how you see and run that list ' +
      'without writing code.\n\n' +
      'Subcommands: `ops` (the vocabulary, grouped by family, each operator with its own parameters), `presets` (the ' +
      'named library with defaults and valid ranges), `show <preset>` (the graph, as JSON), `apply <image> <preset>` ' +
      '(run it and report what each step did, including steps that changed nothing), and `run <image> --graph <file>` ' +
      'for a graph you built yourself.\n\n' +
      'Pass parameters with `set` (an array of key=value), which needs no shell quoting. Report back `inertSteps`: a ' +
      'step that ran and changed nothing is usually a parameter outside its useful range rather than a no-op by design.',
    parameters: compileParameters({
      action: { required: true, type: 'string', description: 'One of: ops, presets, show, apply, run.', enum: ['ops', 'presets', 'show', 'apply', 'run'] },
      preset: { type: 'string', description: 'Preset name, for show and apply.' },
      image: { type: 'string', description: 'Image path, for apply and run.' },
      graph: { type: 'string', description: 'Path to a JSON array of operators, for run.' },
      out: { type: 'string', description: 'Output PNG path, for apply and run.' },
      kind: { type: 'string', description: 'Filter family, for ops: spatial, pointwise, mixing or source.' },
      set: { type: 'array', items: { type: 'string' }, description: 'Parameters as key=value strings, e.g. ["radius=8","amount=0.6"].' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const argv = ['palette', String(args.action)]
      if (args.preset !== undefined) argv.push(String(args.preset))
      if (args.image !== undefined) argv.push(here(args.image))
      if (args.graph !== undefined) argv.push('--graph', here(args.graph))
      if (args.out !== undefined) argv.push('--out', here(args.out))
      if (args.kind !== undefined) argv.push('--kind', String(args.kind))
      for (const kv of args.set ?? []) argv.push('--set', String(kv))
      const { result, stderr } = await runEngine(engineDir, argv, {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })

  // ── design_tool ─────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'design_tool',
    description:
      'The measurement and asset tools, enumerated from their own headers.\n\n' +
      'These answer the questions that come up while designing and that a single command cannot: where a subject sits ' +
      'in a photograph and how much room is beside it (subject-probe), how wide a string really is in a given face ' +
      '(text-measure), how much ink a rectangle holds (region-ink), what an icon pack contains (icon-inventory), how ' +
      'much tone sits in each zone of a composition (zone-tone), whether the text in a DELIVERED png still reads against ' +
      'what ended up under it (check-render), and more.\n\n' +
      'Call with no arguments (or `list`) for the roster with each tool\'s purpose and usage; `describe <name>` for one ' +
      'tool in full; or the tool name followed by its own arguments to run it. Arguments go straight to the tool.',
    parameters: compileParameters({
      name: { type: 'string', description: 'Tool name. Omit to list the roster.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the tool verbatim.' },
    }),
    output: textOutput(),
    async execute(args, exec) {
      const argv = ['tool']
      if (args.name === undefined) argv.push('--list')
      else {
        argv.push(String(args.name))
        for (const a of args.args ?? []) argv.push(String(a))
      }
      const { result, stderr } = await runEngine(engineDir, argv, {
        signal: exec === undefined ? undefined : exec.signal,
      })
      return { ...result, engineNotes: stderr }
    },
  })
}
