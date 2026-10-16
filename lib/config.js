/**
 * Config resolution for dsh-pbr-material.
 *
 * Resolution order (last wins):
 *   DEFAULTS  <  auto-discovery  <  <pluginDir>/config.json  <  profile patch `config:`
 *
 * A plain config.json is used on purpose: the plugin may be loaded by absolute
 * path (the `insert:` form), where a bare `@deepseek-ai/schemastery` import
 * cannot be resolved and therefore no Config schema can be exported. Both
 * sources feed the same merge, so an installed-as-bundle deployment works too.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDataDir, discoverComfy } from './discover.js'

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_FILE = join(PLUGIN_DIR, 'config.json')

/**
 * Machine paths are EMPTY by default on purpose: empty means "find it
 * yourself", and `loadConfig` fills them from Comfy Desktop's own configuration
 * files. Hard-coding one machine's paths is what made the plugin unshareable,
 * so they are no longer defaults — set them in config.json only to override.
 */
export const DEFAULTS = {
  comfy: {
    // All four resolve through lib/discover.js when left empty.
    installDir: '',
    python: '',
    modelsDir: '',
    runRoot: '',
    // '' = direct connections only. Set to e.g. http://127.0.0.1:7897 when the
    // local proxy is the working route (measured: it is not always — some days
    // the proxy stalls and hf-mirror直接 works).
    downloadProxy: '',
    // Prefer the user's already-running instance; only spawn when none answers.
    attachPorts: [8188, 8000, 8080, 8288],
    // Port for the headless instance this plugin spawns. 8164-8263 are in the
    // Windows reserved range on this machine and fail with WinError 10013.
    spawnPort: 8288,
    startupTimeoutMs: 300000,
    generationTimeoutMs: 1800000,
    // Free VRAM when the plugin started the instance itself.
    shutdownOnFinish: true,
    extraArgs: [],
  },
  models: {
    unet: 'flux-2-klein-base-4b-fp8.safetensors',
    textEncoder: 'qwen_3_4b.safetensors',
    vae: 'flux2-vae.safetensors',
  },
  defaults: {
    size: 1024,
    steps: 20,
    cfg: 5.0,
    seed: 0, // 0 -> random
    megapixels: 1.0,
  },
  /**
   * 'hue'      - saturation-gated HSV transfer (the measured-correct one).
   * 'reinhard' - in-graph PBRLabColorMatch. Tints neutral pixels; kept for
   *              comparison because the failure is instructive.
   * 'off'      - no colour matching.
   */
  colorMatch: {
    mode: 'hue',
    strength: 0.6,
    hueLo: 5,
    hueHi: 35,
    minSat: 0.25,
    minVal: 0.1,
    satGate: 0.18,
  },
  pbr: {
    blend: 32,
    baseRoughness: 0.55,
    roughnessSpan: 0.45,
    metallic: 0.0,
    normalStrength: 1.0,
    heightSharpen: 0.25,
    bitDepth: '16',
  },
  // '' -> <session cwd>/pbr-materials
  outputDir: '',
  /**
   * Studio asset naming. The panel always shows the exact plan, and the
   * suffixes live here so a convention that differs from the default reading
   * can be corrected without touching code.
   */
  naming: {
    prefix: 'T_',
    version: '01',
    suffixes: {
      albedo: '_C',
      normal: '_N',
      roughness: '_R',
      ao: '_AO',
      metallic: '_M',
      height: '_H',
      curvature: '_CURV',
    },
    // Channel packing per the naming sheet.
    pack: {
      enabled: true,
      bitDepth: 8,
      kinds: ['CA', 'CH', 'NRM'],
    },
  },
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function merge(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = merge(base[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

let discoveryCache = { at: 0, value: null }

/** ComfyUI discovery reads a handful of small files; cache it briefly. */
export function discovery({ maxAgeMs = 15000 } = {}) {
  if (discoveryCache.value && Date.now() - discoveryCache.at < maxAgeMs) return discoveryCache.value
  let value
  try {
    value = discoverComfy()
  } catch (error) {
    value = {
      appRoot: { value: null, source: `discovery failed: ${error.message}` },
      installRoot: { value: null, source: 'discovery failed' },
      modelsDir: { value: null, source: 'discovery failed' },
      python: { value: null, source: 'discovery failed' },
      portHint: null,
      problems: [String(error?.message ?? error)],
    }
  }
  discoveryCache = { at: Date.now(), value }
  return value
}

export function loadConfig(overrides) {
  let fromFile = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    } catch (error) {
      throw new Error(`dsh-pbr-material: ${CONFIG_FILE} is not valid JSON — ${error.message}`)
    }
  }
  const merged = merge(merge(DEFAULTS, fromFile), overrides)

  // Discovery sits between the defaults and the user's files: an explicit
  // config.json value always wins, and an empty one means "use what we found".
  const found = discovery()
  merged.comfy.installDir = merged.comfy.installDir || found.appRoot.value || ''
  merged.comfy.python = merged.comfy.python || found.python.value || ''
  merged.comfy.modelsDir = merged.comfy.modelsDir || found.modelsDir.value || ''
  merged.comfy.runRoot = merged.comfy.runRoot || join(defaultDataDir(), 'comfy_root')
  // Kept off `comfy` so it never leaks into a config dump; the status report
  // reads it to say WHERE each path came from.
  merged.discovery = found
  return merged
}

export function describeConfig(cfg) {
  return {
    installDir: cfg.comfy.installDir,
    python: cfg.comfy.python,
    modelsDir: cfg.comfy.modelsDir,
    runRoot: cfg.comfy.runRoot,
    attachPorts: cfg.comfy.attachPorts,
    spawnPort: cfg.comfy.spawnPort,
    outputDir: cfg.outputDir || '(session cwd)/pbr-materials',
    colorMatch: cfg.colorMatch.mode,
  }
}
