/**
 * The pipeline: reference photo -> tileable PBR map set.
 *
 *   1. FLUX.2 Klein 4B instruction edit   (the only GPU step)
 *   2. hue-selective colour match         (optional, deterministic)
 *   3. MakeSeamless -> PBRSynth -> 16-bit save   (deterministic, in ComfyUI)
 *   4. measure the written PNGs           (deterministic)
 *
 * The order of 2 and 3 is not cosmetic: a step that can break periodicity must
 * run before the tiling step.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, extname, join, resolve } from 'node:path'

import { imageSize } from './imageinfo.js'
import { buildEditGraph, buildPbrGraph, buildReinhardColorMatchGraph } from './graphs.js'
import { mapFileFor, planNames } from './naming.js'
import { buildEditPrompt, NEGATIVE_PROMPT } from './prompts.js'
import {
  attachOrSpawn,
  collectOutputs,
  ComfyClient,
  ensureRunRoot,
  spawnHeadless,
  stopSpawned,
} from './comfy.js'

const PY_SCRIPTS = {
  colormatch: () => new URL('../python/hue_colormatch.py', import.meta.url),
  measure: () => new URL('../python/measure_maps.py', import.meta.url),
  pack: () => new URL('../python/pack_maps.py', import.meta.url),
}

/** Maps the packer consumes — it ignores everything else on purpose. */
const PACK_INPUTS = ['albedo', 'normal', 'roughness', 'metallic', 'ao', 'height']

export function scriptPath(name) {
  return resolve(decodeURIComponent(PY_SCRIPTS[name]().pathname.replace(/^\/([A-Za-z]:)/, '$1')))
}

export function runPython(python, script, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ['-B', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      reject(new Error(`${basename(script)} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${basename(script)} exited ${code}\n${stderr || stdout}`.slice(0, 2000)))
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function lastJson(text) {
  const lines = text.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.startsWith('{')) {
      try {
        return JSON.parse(line)
      } catch {}
    }
  }
  // pretty-printed JSON spanning many lines
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start))
    } catch {}
  }
  throw new Error(`no JSON found in output: ${text.slice(0, 400)}`)
}

