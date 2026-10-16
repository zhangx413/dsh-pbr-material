/**
 * Offline checks: no GPU, no ComfyUI, no network.
 * These assert the things that silently break — a wrong CLIPLoader type, a
 * grayscale normal map, a save node wired to the wrong PBRSynth output, the
 * load-bearing prompt clauses, and config merge order.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULTS, merge } from '../lib/config.js'
import { discoverComfy, parseModelPathsYaml } from '../lib/discover.js'
import { buildEditGraph, buildPbrGraph, EXPECTED_MAPS, SYNTH_OUTPUTS } from '../lib/graphs.js'
import { buildAssetName, planNames } from '../lib/naming.js'
import { MODEL_MANIFEST } from '../lib/models.js'
import { NEGATIVE_PROMPT, buildEditPrompt } from '../lib/prompts.js'

/**
 * The check that would have caught the real bug: ComfyUI keys its prompt dict by
 * STRING node id, so a numeric link reference makes the server raise
 * `KeyError: 17` and report only "Exception when validating node".
 */
function assertGraphValid(graph) {
  const ids = new Set(Object.keys(graph))
  assert.equal(ids.size, Object.keys(graph).length)
  for (const [id, node] of Object.entries(graph)) {
    assert.ok(typeof node.class_type === 'string' && node.class_type, `node ${id} needs class_type`)
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value)) continue
      assert.equal(value.length, 2, `${id}.${name} must be [nodeId, slot]`)
      assert.equal(typeof value[0], 'string', `${id}.${name} link target must be a STRING node id`)
      assert.equal(typeof value[1], 'number', `${id}.${name} slot must be a number`)
      assert.ok(ids.has(value[0]), `${id}.${name} points at missing node ${value[0]}`)
    }
  }
}

test('every graph is structurally valid (string ids, resolvable links)', () => {
  assertGraphValid(
    buildEditGraph({ refImage: 'r.png', positive: 'p', negative: 'n', models: DEFAULTS.models }),
  )
  assertGraphValid(buildPbrGraph({ albedoImage: 'a.png', prefix: 'pbrlab/job' }))
})

test('edit graph: flux2 clip type, no model input on Flux2Scheduler, latent reference both ways', () => {
  const g = buildEditGraph({
    refImage: 'ref.png',
    positive: 'p',
    negative: 'n',
    models: DEFAULTS.models,
  })
  assert.equal(g[4].inputs.type, 'flux2', 'CLIPLoader.type must be "flux2"')
  assert.deepEqual(Object.keys(g[12].inputs).sort(), ['height', 'steps', 'width'])
  // positive and negative conditioning must BOTH carry the reference latent
  assert.deepEqual(g[9].inputs.latent, ['8', 0])
  assert.deepEqual(g[10].inputs.latent, ['8', 0])
  assert.deepEqual(g[11].inputs.positive, ['9', 0])
  assert.deepEqual(g[11].inputs.negative, ['10', 0])
  // SamplerCustomAdvanced output index 0 feeds VAEDecode
  assert.deepEqual(g[17].inputs.samples, ['16', 0])
  assert.equal(g[14].class_type, 'EmptyFlux2LatentImage')
})

test('pbr graph: seamless before derivation, normal saved as RGB', () => {
  const g = buildPbrGraph({ albedoImage: 'a.png', prefix: 'pbrlab/job', pbr: {} })
  const fromClass = (type) => Object.values(g).filter((n) => n.class_type === type)
  assert.equal(fromClass('PBRLabMakeSeamless').length, 1)
  assert.equal(fromClass('PBRLabPBRSynth').length, 1)

  const synth = fromClass('PBRLabPBRSynth')[0]
  const seamless = fromClass('PBRLabMakeSeamless')[0]
  assert.deepEqual(synth.inputs.albedo, ['2', 0], 'PBRSynth must consume the seamless image')
  assert.equal(seamless.inputs.skip_if_seamless, true)

  const saves = Object.values(g).filter((n) => n.class_type === 'PBRLabSaveImage16')
  const byPrefix = Object.fromEntries(saves.map((n) => [n.inputs.filename_prefix.split('/').pop(), n]))
  assert.deepEqual(byPrefix.normal.inputs.images, ['4', SYNTH_OUTPUTS.normal])
  assert.equal(byPrefix.normal.inputs.grayscale, false, 'a grayscale normal map loses X/Y and is useless')
  assert.equal(byPrefix.normal.inputs.bit_depth, '16')
  assert.deepEqual(byPrefix.height.inputs.images, ['4', SYNTH_OUTPUTS.height])
  assert.equal(byPrefix.height.inputs.grayscale, true)
  assert.deepEqual(byPrefix.metallic.inputs.images, ['4', SYNTH_OUTPUTS.metallic])
  assert.deepEqual(byPrefix.albedo.inputs.images, ['2', 0])
  assert.equal(byPrefix.albedo.inputs.bit_depth, '8')

  for (const name of EXPECTED_MAPS) assert.ok(byPrefix[name], `missing save node for ${name}`)
})

