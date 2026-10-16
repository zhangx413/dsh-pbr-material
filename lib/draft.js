/**
 * Turns the user's intent into the one English sentence FLUX.2 actually wants.
 *
 * The panel's main box holds what the user MEANS ("我想做成能平铺的旧漆，注意有种被磨过的
 * 感觉"), not what the image model needs. Those are different artefacts, and collapsing
 * them is why a Chinese description produces a generic texture: the instruction-edit
 * prompt is English, and it has to name colour + substrate + wear.
 *
 * So one LLM call, with the reference photo attached, writes that sentence. It goes
 * through DSH's own `llm` service, so it uses the user's configured providers and
 * credentials — this plugin never sees an API key.
 */
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

export const DRAFT_SYSTEM = `You write ONE English description of a surface material for a text-to-image instruction-edit model.
The user shows you a reference photo and, usually in Chinese, what they want made from it.

Rules:
- Output ONLY that description. No preamble, no quotes, no markdown, no bullet points, no explanation.
- One paragraph, 25-60 words, comma-separated phrases rather than full sentences.
- Always state three things: the COLOUR (and how it is worn), the SUBSTRATE (what the surface is made of),
  and the WEAR (chips, flakes, scratches, rust, cracks, dust, grime, and the finish: matte/satin/glossy).
- Name the neutral or contrasting areas you can actually see (bare metal, primer, dirt, paler patches):
  a later step must leave those pixels alone, so they have to be stated.
- Look at the photo. If the user's request disagrees with what you see, follow the photo, and keep the
  user's intent about how the material should read.
- Do NOT describe the object, its shape, the camera, perspective, lighting, shadows or background.
- Never use the words: macro, close-up, photograph, photo, texture map, seamless, tileable, render, AI.
- Do not invent a material that is not in the photo.`

const MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export function mediaTypeOf(path) {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'image/png'
}

/**
 * Strip the ways a model dresses up a one-line answer: code fences, a preamble
 * paragraph, surrounding quotes, hard wrapping.
 */
export function cleanDescription(raw) {
  let text = String(raw ?? '')
    .replace(/\r/g, '')
    .trim()
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim()
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  // "Here is the description:" is short; the description is the longest block.
  let best = paragraphs.length > 0 ? paragraphs.reduce((a, b) => (b.length > a.length ? b : a)) : text
  best = best.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  best = best.replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+$/, '').trim()
  if (best.length > 600) best = best.slice(0, 600).replace(/\s+\S*$/, '')
  return best
}

let modelCache = { at: 0, value: null }

/** Test seam: model discovery is cached per process. */
export function resetModelCache() {
  modelCache = { at: 0, value: null }
}

/** Every model the configured providers advertise, plus which of them see images. */
export async function listVisionModels(ctx, { maxAgeMs = 300000 } = {}) {
  const llm = ctx?.get?.('llm')
  if (!llm) return { available: false, reason: 'DSH 的 llm 服务不可用', providers: [], vision: [], all: [] }
  if (modelCache.value && Date.now() - modelCache.at < maxAgeMs) return modelCache.value

  const providers = await llm.listProviders()
  const vision = []
  const all = []
  const errors = []
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        const sees = (model.inputModalities ?? []).includes('image')
        const entry = { provider: provider.id, model: model.id, name: model.name || model.id, image: sees }
        all.push(entry)
        if (sees) vision.push(entry)
      }
    } catch (error) {
      errors.push(`${provider.id}: ${error?.message ?? error}`)
    }
  }
  const value = {
    available: true,
    providers: providers.map((p) => p.id),
    // When NO provider declares image support, the panel still needs something
    // to offer, or the user is stuck with a text-only model they cannot change.
    all: all.slice(0, 80),
    vision,
    errors,
    cachedAt: Date.now(),
  }
  modelCache = { at: Date.now(), value }
  return value
}

export function defaultSelection(ctx) {
  try {
    const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  } catch {}
  return null
}

/**
 * Prefer an explicitly chosen model, then the agent default when it can see
 * images, then any vision model (on the same provider first).
 */
export async function pickModel(ctx, { provider, model } = {}) {
  if (provider && model) return { provider, model, source: 'explicit', vision: true }
  const listed = await listVisionModels(ctx)
  const preferred = defaultSelection(ctx)

  if (
    preferred &&
    listed.vision.some((v) => v.provider === preferred.provider && v.model === preferred.model)
  ) {
    return { ...preferred, source: 'agent-default', vision: true }
  }
  const sameProvider = preferred ? listed.vision.find((v) => v.provider === preferred.provider) : null
  const chosen = sameProvider ?? listed.vision[0]
  if (chosen) {
    return { provider: chosen.provider, model: chosen.model, source: 'vision-fallback', vision: true }
  }
  if (preferred) {
    // Better to try than to refuse: some adapters accept images without
    // advertising the modality.
    return { ...preferred, source: 'agent-default-no-vision-declared', vision: false }
  }
  throw new Error('llm 服务没有列出任何可用模型，无法生成材质描述')
}

/**
 * @returns {Promise<{description: string, provider: string, model: string, source: string, usage: object|null}>}
 */
export async function draftMaterial(ctx, { imagePath, requirement, provider, model, signal } = {}) {
  const llm = ctx?.get?.('llm')
  const attachments = ctx?.get?.('attachments')
  if (!llm) throw new Error('DSH 的 llm 服务不可用，无法让模型写描述')
  if (!attachments) throw new Error('DSH 的 attachments 服务不可用，无法把参考图交给模型')

  const chosen = await pickModel(ctx, { provider, model })
  const bytes = readFileSync(imagePath)
  const ref = await attachments.saveImage({
    data: bytes,
    mediaType: mediaTypeOf(imagePath),
    name: basename(imagePath),
  })

  const content = []
  if (requirement && String(requirement).trim()) {
    content.push({ type: 'text', text: String(requirement).trim() })
  }
  content.push({ type: 'image', attachment: ref })

  let text = ''
  let usage = null
  let failure = null
  for await (const chunk of llm.stream({
    provider: chosen.provider,
    model: chosen.model,
    system: DRAFT_SYSTEM,
    messages: [{ role: 'user', content }],
    maxTokens: 400,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
      failure = chunk.reason.failure
    }
  }
  if (failure) throw new Error(`模型调用失败（${failure.code}）：${failure.message}`)

  const description = cleanDescription(text)
  if (!description) throw new Error('模型没有返回可用的描述（返回内容为空）')

  return {
    description,
    provider: chosen.provider,
    model: chosen.model,
    source: chosen.source,
    vision: chosen.vision !== false,
    usage,
  }
}
