#!/usr/bin/env node
/**
 * Standalone driver — runs the pipeline without DSH, for development and for
 * verifying the GPU path end to end.
 *
 *   node scripts/dev-run.mjs status
 *   node scripts/dev-run.mjs check  --dir <map dir>
 *   node scripts/dev-run.mjs run --image <photo> --material "<english>" \
 *        [--size 1024] [--steps 20] [--cfg 5.0] [--seed 7] \
 *        [--color-match hue|reinhard|off] [--out <dir>] [--name <slug>] [--keep]
 */
import { loadConfig } from '../lib/config.js'
import { checkMaps, materialFromPhoto, status } from '../lib/pipeline.js'

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return flags
}

const [command = 'status', ...rest] = process.argv.slice(2)
const args = parseArgs(rest)
const cfg = loadConfig()

if (args['config']) {
  process.env.PBR_CONFIG = args['config']
}

const log = (m) => console.log(`[pbr] ${m}`)

if (command === 'status') {
  console.log(JSON.stringify(await status(cfg), null, 2))
  process.exit(0)
}

if (command === 'check') {
  if (!args.dir) {
    console.error('check needs --dir <map dir>')
    process.exit(2)
  }
  const out = await checkMaps(cfg, { dir: args.dir, normal: args.normal })
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

if (command === 'run') {
  if (!args.image || !args.material) {
    console.error('run needs --image <photo> and --material "<english description>"')
    process.exit(2)
  }
  const naming =
    typeof args.category === 'string' && typeof args.asset === 'string'
      ? {
        category: args.category,
        name: args.asset,
        version: typeof args.version === 'string' ? args.version : undefined,
        pack: args['no-pack'] !== true,
      }
      : undefined
  const result = await materialFromPhoto(
    cfg,
    {
      imagePath: args.image,
      material: args.material,
      name: typeof args.name === 'string' ? args.name : undefined,
      outDir: typeof args.out === 'string' ? args.out : undefined,
      naming,
      size: args.size ? Number(args.size) : undefined,
      steps: args.steps ? Number(args.steps) : undefined,
      cfg: args.cfg !== undefined ? Number(args.cfg) : undefined,
      seed: args.seed ? Number(args.seed) : undefined,
      colorMatch: typeof args['color-match'] === 'string' ? { mode: args['color-match'] } : undefined,
      keepInstance: args.keep === true,
      forceSpawn: args.spawn === true,
    },
    { log, onProgress: ({ phase, elapsedMs }) => {
      if (elapsedMs % 30000 < 1500) log(`${phase}: ${(elapsedMs / 1000).toFixed(0)}s`)
    } },
  )
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

console.error(`unknown command: ${command}`)
process.exit(2)