test('prompt keeps the load-bearing clauses and never says macro/close-up', () => {
  const p = buildEditPrompt({ material: 'worn blue paint on steel, chipped, matte' })
  assert.match(p, /ORTHOGRAPHIC FRONT VIEW/)
  assert.match(p, /no perspective, no foreshortening, no vanishing point/)
  assert.match(p, /Remove ALL object structure/)
  assert.match(p, /Keep the material identity exactly: worn blue paint on steel, chipped, matte/)
  assert.match(p, /many small features rather than a few large ones/)
  assert.doesNotMatch(p.toLowerCase(), /macro photograph|close-up/)
  assert.match(NEGATIVE_PROMPT, /few large patches/)
  assert.throws(() => buildEditPrompt({ material: '   ' }))
})

test('config merge is deep and patch rows win over file values', () => {
  const merged = merge(DEFAULTS, { comfy: { spawnPort: 9999 }, colorMatch: { mode: 'off' } })
  assert.equal(merged.comfy.spawnPort, 9999)
  assert.equal(merged.colorMatch.mode, 'off')
  assert.equal(merged.comfy.python, DEFAULTS.comfy.python, 'untouched keys survive')
  assert.equal(merged.comfy.installDir, DEFAULTS.comfy.installDir)
})

test('asset naming follows the studio sheet', () => {
  // T_<category>_<name>_<NN>_<suffix>
  assert.equal(buildAssetName({ category: 'Military', name: 'SandBag', version: '01' }), 'T_Military_SandBag_01')
  assert.equal(buildAssetName({ prefix: 'MI_', category: 'Military', name: 'SandBag' }), 'MI_Military_SandBag_01')
  assert.equal(buildAssetName({ category: 'Military' }), null, 'no name -> not usable yet')
  assert.equal(buildAssetName({ name: 'SandBag' }), null, 'no category -> not usable yet')
  assert.equal(buildAssetName({ category: ' 军 事 ', name: '沙 袋' }), 'T_军事_沙袋_01', 'non-ASCII survives, separators do not')
  assert.equal(buildAssetName({ category: 'Multi/Word', name: 'A B' }), 'T_MultiWord_AB_01', 'unsafe characters are dropped')

  const plan = planNames({ category: 'Military', name: 'SandBag', version: '01' })
  assert.equal(plan.folder, 'T_Military_SandBag_01')
  const byKey = Object.fromEntries(plan.files.map((f) => [f.key, f.name]))
  assert.equal(byKey.albedo, 'T_Military_SandBag_01_C.png')
  assert.equal(byKey.normal, 'T_Military_SandBag_01_N.png')
  assert.equal(byKey.roughness, 'T_Military_SandBag_01_R.png')
  assert.equal(byKey.ao, 'T_Military_SandBag_01_AO.png')
  assert.equal(byKey.metallic, 'T_Military_SandBag_01_M.png')
  assert.equal(byKey.height, 'T_Military_SandBag_01_H.png')
  assert.deepEqual(
    plan.packed.map((p) => p.name),
    ['T_Military_SandBag_01_CA.png', 'T_Military_SandBag_01_CH.png', 'T_Military_SandBag_01_NRM.png'],
  )
  // the suffixes are configurable, and an override must win
  const custom = planNames({ category: 'Military', name: 'SandBag' }, { albedo: '_BASE', curvature: '_C' })
  assert.equal(custom.files.find((f) => f.key === 'albedo').name, 'T_Military_SandBag_01_BASE.png')
  assert.equal(custom.files.find((f) => f.key === 'normal').name, 'T_Military_SandBag_01_N.png', 'un-overridden keys keep the default')
  assert.equal(custom.files.find((f) => f.key === 'curvature').name, 'T_Military_SandBag_01_C.png')
})

