#!/usr/bin/env node
/**
 * Does the image model actually look at the reference photo, or is it pure
 * text-to-image with a photo-shaped prompt?
 *
 * Three runs, same prompt, same seed, same resolution:
 *
 *   A  reference = photo 1
 *   B  reference = photo 2
 *   C  no reference at all (the ReferenceLatent wiring removed -> plain txt2img)
 *
 * If the model ignored the photo, A and B would be identical (same prompt, same
 * seed). And C is the control that shows how much of the result comes from the
 * prior alone.
 *
 * The material description deliberately names NO colour, so the palette can only
 * come from the photo.
 *
 *   node scripts/reference-ablation.mjs --out <dir> [--size 384] [--steps 16] [--seed 7]
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { loadConfig } from '../lib/config.js'
import { buildEditGraph } from '../lib/graphs.js'
import { buildEditPrompt, NEGATIVE_PROMPT } from '../lib/prompts.js'
import {
  attachOrSpawn,
  collectOutputs,
  ComfyClient,
  ensureRunRoot,
  stopSpawned,
} from '../lib/comfy.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const outDir = flag('out', join(process.cwd(), 'ablation'))
const size = Number(flag('size', 384))
const steps = Number(flag('steps', 16))
const seed = Number(flag('seed', 7))

// Two DIFFERENT photos are the whole point of the experiment, so they are
// arguments rather than defaults from one particular machine.
const REF_A = flag('a', process.env.PBR_ABLATION_A ?? '')
const REF_B = flag('b', process.env.PBR_ABLATION_B ?? '')
if (!REF_A || !REF_B) {
  console.error('usage: node scripts/reference-ablation.mjs --a <photo1> --b <photo2> [--out <dir>]')
  console.error('')
  console.error('Runs the same prompt + seed against two different references and once with no')
  console.error('reference at all, then reports how much the photo actually contributed.')
  process.exit(2)
}

// No colour words on purpose.
const MATERIAL =
  'worn painted metal surface with large chipped areas, fine scratches, dust and grime, matte aged finish'

/** Same graph with VAEEncode/ReferenceLatent removed: text conditioning only. */
function withoutReference(graph) {
  const out = JSON.parse(JSON.stringify(graph))
  delete out['8']
  delete out['9']
  delete out['10']
  out['11'].inputs.positive = ['6', 0]
  out['11'].inputs.negative = ['7', 0]
  return out
}

const cfg = loadConfig()
ensureRunRoot(cfg)
mkdirSync(outDir, { recursive: true })

let instance = await attachOrSpawn(cfg, { onLog: (m) => console.log(`[comfy] ${m}`) })
const client = new ComfyClient(instance)

async function run(label, imagePath, { useReference = true } = {}) {
  const graph = buildEditGraph({
    refImage: imagePath ? (await client.uploadImage(imagePath, { category: 'ablation' })).name : 'unused.png',
    positive: buildEditPrompt({ material: MATERIAL }),
    negative: NEGATIVE_PROMPT,
    size,
    steps,
    cfg: 5.0,
    seed,
    // The prefix has to end in a filename: SaveImage treats everything before
    // the last slash as the output subfolder.
    prefix: `pbrlab/ablation_${label}/img`,
    models: cfg.models,
  })
  const final = useReference ? graph : withoutReference(graph)
  const started = Date.now()
  const result = await client.run(final, { timeoutMs: 900000 })
  const files = collectOutputs(cfg.comfy.runRoot, `pbrlab/ablation_${label}`)
  if (files.length === 0) throw new Error(`${label}: no output written`)
  const dest = join(outDir, `${label}.png`)
  copyFileSync(files[files.length - 1].path, dest)
  console.log(`${label}: ${((Date.now() - started) / 1000).toFixed(1)}s -> ${dest}`)
  return dest
}

const results = {}
try {
  results.A = await run('A_ref_orange', REF_A)
  results.B = await run('B_ref_jerry', REF_B)
  results.C = await run('C_no_reference', null, { useReference: false })
} finally {
  if (instance.spawnedPid) await stopSpawned('ablation finished')
}

console.log(JSON.stringify({ material: MATERIAL, seed, size, steps, results }, null, 2))
process.exit(0)
