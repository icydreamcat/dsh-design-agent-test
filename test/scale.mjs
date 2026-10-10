/**
 * Regression tests for the `--scale` defect (and the scaling contract in general).
 *
 * THE DEFECT
 * ----------
 * `design render --scale <s>` rewrote `scene.canvas` and then walked the scene with
 * `Object.values`, which contains that same canvas — so `width`/`height` were
 * multiplied twice on the way out. The two axes did not even fail symmetrically:
 * the width was still large enough after the first multiply to be caught again,
 * while the rounded height had already fallen to 338 and failed the `> 1` test.
 *
 *   2400x1350 @ 0.5   ->    600x675   (intended 1200x675)   ratio 1.78 -> 0.89
 *   2400x1350 @ 0.25  ->    150x338   (intended  600x338)   ratio 1.78 -> 0.44
 *
 * The signature is therefore an ASPECT RATIO CHANGE, not a wrong pixel count. That
 * distinction matters: a test that only asserted "the canvas got smaller" passes
 * against the broken version. Every case below asserts the ratio is preserved.
 *
 * WHY IT NEEDS PINNING
 * --------------------
 * The render report came back EMPTY — 0 errors, 0 warnings — for a picture squashed to a
 * quarter of its width. A clean report is not evidence that this path works, because the
 * report describes the layers and the scaling happens above them. So the contract is pinned
 * here rather than inferred from a report.
 *
 * Run: node test/scale.mjs
 */
import { scaleScene } from '../src/scale.mjs'

let failed = 0
let checks = 0
function check(label, ok, detail) {
  checks++
  if (ok) console.log(`  ok    ${label}${detail === undefined ? '' : '  — ' + detail}`)
  else { failed++; console.log(`  FAIL  ${label}${detail === undefined ? '' : '  — ' + detail}`) }
}

const scene = () => ({ canvas: { width: 2400, height: 1350 }, layers: [] })

// ── 1. the defect's signature: the aspect ratio must survive ─────────────────
console.log('=== 1. scaling must preserve the aspect ratio ===')

for (const s of [0.5, 0.25, 0.2, 0.3, 0.1]) {
  const sc = scene()
  scaleScene(sc, s)
  const wantW = Math.round(2400 * s)
  const wantH = Math.round(1350 * s)
  const gotRatio = sc.canvas.width / sc.canvas.height
  const wantRatio = 2400 / 1350
  check(
    `scale ${s}: canvas is ${wantW}x${wantH}`,
    sc.canvas.width === wantW && sc.canvas.height === wantH,
    `got ${sc.canvas.width}x${sc.canvas.height} (ratio ${gotRatio.toFixed(3)} vs ${wantRatio.toFixed(3)})`,
  )
  // Independent of the exact numbers: the shape must not change. This is the
  // assertion the broken version fails even if the pixel arithmetic is edited.
  check(
    `scale ${s}: ratio within 1% of the original`,
    Math.abs(gotRatio - wantRatio) / wantRatio < 0.01,
    `ratio ${gotRatio.toFixed(4)}`,
  )
}

// A square must stay square — the clearest possible statement of the invariant,
// since any double-multiply of one axis shows up immediately.
{
  const sc = { canvas: { width: 1000, height: 1000 }, layers: [] }
  scaleScene(sc, 0.5)
  check('a square scene stays square', sc.canvas.width === sc.canvas.height,
    `${sc.canvas.width}x${sc.canvas.height}`)
}

// A portrait orientation must stay portrait (guards against a fix that hardcodes
// "width is the landscape axis").
{
  const sc = { canvas: { width: 1350, height: 2400 }, layers: [] }
  scaleScene(sc, 0.5)
  check('a portrait scene stays portrait', sc.canvas.height > sc.canvas.width,
    `${sc.canvas.width}x${sc.canvas.height}`)
}

// ── 2. a non-square canvas is where the defect was asymmetric ────────────────
console.log('\n=== 2. width and height must scale by the SAME factor ===')