test('discovery reads Comfy Desktop\'s own files instead of guessing', () => {
  const appData = mkdtempSync(join(tmpdir(), 'pbr-appdata-'))
  const install = mkdtempSync(join(tmpdir(), 'pbr-install-'))
  const appRoot = join(install, 'ComfyUI')
  mkdirSync(appRoot, { recursive: true })
  writeFileSync(join(appRoot, 'main.py'), '# fake')
  mkdirSync(join(appRoot, '.venv', 'Scripts'), { recursive: true })
  writeFileSync(join(appRoot, '.venv', 'Scripts', 'python.exe'), '')
  const models = join(install, 'ComfyUI-Shared', 'models')
  mkdirSync(models, { recursive: true })

  mkdirSync(join(appData, 'Comfy Desktop', 'comfy-procs'), { recursive: true })
  writeFileSync(
    join(appData, 'Comfy Desktop', 'comfy-procs', 'inst-1.json'),
    JSON.stringify({ v: 1, installPath: install, port: 8188 }),
  )
  mkdirSync(join(appData, 'Comfy Desktop', 'instance-model-paths'), { recursive: true })
  writeFileSync(
    join(appData, 'Comfy Desktop', 'instance-model-paths', 'inst-1.yaml'),
    [
      '# Generated by Comfy Desktop',
      'comfy.desktop_0:',
      `  base_path: '${models.replace(/\\/g, '\\\\')}'`,
      '  is_default: true',
      "  'vae': 'vae/'",
      '',
    ].join('\n'),
  )

  const found = discoverComfy({ appData, env: {}, platform: 'win32' })
  assert.equal(found.appRoot.value, appRoot)
  assert.match(found.appRoot.source, /comfy-procs/)
  assert.equal(found.modelsDir.value, models, 'the yaml base_path must win')
  assert.match(found.modelsDir.source, /is_default=true/, 'is_default is reported per block, not per line scanned')
  assert.equal(found.python.value, join(appRoot, '.venv', 'Scripts', 'python.exe'))
  assert.equal(found.portHint, 8188)
  assert.deepEqual(found.problems, [])

  // an explicit env var beats the desktop files
  const forced = discoverComfy({ appData, env: { PBR_MATERIAL_MODELS_DIR: models }, platform: 'win32' })
  assert.equal(forced.modelsDir.source, 'PBR_MATERIAL_MODELS_DIR')

  // and nothing found is reported as a problem, never as a silent empty string
  const empty = discoverComfy({ appData: mkdtempSync(join(tmpdir(), 'pbr-empty-')), env: {}, platform: 'win32' })
  assert.equal(empty.appRoot.value, null)
  assert.ok(empty.problems.length >= 2, `expected problems, got ${JSON.stringify(empty.problems)}`)
})

test('the model manifest is pinned, sourced, and internally consistent', () => {
  assert.equal(MODEL_MANIFEST.length, 3)
  for (const m of MODEL_MANIFEST) {
    assert.ok(['diffusion_models', 'text_encoders', 'vae'].includes(m.directory), m.directory)
    assert.match(m.name, /\.safetensors$/)
    assert.ok(m.bytes > 100_000_000, `${m.name} size looks wrong`)
    assert.ok(m.urls.length >= 2, 'every file needs an upstream AND a mirror URL')
    for (const url of m.urls) assert.match(url, /^https:\/\//)
    assert.ok(!/flux1-dev/.test(JSON.stringify(m)), 'the old FLUX.1 route must not creep back in')
  }
  // the sizes were read from HEAD probes; a stray edit should be loud
  const byKey = Object.fromEntries(MODEL_MANIFEST.map((m) => [m.key, m.bytes]))
  assert.equal(byKey.unet, 4_089_498_488)
  assert.equal(byKey.textEncoder, 8_044_982_048)
  assert.equal(byKey.vae, 336_213_556)
})
