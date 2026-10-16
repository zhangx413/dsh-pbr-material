/**
 * ComfyUI API-format graphs.
 *
 * Signatures were read from `comfy_extras` source and from the pbrlab pack's
 * INPUT_TYPES, not guessed. Traps encoded here:
 *
 *  - **Node ids and link references are STRINGS.** A numeric reference like
 *    `[17, 0]` makes the server raise `KeyError: 17` while validating (it looks
 *    the id up in a dict keyed by string) and reports only "Exception when
 *    validating node" — a silent-until-you-look failure. `L()` exists for this.
 *  - `CLIPLoader.type` MUST be "flux2" for the Klein family.
 *  - `Flux2Scheduler` takes steps/width/height and has NO model input.
 *  - `SamplerCustomAdvanced` returns (output, denoised) - index 0 is the one.
 *  - `PBRLabSaveImage16.grayscale` must be FALSE for normal maps, or the X/Y
 *    components are collapsed into luma and the map is silently useless.
 */

/** Link reference: always `["<nodeId>", <outputSlot>]`. */
export const L = (nodeId, slot = 0) => [String(nodeId), slot]

/**
 * Step 1 — instruction edit: object photo -> flat orthographic material image.
 */
export function buildEditGraph({
  refImage,
  positive,
  negative,
  size = 1024,
  steps = 20,
  cfg = 5.0,
  seed = 1,
  megapixels = 1.0,
  prefix = 'pbrlab/klein_edit',
  models,
}) {
  return {
    1: { class_type: 'LoadImage', inputs: { image: refImage, upload: 'image' } },
    2: {
      class_type: 'ImageScaleToTotalPixels',
      inputs: {
        image: L(1),
        upscale_method: 'lanczos',
        megapixels,
        resolution_steps: 1,
      },
    },
    3: { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
    4: { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'flux2', device: 'default' } },
    5: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: L(4), text: positive } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: L(4), text: negative } },
    8: { class_type: 'VAEEncode', inputs: { pixels: L(2), vae: L(5) } },
    9: { class_type: 'ReferenceLatent', inputs: { conditioning: L(6), latent: L(8) } },
    10: { class_type: 'ReferenceLatent', inputs: { conditioning: L(7), latent: L(8) } },
    11: { class_type: 'CFGGuider', inputs: { model: L(3), positive: L(9), negative: L(10), cfg } },
    12: { class_type: 'Flux2Scheduler', inputs: { steps, width: size, height: size } },
    13: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    14: { class_type: 'EmptyFlux2LatentImage', inputs: { width: size, height: size, batch_size: 1 } },
    15: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    16: {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: L(15),
        guider: L(11),
        sampler: L(13),
        sigmas: L(12),
        latent_image: L(14),
      },
    },
    17: { class_type: 'VAEDecode', inputs: { samples: L(16), vae: L(5) } },
    18: { class_type: 'SaveImage', inputs: { images: L(17), filename_prefix: prefix } },
  }
}

/**
 * Step 1b — colour match inside the graph (PBRLabColorMatch, Reinhard).
 * Only used when colorMatch.mode === 'reinhard'; the default path does this in
 * Python on PNGs instead, because the per-channel transfer tints neutrals.
 */
export function buildReinhardColorMatchGraph({ generatedImage, refImage, strength, prefix }) {
  return {
    1: { class_type: 'LoadImage', inputs: { image: generatedImage, upload: 'image' } },
    2: { class_type: 'LoadImage', inputs: { image: refImage, upload: 'image' } },
    3: {
      class_type: 'PBRLabColorMatch',
      inputs: { image: L(1), reference: L(2), strength, match_contrast: true },
    },
    4: { class_type: 'SaveImage', inputs: { images: L(3), filename_prefix: prefix } },
  }
}

/** PBRSynth outputs, by name and by slot index. */
export const SYNTH_OUTPUTS = { normal: 0, height: 1, roughness: 2, ao: 3, curvature: 4, metallic: 5 }

const SAVES = [
  { key: 'height', grayscale: true },
  { key: 'normal', grayscale: false }, // MUST be false
  { key: 'roughness', grayscale: true },
  { key: 'ao', grayscale: true },
  { key: 'curvature', grayscale: true },
  { key: 'metallic', grayscale: true },
]

/**
 * Step 2 — deterministic pixel maths, in the order that keeps periodicity:
 *   MakeSeamless  ->  PBRSynth  ->  16-bit save
 * Colour matching has already happened before this graph; it must, because a
 * step that can break periodicity has to run before the tiling step.
 */
export function buildPbrGraph({ albedoImage, prefix, pbr = {} }) {
  const blend = pbr.blend ?? 32
  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: albedoImage, upload: 'image' } },
    2: {
      class_type: 'PBRLabMakeSeamless',
      inputs: {
        image: L(1),
        blend,
        blend_y: true,
        blend_x: true,
        skip_if_seamless: true,
        seamless_tolerance: 0.02,
      },
    },
    // 3: the seamless albedo at 8-bit sRGB (albedo carries no gradients worth
    // 16 bits).
    3: {
      class_type: 'PBRLabSaveImage16',
      inputs: { images: L(2), filename_prefix: `${prefix}/albedo`, bit_depth: '8', grayscale: false },
    },
    4: {
      class_type: 'PBRLabPBRSynth',
      inputs: {
        albedo: L(2),
        normal_strength: pbr.normalStrength ?? 1.0,
        height_sharpen: pbr.heightSharpen ?? 0.25,
        detail_radius: 4,
        normal_radius: 2,
        ao_radius: 24,
        ao_intensity: 1.0,
        curvature_radius: 6,
        curvature_strength: 0.5,
        base_roughness: pbr.baseRoughness ?? 0.55,
        roughness_span: pbr.roughnessSpan ?? 0.45,
        metallic: pbr.metallic ?? 0.0,
        invert_height: false,
        invert_roughness: false,
        encode_normal_for_png: true,
      },
    },
  }

  SAVES.forEach((save, i) => {
    graph[10 + i] = {
      class_type: 'PBRLabSaveImage16',
      inputs: {
        images: L(4, SYNTH_OUTPUTS[save.key]),
        filename_prefix: `${prefix}/${save.key}`,
        bit_depth: pbr.bitDepth ?? '16',
        grayscale: save.grayscale,
      },
    }
  })

  // Verdict node: visible in the ComfyUI GUI. Its STRING output is NOT kept in
  // /history, so the plugin measures the written PNGs instead of reading this.
  graph[30] = {
    class_type: 'PBRLabTileValidator',
    inputs: { image: L(2), normal_is_image_encoded: true, normal: L(4) },
  }

  return graph
}

/** Maps a full run is expected to produce. */
export const EXPECTED_MAPS = ['albedo', ...SAVES.map((s) => s.key)]
