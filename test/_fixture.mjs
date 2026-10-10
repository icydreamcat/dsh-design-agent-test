/**
 * A scene the tests build for themselves.
 *
 * The suites used to render scenes committed under `scenes/`, which made them depend on
 * files that exist to look at rather than to assert against — and a committed scene
 * carries styling decisions no test asked for, so a change to the library's taste could
 * turn a suite red for no reason. This builds the smallest scene that still exercises
 * every surface the tests need:
 *
 *   - each length spelling (fraction, pixel, nested group)
 *   - every shape the PSD writer has to carry (rect, ellipse, line, polygon, text, image, group)
 *   - an image whose path is RELATIVE to the scene file, so a caller that resolves image
 *     paths against the process working directory instead of the scene's own directory
 *     fails here rather than in production
 *   - a layer effect, a mask, and a blend mode, so the writer sees non-trivial alpha
 *
 * WHY IT IS WRITTEN TO DISK
 * -------------------------
 * An image `src` is resolved against `baseDir`, and the point of the relative path is to
 * prove that resolution works. A scene object in memory cannot test that, so the fixture
 * goes to a temp directory beside its image and the caller renders it the way the CLI
 * does.
 *
 * The temp directory is outside the repository and outside the working tree: a test must
 * not write into the thing it is testing.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Where the generated scene and its image live. */
export const FIXTURE_DIR = join(tmpdir(), 'dsh-design-test-fixture')
export const FIXTURE_SCENE = join(FIXTURE_DIR, 'scene.json')

/**
 * Build the fixture, once per process.
 *
 * @param {{write?: boolean}} [options] `write: false` returns the object without touching disk.
 * @returns {Promise<{scene: object, dir: string, scenePath: string|null}>}
 */
export async function fixtureScene(options = {}) {
  const scene = build()
  if (options.write === false) return { scene, dir: FIXTURE_DIR, scenePath: null }

  mkdirSync(FIXTURE_DIR, { recursive: true })
  const imagePath = join(FIXTURE_DIR, 'block.png')
  if (!existsSync(imagePath)) writeFileSync(imagePath, await blockPng())
  // `src` is deliberately relative: the renderer must resolve it against the scene file.
  scene.layers.find((l) => l.shape === 'image').src = './block.png'
  writeFileSync(FIXTURE_SCENE, JSON.stringify(scene, null, 2), 'utf8')
  return { scene, dir: FIXTURE_DIR, scenePath: FIXTURE_SCENE }
}

/** The scene object, with an absolute image path so it renders from anywhere. */
function build() {
  return {
    canvas: { width: 1200, height: 900 },
    ground: '#F1F1EC',
    layers: [
      { id: '01-ground', shape: 'rect', x: 0, y: 0, w: 1, h: 1, paint: '#F1F1EC' },
      { id: '02-plate', shape: 'rect', x: 72, y: 72, w: 1056, h: 756, paint: '#DED8C8', radius: 8 },
      { id: '03-image', shape: 'image', src: 'block.png', x: 120, y: 140, w: 360, h: 360, fit: 'cover' },
      {
        id: '04-stack',
        shape: 'group',
        x: 540,
        y: 140,
        opacity: 0.92,
        layers: [
          { id: '04a-disc', shape: 'ellipse', x: 0, y: 0, w: 240, h: 240, paint: '#8CA33C' },
          { id: '04b-ring', shape: 'ellipse', x: 40, y: 40, w: 160, h: 160, paint: '#00000000', stroke: '#20241C', width: 6, blend: 'multiply' },
        ],
      },
      { id: '05-rule', shape: 'line', x1: 120, y1: 560, x2: 1080, y2: 560, stroke: '#20241C', width: 2, opacity: 0.6 },
      {
        id: '06-mark',
        shape: 'polygon',
        points: [[120, 620], [200, 620], [160, 700]],
        paint: '#20241C',
        effects: [{ type: 'dropShadow', distance: 8, angle: 135, size: 10, color: '#20241C', opacity: 0.35 }],
      },
      {
        id: '07-masked',
        shape: 'rect',
        x: 260,
        y: 620,
        w: 320,
        h: 120,
        paint: '#8CA33C',
        mask: { shape: 'ellipse', x: 260, y: 620, w: 320, h: 120 },
      },
      { id: '08-title', shape: 'text', x: 640, y: 600, w: 440, text: 'Layered delivery', size: 48, font: 'Grotesk', color: '#20241C' },
      { id: '09-body', shape: 'text', x: 640, y: 664, w: 440, text: 'Two lines of body copy so the writer has more than one text layer to carry.', size: 22, font: 'Grotesk', color: '#4A5048' },
    ],
  }
}

/** A small PNG, so the image layer has real pixels without shipping a binary fixture. */
async function blockPng() {
  const { createCanvas } = await import('@napi-rs/canvas')
  const c = createCanvas(240, 240)
  const x = c.getContext('2d')
  x.fillStyle = '#3A4048'; x.fillRect(0, 0, 240, 240)
  x.fillStyle = '#E8E4D8'; x.fillRect(24, 24, 192, 96)
  x.fillStyle = '#8CA33C'; x.fillRect(24, 144, 96, 72)
  x.fillStyle = '#20241C'; x.fillRect(144, 144, 72, 72)
  return c.encodeSync('png')
}
