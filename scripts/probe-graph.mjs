#!/usr/bin/env node
/**
 * Diagnostic: post the edit graph straight to ComfyUI and print the server's
 * FULL reply.
 *
 * Why this exists: when a graph is rejected, the HTTP body carries the real
 * failure inside `node_errors[*].errors[0].extra_info.traceback` — the summary
 * line only says "Exception when validating node". This is how the
 * `KeyError: 17` (numeric node-id reference) was found.
 *
 *   node scripts/probe-graph.mjs [reference.png] [--keep]
 */
import { readFileSync } from 'node:fs'

import { loadConfig } from '../lib/config.js'
import { buildEditGraph } from '../lib/graphs.js'
import { buildEditPrompt, NEGATIVE_PROMPT } from '../lib/prompts.js'
import { ensureRunRoot, findAttached, spawnHeadless, stopSpawned } from '../lib/comfy.js'

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const image = args.find((a) => !a.startsWith('--'))
if (!image) {
  console.error('usage: node scripts/probe-graph.mjs <reference-photo> [--keep]')
  console.error('       Posts the edit graph straight to ComfyUI and prints the FULL server reply.')
  process.exit(2)
}

const cfg = loadConfig()
console.log('run root repairs:', ensureRunRoot(cfg).notes)

let inst = await findAttached(cfg)
if (!inst) inst = await spawnHeadless(cfg, { onLog: (m) => console.log(`[spawn] ${m}`) })
const base = `http://127.0.0.1:${inst.port}`
console.log('instance on port', inst.port)

const form = new FormData()
form.append('image', new Blob([readFileSync(image)]), 'probe_ref.png')
form.append('overwrite', 'true')
const uploaded = await (await fetch(`${base}/upload/image`, { method: 'POST', body: form })).json()
console.log('uploaded:', uploaded)

const parts = {
  refImage: uploaded.name,
  positive: buildEditPrompt({ material: 'weathered orange-red enamel paint on metal, chipped' }),
  negative: NEGATIVE_PROMPT,
  size: 384,
  steps: Number(process.env.PROBE_STEPS ?? 4),
  cfg: 5.0,
  seed: 7,
  models: cfg.models,
  prefix: 'pbrlab/probe',
}

async function post(label, prompt) {
  const res = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: 'pbr-probe' }),
  })
  const text = await res.text()
  console.log(`\n=== ${label} -> HTTP ${res.status} ===`)
  console.log(text.slice(0, 4000))
}

await post('edit graph', buildEditGraph(parts))

// Control: the same graph with NUMERIC node references. ComfyUI keys its prompt
// dict by string, so this fails with `KeyError: 17` — the trap that motivated
// the test asserting every link target is a string.
const numeric = JSON.parse(JSON.stringify(buildEditGraph(parts)))
for (const node of Object.values(numeric)) {
  for (const [k, v] of Object.entries(node.inputs)) {
    if (Array.isArray(v)) node.inputs[k] = [Number(v[0]), v[1]]
  }
}
await post('control: same graph with numeric refs (expected to fail)', numeric)

if (!keep) {
  const stopped = await stopSpawned('probe finished')
  console.log(`\ninstance stopped: ${stopped}`)
}
process.exit(0)
