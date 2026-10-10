/**
 * The design working policy: one always-on prompt section.
 *
 * WHY A PLUGIN AND NOT MORE PERSONA TEXT
 * --------------------------------------
 * The persona says WHO this agent is. This section says HOW it works — decide before
 * you place, one focus, iterate by rendering, measure rather than estimate. Keeping
 * the two apart lets either be revised without disturbing the other, and it puts the
 * discipline in context from the first step rather than only once a skill is loaded.
 *
 * The TEXT is configuration, not code: it arrives as `config.text` from
 * `agent.cordis.yml`. That is deliberate — a standing mount is rebuilt from a
 * composition-file stamp whenever a new session starts, so a YAML edit is picked up
 * by the next session with no Host restart. Text baked into this module would not be:
 * the Cordis Loader imports a local plugin with a plain `await import(url)` and no
 * cache-busting parameter, so one process evaluates a given `.mjs` exactly once.
 *
 * This row only CONSUMES `systemPrompt`. It publishes no service, so it needs no
 * isolate realm and is correct as a loose top-level row.
 */

/** Cordis plugin name. */
export const name = 'design-policy'

/** The prompt registry this row contributes a section to. */
export const inject = ['systemPrompt']

/** The section name this row owns inside the preset's scope. */
const SECTION_NAME = 'design:working-policy'

/**
 * Order: immediately after the persona, which is where a section qualifying the
 * identity belongs.
 *
 * The anchor name is `DEPLOYMENT_PERSONA_PREFIX`, NOT `DEPLOYMENT_PERSONA`. The
 * registry exposes one order per registered SECTION, and the shipped persona row
 * registers two of them — `"deployment:persona-prefix"` and
 * `"deployment:persona-suffix"` — both ordered under that `_PREFIX`/`_SUFFIX` name.
 * The bare `DEPLOYMENT_PERSONA` matches no section, so `getSectionOrder` returns
 * undefined, the sum is NaN, and the registry refuses the mount.
 */
const PERSONA_ORDER_ANCHOR = 'DEPLOYMENT_PERSONA_PREFIX'

const POLICY_ORDER_OFFSET = 100

/**
 * Register the policy section into the mounting scope.
 *
 * @param {object} ctx the preset's standing scope context
 * @param {{text?: string}} [config] supplied by the composition file
 */
export function apply(ctx, config) {
  const text = config === undefined ? undefined : config.text
  // Both guards fail the mount loudly rather than degrading quietly: an agent that
  // renders no working policy would simply design without discipline, and nothing
  // downstream would report the loss.
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(
      'design-policy: config.text must be a non-empty string; the policy text lives in agent.cordis.yml',
    )
  }
  if (text.includes('{{')) {
    throw new Error(
      'design-policy: config.text must not contain "{{" — prompt sections are scanned for variable references and an unknown one fails the whole assembly',
    )
  }
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: ctx.systemPrompt.getSectionOrder(PERSONA_ORDER_ANCHOR) + POLICY_ORDER_OFFSET,
        text,
      }),
    'design-policy.section()',
  )
}
