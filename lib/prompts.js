/**
 * The step-1 instruction prompt.
 *
 * Every clause here is load-bearing and was measured (see skill/SKILL.md).
 * Structure and order are not cosmetic:
 *
 *   1. the VIEW first (orthographic, perpendicular)
 *   2. remove ALL object structure
 *   3. keep the material identity
 *   4. force small, uniform features  <- also lowers the visible cost of the
 *      step-2 tiling pass, which is a local mirror symmetry
 *   5. negative prompt
 *
 * NEVER write "macro photograph" or "close-up": measured to make the model
 * return one small patch filling the frame ("it turned my field into a single
 * brick"). Describe the AREA SCALE instead.
 */

export const NEGATIVE_PROMPT = [
  'perspective',
  'foreshortening',
  'oblique angle',
  'object',
  'container',
  'handle',
  'cap',
  'ridge',
  'edges',
  'silhouette',
  'background',
  'ground',
  'shadow',
  'cast shadow',
  'highlight',
  'vignette',
  'glossy',
  'reflection',
  'text',
  'watermark',
  'border',
  'few large patches',
  'single dominant feature',
  'gradient',
].join(', ')

/**
 * @param {object} options
 * @param {string} options.material  what the surface IS, in English: colour,
 *   substrate, and what the wear looks like. This is the only free-text slot.
 * @param {string} [options.extra]   appended verbatim.
 */
export function buildEditPrompt({ material, extra = '' }) {
  if (!material || !material.trim()) {
    throw new Error('buildEditPrompt: `material` is required — describe colour, substrate and wear')
  }
  return [
    'Extract ONLY the surface material from the supplied photo and re-render it as a flat, front-facing, seamless material texture.',
    'flat ORTHOGRAPHIC FRONT VIEW: the surface plane parallel to the image plane, camera exactly perpendicular, no perspective, no foreshortening, no vanishing point.',
    'Remove ALL object structure: no ridges, no embossed shapes, no seams, no rivets, no edges, no silhouette, no handle, no cap, no background, no ground, no shadow.',
    `Keep the material identity exactly: ${material.trim()}`,
    'Even diffuse lighting across the whole frame, uniform detail density edge to edge so it can tile. Uniform, finely and evenly spread feature density, many small features rather than a few large ones. No single dominant feature, no large isolated shape, no text, no watermark, no border.',
    extra.trim(),
  ]
    .filter(Boolean)
    .join('\n')
}