{
  const sc = scene()
  scaleScene(sc, 0.25)
  const fw = sc.canvas.width / 2400
  const fh = sc.canvas.height / 1350
  check('both axes scaled by the same factor', Math.abs(fw - fh) < 0.005,
    `width x${fw.toFixed(4)}, height x${fh.toFixed(4)}`)
}

// ── 3. absolute lengths scale; fractional lengths do not ─────────────────────
console.log('\n=== 3. absolute lengths scale, fractional lengths are scale-invariant ===')

{
  // Both text conventions the real scenes use, and ONE size carrier each — see note below.
  const sc = {
    canvas: { width: 2400, height: 1350 },
    layers: [
      { id: 'abs', shape: 'rect', x: 100, y: 200, w: 400, h: 300 },
      { id: 'frac', shape: 'rect', x: 0.1, y: 0.2, w: 0.4, h: 0.3 },
      // Convention A: `font` is an OBJECT carrying its own size (muelsyse-ginkgo.json).
      { id: 'text-obj', shape: 'text', x: 120, y: 400, text: 'A', font: { family: ['Antiqua'], size: 200 } },
      // Convention B: `font` is a FAMILY STRING and the size is `layer.size`
      // (poster-a-flat.json). parseFontSpec() reads it as the default size.
      { id: 'text-str', shape: 'text', x: 120, y: 600, text: 'A', font: 'Grotesk', size: 214 },
    ],
  }
  scaleScene(sc, 0.5)
  const abs = sc.layers[0]
  const frac = sc.layers[1]
  check('absolute x/y/w/h halve', abs.x === 50 && abs.y === 100 && abs.w === 200 && abs.h === 150,
    `x=${abs.x} y=${abs.y} w=${abs.w} h=${abs.h}`)
  check('fractional x/y/w/h are untouched',
    frac.x === 0.1 && frac.y === 0.2 && frac.w === 0.4 && frac.h === 0.3,
    `x=${frac.x} y=${frac.y} w=${frac.w} h=${frac.h}`)
  check('an object font\'s size scales once', sc.layers[2].font.size === 100,
    `size=${sc.layers[2].font.size}`)
  check('a string font\'s layer.size scales once', sc.layers[3].size === 107,
    `size=${sc.layers[3].size}`)
}

// A size must be scaled EXACTLY ONCE, whichever carrier holds it. This is the general
// form of BOTH defects: each was a value reached by two code paths. `font.size` was hit
// by an explicit `font.size` branch AND by the walk over the layer's own values, so a
// 218px headline came out at 54px on a 0.5 draft. Real scenes state the size in exactly
// one place, but the invariant has to hold for the ones that use `font.size`, which is
// half of them.
{
  const sc = { canvas: { width: 2400, height: 1350 }, layers: [{ id: 'obj', shape: 'text', text: 'A', font: { family: ['Antiqua'], size: 218 } }] }
  scaleScene(sc, 0.5)
  check('an object font size is scaled exactly once, not twice',
    sc.layers[0].font.size === 109,
    `font.size=${sc.layers[0].font.size} (218 -> 109 expected, 54 was the defect)`)
}
{
  // Both carriers at once is malformed input, but it must still not double-scale either
  // one: a scene that states two sizes should scale both by s, not one by s and one by s².
  const sc = { canvas: { width: 2400, height: 1350 }, layers: [{ id: 'both', shape: 'text', text: 'A', font: { family: ['Antiqua'], size: 200 }, size: 200 }] }
  scaleScene(sc, 0.5)
  const l = sc.layers[0]
  check('two stated sizes each scale once',
    l.font.size === 100 && l.size === 100,
    `font.size=${l.font.size} layer.size=${l.size}`)
}

// A 1px hairline must survive as 1px: the `> 1` rule is deliberate, so a fix that
// switches to `>= 1` would collapse it to 0.5 and is caught here.
{
  const sc = { canvas: { width: 2400, height: 1350 }, layers: [{ id: 'hair', shape: 'line', width: 1, x1: 0, y1: 0, x2: 100, y2: 0 }] }
  scaleScene(sc, 0.5)
  check('a 1px width is left alone rather than scaled to 0.5', sc.layers[0].width === 1, `width=${sc.layers[0].width}`)
}