function slugify(value, fallback = 'material') {
  const s = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return s || fallback
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Free VRAM in MiB, or null when nvidia-smi is unavailable. */
export async function gpuFreeMiB() {
  return new Promise((resolvePromise) => {
    let out = ''
    const child = spawn('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    child.on('error', () => resolvePromise(null))
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('close', () => {
      const m = /(\d+)\s*,\s*(\d+)/.exec(out)
      if (!m) return resolvePromise(null)
      resolvePromise(Number(m[2]) - Number(m[1]))
    })
  })
}

/** Pull SaveImage outputs (which DO reach /history) into absolute paths. */
function saveImageOutputs(entry, runRoot) {
  const files = []
  for (const [nodeId, output] of Object.entries(entry?.outputs ?? {})) {
    for (const image of output?.images ?? []) {
      if (image.type && image.type !== 'output') continue
      files.push({
        nodeId,
        path: join(runRoot, 'output', image.subfolder ?? '', image.filename),
      })
    }
  }
  return files.filter((f) => existsSync(f.path))
}

function firstPng(entry, runRoot) {
  const files = saveImageOutputs(entry, runRoot)
  if (files.length === 0) {
    throw new Error('the edit step produced no image — check the ComfyUI log for an execution error')
  }
  return files[files.length - 1].path
}

/**
 * @param {object} cfg resolved config
 * @param {object} opts
 * @param {string} opts.imagePath   reference photo (absolute, or relative to cwd)
 * @param {string} opts.material    what the surface IS (English): colour, substrate, wear
 * @param {function} [hooks.log]
 */
export async function materialFromPhoto(cfg, opts, hooks = {}) {
  const log = hooks.log ?? (() => {})
  const onProgress = hooks.onProgress ?? (() => {})
  const t0 = Date.now()

  const imagePath = resolve(opts.imagePath ?? '')
  if (!existsSync(imagePath)) throw new Error(`reference photo not found: ${imagePath}`)
  // Two ways to get PBR maps, and the choice is the user's:
  //   generate — the photo is a REFERENCE; an instruction edit rebuilds it flat
  //              and front-facing first. ~30 s at 1024px, and it re-invents
  //              detail, so it is wrong for a photo that is already a texture.
  //   direct   — the photo IS the albedo (workflow 01_image_to_pbr_maps): tile
  //              it and derive the maps. No model, no invented detail, ~3 s.
  const mode = opts.mode === 'direct' ? 'direct' : 'generate'
  if (mode === 'generate' && (!opts.material || !String(opts.material).trim())) {
    throw new Error(
      '`material` is required in generate mode — describe the surface: colour, substrate, how it is worn. ' +
        'For a photo that is already a flat, front-facing texture use mode "direct" instead, which needs no description.',
    )
  }

  for (const [label, p] of [
    ['ComfyUI main.py', join(cfg.comfy.installDir, 'main.py')],
    ['ComfyUI python', cfg.comfy.python],
  ]) {
    if (!existsSync(p)) throw new Error(`${label} not found: ${p} (edit the plugin's config.json)`)
  }

  const jobName = opts.name ? slugify(opts.name) : `${slugify(basename(imagePath, extname(imagePath)), 'ref')}-${stamp()}`
  const prefix = `pbrlab/${jobName}`

  // One material set = one folder, always. With studio naming the folder is the
  // texture asset name; without it, the job slug.
  const naming = opts.naming ?? null
  const plan = naming ? planNames(naming, cfg.naming?.suffixes) : null
  const baseOut = resolve(opts.outDir || cfg.outputDir || join(process.cwd(), 'pbr-materials'))
  const outDir = join(baseOut, plan ? plan.folder : jobName)
  const previewDir = join(outDir, 'preview')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(previewDir, { recursive: true })

  const notes = []
  const { notes: rootNotes } = ensureRunRoot(cfg)
  notes.push(...rootNotes)
  rootNotes.forEach((n) => log(`run root: ${n}`))

  // --- instance ---------------------------------------------------------
  let instance
  if (opts.forceSpawn) {
    instance = await attachOrSpawn(cfg, { onLog: log, forceSpawn: true })
  } else {
    const { findAttached } = await import('./comfy.js')
    const hit = await findAttached(cfg)
    if (hit) {
      instance = { ...hit, spawnedPid: null, logPath: null, attached: true, notes: [] }
      log(`attached to the running ComfyUI on port ${hit.port}`)
    } else {
      const free = await gpuFreeMiB()
      const need = cfg.comfy.minFreeVramMiB ?? 9000
      if (free !== null && free < need) {
        throw new Error(
          `only ${free} MiB of VRAM is free but the headless instance needs about ${need} MiB.\n` +
            'Close the other ComfyUI instance (or free the GPU), then run again — spawning now ' +
            'would OOM. Pass force_spawn to override.',
        )
      }
      instance = await spawnHeadless(cfg, { onLog: log })
      instance.attached = false
    }
  }

  const cleanup = async (reason) => {
    if (instance.spawnedPid && cfg.comfy.shutdownOnFinish !== false && !opts.keepInstance) {
      await stopSpawned(reason)
      return true
    }
    return false
  }

  let client
  try {
    client = new ComfyClient(instance)
    if (!(await client.hasNode('PBRLabPBRSynth'))) {
      throw new Error(
        'the pbrlab node pack is not registered on this instance. Step 2 (MakeSeamless/PBRSynth) ' +
          'depends on it — the pack ships with the plugin at assets/pbrlab and is linked into the ' +
          `run root by lib/comfy.js; check ${join(cfg.comfy.runRoot, 'custom_nodes', 'pbrlab')} ` +
          'and the run-root notes from pbr_comfy_status',
      )
    }

    const ref = await client.uploadImage(imagePath, { category: 'pbr_ref' })
    const seed = Number(opts.seed) > 0 ? Number(opts.seed) : Math.floor(Math.random() * 2 ** 31)
    const size = Number(opts.size) || cfg.defaults.size
    const steps = Number(opts.steps) || cfg.defaults.steps
    const cfgScale = opts.cfg !== undefined && opts.cfg !== null ? Number(opts.cfg) : cfg.defaults.cfg
    const positive =
      mode === 'generate' ? buildEditPrompt({ material: opts.material, extra: opts.extra ?? '' }) : null

    let albedoInput // file name inside the instance's input dir
    let colorMatchReport = { mode: 'off', applied: false }
    let r1 = null
    const sourceInfo = imageSize(imagePath)

    if (mode === 'direct') {
      // Workflow 01_image_to_pbr_maps, unchanged: no sampler, no prompt, no
      // colour match. The photo's own pixels stay the albedo.
      //
      // Skipping the edit is not merely ~26 s faster — for a photo that is
      // already a flat, front-facing texture it is the ONLY way to keep the real
      // surface. The instruction edit re-invents the material (a detailed
      // concrete wall came back as uniform speckle, formwork seams gone), and
      // that is exactly what must not happen to a ready-made texture.
      const direct = await client.uploadImage(imagePath, { category: 'pbr_direct' })
      albedoInput = direct.name
      log(
        `step 1/2  direct: photo -> MakeSeamless -> PBRSynth ` +
          `(${sourceInfo?.width ?? '?'}x${sourceInfo?.height ?? '?'} kept as-is; no generative edit, no colour match)`,
      )
    } else {
      // --- step 1 -------------------------------------------------------
      log(`step 1/3  instruction edit  (${size}px, ${steps} steps, cfg ${cfgScale}, seed ${seed})`)
      r1 = await client.run(
        buildEditGraph({
          refImage: ref.name,
          positive,
          negative: NEGATIVE_PROMPT,
          size,
          steps,
          cfg: cfgScale,
          seed,
          megapixels: Number(opts.megapixels) || cfg.defaults.megapixels,
          prefix: `${prefix}/edit`,
          models: cfg.models,
        }),
        {
          timeoutMs: cfg.comfy.generationTimeoutMs,
          onTick: (ms) => onProgress({ phase: 'edit', elapsedMs: ms }),
        },
      )
      const editedPng = firstPng(r1.entry, cfg.comfy.runRoot)
      log(`step 1/3  done in ${(r1.elapsedMs / 1000).toFixed(1)}s -> ${editedPng}`)

      // --- step 2 (colour match) ----------------------------------------
      const cmMode = opts.colorMatch?.mode ?? cfg.colorMatch.mode
      const cmStrength =
        opts.colorMatch?.strength !== undefined ? Number(opts.colorMatch.strength) : cfg.colorMatch.strength

      if (cmMode === 'hue') {
        const matchedPath = join(cfg.comfy.runRoot, 'input', `${jobName}_matched.png`)
        const args = [
          '--src',
          editedPng,
          '--ref',
          imagePath,
          '--out',
          matchedPath,
          '--strength',
          String(cmStrength),
          '--hue-lo',
          String(opts.colorMatch?.hueLo ?? cfg.colorMatch.hueLo),
          '--hue-hi',
          String(opts.colorMatch?.hueHi ?? cfg.colorMatch.hueHi),
          '--min-sat',
          String(opts.colorMatch?.minSat ?? cfg.colorMatch.minSat),
          '--min-val',
          String(opts.colorMatch?.minVal ?? cfg.colorMatch.minVal),
          '--sat-gate',
          String(opts.colorMatch?.satGate ?? cfg.colorMatch.satGate),
        ]
        const { stdout } = await runPython(cfg.comfy.python, scriptPath('colormatch'), args, {
          timeoutMs: 180000,
        })
        colorMatchReport = lastJson(stdout)
        albedoInput = basename(matchedPath)
        log(`step 2/3  colour match (hue-selective, strength ${cmStrength}) -> ${colorMatchReport.applied ? 'applied' : 'skipped'}`)
      } else if (cmMode === 'reinhard') {
        const uploaded = await client.uploadImage(editedPng, { category: 'pbr_gen' })
        const r = await client.run(
          buildReinhardColorMatchGraph({
            generatedImage: uploaded.name,
            refImage: ref.name,
            strength: cmStrength,
            prefix: `${prefix}/color_match`,
          }),
          { timeoutMs: 300000 },
        )
        const matched = firstPng(r.entry, cfg.comfy.runRoot)
        const dest = join(cfg.comfy.runRoot, 'input', `${jobName}_matched.png`)
        copyFileSync(matched, dest)
        albedoInput = basename(dest)
        colorMatchReport = { mode: 'reinhard', strength: cmStrength, applied: true, warns: 'tints neutral pixels' }
        log('step 2/3  colour match (in-graph Reinhard — known to tint neutral pixels)')
      } else {
        const dest = join(cfg.comfy.runRoot, 'input', `${jobName}_edited.png`)
        copyFileSync(editedPng, dest)
        albedoInput = basename(dest)
        log('step 2/3  colour match off')
      }
    }

    // --- step 3 ---------------------------------------------------------
    log(
      mode === 'direct'
        ? 'step 2/2  tile -> derive PBR maps -> 16-bit save'
        : 'step 3/3  tile -> derive PBR maps -> 16-bit save',
    )
    const r3 = await client.run(
      buildPbrGraph({ albedoImage: albedoInput, prefix, pbr: { ...cfg.pbr, ...(opts.pbr ?? {}) } }),
      {
        timeoutMs: cfg.comfy.generationTimeoutMs,
        onTick: (ms) => onProgress({ phase: 'pbr', elapsedMs: ms }),
      },
    )
    const produced = collectOutputs(cfg.comfy.runRoot, prefix)
    if (produced.length === 0) {
      throw new Error(`step 2 wrote no PNGs under ${join(cfg.comfy.runRoot, 'output', ...prefix.split('/'))}`)
    }

    // --- collect under the delivery names -------------------------------
    const canonical = ['albedo', 'normal', 'height', 'roughness', 'ao', 'curvature', 'metallic']
    const maps = {}
    for (const file of produced) {
      const stem = basename(file.name).toLowerCase()
      const key = canonical.find((k) => stem.startsWith(k))
      if (!key || maps[key]) continue
      const dest = join(outDir, plan ? mapFileFor(plan, key) : `${key}.png`)
      copyFileSync(file.path, dest)
      maps[key] = dest
    }
    log(`${mode === 'direct' ? 'step 2/2' : 'step 3/3'}  ${Object.keys(maps).length} maps -> ${outDir}`)

    // Keep a copy of the reference next to the previews: the manifest then
    // stays meaningful after the original photo moves, and the panel shows it.
    try {
      copyFileSync(imagePath, join(previewDir, plan ? `${plan.assetName}_ref.png` : '_reference.png'))
    } catch (error) {
      notes.push(`could not copy the reference into the output: ${error.message}`)
    }

    // --- packed companion textures (naming sheet) -----------------------
    let packed = null
    const packCfg = cfg.naming?.pack ?? {}
    if (naming && naming.pack !== false && packCfg.enabled !== false) {
      try {
        const args = [
          '--asset',
          plan.assetName,
          '--out-dir',
          outDir,
          '--kinds',
          (packCfg.kinds ?? ['CA', 'CH', 'NRM']).join(','),
        ]
        for (const key of PACK_INPUTS) if (maps[key]) args.push(`--${key}`, maps[key])
        const { stdout } = await runPython(cfg.comfy.python, scriptPath('pack'), args, { timeoutMs: 180000 })
        packed = lastJson(stdout)
        log(`packed: ${(packed.written ?? []).map((w) => w.kind).join(', ') || 'none'}`)
      } catch (error) {
        notes.push(`channel packing failed: ${error.message}`)
      }
    }

    let metrics = null
    try {
      const args = ['--preview', '--preview-dir', previewDir]
      if (plan) {
        for (const key of canonical) if (maps[key]) args.push('--map', `${key}=${maps[key]}`)
      } else {
        args.push('--dir', outDir)
      }
      const { stdout } = await runPython(cfg.comfy.python, scriptPath('measure'), args, { timeoutMs: 180000 })
      metrics = lastJson(stdout)
    } catch (error) {
      notes.push(`measurement failed: ${error.message}`)
    }

    const manifest = {
      job: jobName,
      createdAt: new Date().toISOString(),
      mode,
      source: imagePath,
      sourceSize: sourceInfo ? { width: sourceInfo.width, height: sourceInfo.height } : null,
      material: opts.material ?? null,
      seed: mode === 'direct' ? null : seed,
      size: mode === 'direct' ? null : size,
      steps: mode === 'direct' ? null : steps,
      cfg: mode === 'direct' ? null : cfgScale,
      models: mode === 'direct' ? null : cfg.models,
      asset: plan
        ? { name: plan.assetName, folder: outDir, naming, packed: packed?.written ?? [] }
        : null,
      instance: { port: instance.port, attached: !!instance.attached, pid: instance.spawnedPid ?? null },
      colorMatch: colorMatchReport,
      maps,
      packed: packed?.written ?? null,
      metrics,
      notes,
      version: 1,
    }
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    const stopped = await cleanup('job complete')
    return {
      ok: true,
      job: jobName,
      mode,
      outDir,
      asset: plan ? plan.assetName : null,
      packed: packed?.written ?? null,
      manifestPath: join(outDir, 'manifest.json'),
      maps,
      metrics,
      sourceSize: manifest.sourceSize,
      seed: manifest.seed,
      size: manifest.size,
      steps: manifest.steps,
      cfgScale: manifest.cfg,
      colorMatch: colorMatchReport,
      instance: manifest.instance,
      instanceStopped: stopped,
      timings: {
        editMs: mode === 'direct' ? 0 : r1.elapsedMs,
        pbrMs: r3.elapsedMs,
        totalMs: Date.now() - t0,
      },
      notes,
    }
  } catch (error) {
    notes.push(error.message)
    await cleanup('job failed')
    throw error
  }
}

/** Validate an existing map set. */
export async function checkMaps(cfg, { dir, normal }, hooks = {}) {
  const target = resolve(dir)
  if (!existsSync(target)) throw new Error(`directory not found: ${target}`)
  const args = ['--dir', target, '--preview']
  if (normal) args.push('--normal', resolve(normal))
  const { stdout } = await runPython(cfg.comfy.python, scriptPath('measure'), args, { timeoutMs: 180000 })
  return lastJson(stdout)
}

/** Is this machine ready? */
export async function status(cfg) {
  const { notes } = ensureRunRoot(cfg)
  const models = {}
  for (const [key, file] of Object.entries(cfg.models)) {
    const candidates = [
      join(cfg.comfy.modelsDir, 'diffusion_models', file),
      join(cfg.comfy.modelsDir, 'text_encoders', file),
      join(cfg.comfy.modelsDir, 'vae', file),
    ]
    const hit = candidates.find((p) => existsSync(p))
    models[key] = { file, found: !!hit, path: hit ?? null }
  }

  const { findAttached } = await import('./comfy.js')
  const attached = await findAttached(cfg)
  let nodes = null
  if (attached) {
    const client = new ComfyClient({ port: attached.port })
    nodes = {
      PBRLabPBRSynth: await client.hasNode('PBRLabPBRSynth'),
      PBRLabMakeSeamless: await client.hasNode('PBRLabMakeSeamless'),
      PBRLabSaveImage16: await client.hasNode('PBRLabSaveImage16'),
    }
  }

  return {
    comfy: {
      installDir: cfg.comfy.installDir,
      installFound: existsSync(join(cfg.comfy.installDir, 'main.py')),
      python: cfg.comfy.python,
      pythonFound: existsSync(cfg.comfy.python),
    },
    runRoot: { path: cfg.comfy.runRoot, repairs: notes },
    models,
    modelsReady: Object.values(models).every((m) => m.found),
    attached: attached ? { port: attached.port } : null,
    spawned: (await import('./comfy.js')).spawnedInfo(),
    attachedNodes: nodes,
    gpuFreeMiB: await gpuFreeMiB(),
    colorMatch: cfg.colorMatch,
    note: attached
      ? 'a running ComfyUI will be reused; the plugin will not start a second one'
      : 'no running ComfyUI found; the plugin will start its own headless instance when asked to generate',
  }
}

export { spawnHeadless, stopSpawned }