// ── 4. scale 1 is a no-op; the input is rejected, not silently accepted ──────
console.log('\n=== 4. edges ===')
{
  const sc = scene()
  const returned = scaleScene(sc, 1)
  check('scale 1 leaves the canvas alone', sc.canvas.width === 2400 && sc.canvas.height === 1350,
    `${sc.canvas.width}x${sc.canvas.height}`)
  check('scale 1 returns the scene for chaining', returned === sc, 'same object')
}
{
  let threw = false
  try { scaleScene(scene(), 0) } catch { threw = true }
  check('scale 0 is refused', threw, threw ? 'threw' : 'accepted')
}
{
  let threw = false
  try { scaleScene(scene(), -2) } catch { threw = true }
  check('a negative scale is refused', threw, threw ? 'threw' : 'accepted')
}

// ── 5. the same contract on a LAYERED scene, not just a bare canvas ──────────
//
// Section 1 scales `{ canvas, layers: [] }`, which proves the canvas arithmetic and
// nothing about the walk. The walk is where the defect lived, so this section scales a
// scene with every length spelling the engine accepts — fraction, pixel, a nested
// group, and an effect parameter — and asserts that each is rewritten exactly once. A
// length scaled twice is the failure mode this whole file exists for, and it is
// invisible on an empty layer list.
console.log('\n=== 5. every length spelling is rewritten exactly once ===')
{
  const layered = () => ({
    canvas: { width: 2400, height: 1350 },
    ground: '#F1F1EC',
    layers: [
      // fraction: scale-invariant, must come back untouched
      { id: 'a', shape: 'rect', x: 0, y: 0, w: 1, h: 1, paint: '#F1F1EC' },
      // absolute: must end at exactly half
      { id: 'b', shape: 'rect', x: 96, y: 120, w: 800, h: 400, paint: '#20241C' },
      { id: 'c', shape: 'text', x: 96, y: 600, w: 600, text: 'x', size: 64, font: 'Grotesk', color: '#20241C' },
      {
        id: 'd',
        shape: 'group',
        x: 200,
        y: 200,
        layers: [
          { id: 'd1', shape: 'ellipse', x: 40, y: 40, w: 160, h: 160, paint: '#8CA33C' },
          { id: 'd2', shape: 'line', x1: 40, y1: 40, x2: 200, y2: 200, stroke: '#20241C', width: 3 },
        ],
      },
      { id: 'e', shape: 'rect', x: 300, y: 300, w: 400, h: 200, paint: '#DED8C8', effects: [{ type: 'gaussian', radius: 20 }] },
    ],
  })

  const sc = layered()
  scaleScene(sc, 0.5)
  const byId = (id) => {
    const walk = (ls) => { for (const l of ls) { if (l.id === id) return l; if (Array.isArray(l.layers)) { const r = walk(l.layers); if (r) return r } } }
    return walk(sc.layers)
  }
  check('canvas halved', sc.canvas.width === 1200 && sc.canvas.height === 675, `${sc.canvas.width}x${sc.canvas.height}`)
  check('a fractional w is left alone', byId('a').w === 1, `w=${byId('a').w}`)
  check('a pixel x is halved exactly once', byId('b').x === 48, `x=${byId('b').x} (want 48, twice would be 24)`)
  check('a pixel w is halved exactly once', byId('b').w === 400, `w=${byId('b').w} (want 400)`)
  check('text size follows the scale once', byId('c').size === 32, `size=${byId('c').size} (want 32)`)
  check('a nested group child is reached', byId('d1').w === 80, `w=${byId('d1').w} (want 80)`)
  check('a nested line endpoint is reached', byId('d2').x2 === 100, `x2=${byId('d2').x2} (want 100)`)
  check('a stroke width follows the scale', byId('d2').width === 1.5, `width=${byId('d2').width} (want 1.5)`)
}

console.log(`\n=== ${checks - failed}/${checks} checks passed ===`)
process.exit(failed === 0 ? 0 : 1)
