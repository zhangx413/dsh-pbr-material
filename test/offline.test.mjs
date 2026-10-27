/**
 * Offline checks: no GPU, no ComfyUI, no network.
 * These assert the things that silently break — a wrong CLIPLoader type, a
 * grayscale normal map, a save node wired to the wrong PBRSynth output, the
 * load-bearing prompt clauses, and config merge order.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULTS, loadConfig, merge } from '../lib/config.js'
import { discoverComfy, parseModelPathsYaml } from '../lib/discover.js'
import { buildEditGraph, buildPbrGraph, EXPECTED_MAPS, SYNTH_OUTPUTS } from '../lib/graphs.js'
import { imageSize } from '../lib/imageinfo.js'
import { buildAssetName, planNames } from '../lib/naming.js'
import { MODEL_MANIFEST } from '../lib/models.js'
import { materialFromPhoto, runPython } from '../lib/pipeline.js'
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

test('imageSize reads only the header, and never throws on junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbr-size-'))

  // PNG: 8-byte signature, then length + "IHDR" + width + height. Only the
  // header is parsed, so the CRC does not have to be valid here.
  const png = Buffer.alloc(32)
  png.writeUInt32BE(0x89504e47, 0)
  png.writeUInt32BE(0x0d0a1a0a, 4)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'latin1')
  png.writeUInt32BE(747, 16)
  png.writeUInt32BE(1328, 20)
  const pngPath = join(dir, 'a.png')
  writeFileSync(pngPath, png)
  const pngInfo = imageSize(pngPath)
  assert.equal(pngInfo.width, 747)
  assert.equal(pngInfo.height, 1328)
  assert.equal(pngInfo.format, 'png')

  // JPEG: SOI, an APP0 to skip, then SOF0 which carries the dimensions.
  const jpeg = Buffer.alloc(40)
  jpeg[0] = 0xff
  jpeg[1] = 0xd8
  jpeg[2] = 0xff
  jpeg[3] = 0xe0
  jpeg.writeUInt16BE(16, 4)
  jpeg[20] = 0xff
  jpeg[21] = 0xc0
  jpeg.writeUInt16BE(17, 22)
  jpeg[24] = 8
  jpeg.writeUInt16BE(1328, 25)
  jpeg.writeUInt16BE(747, 27)
  jpeg[38] = 0xff
  jpeg[39] = 0xd9
  const jpegPath = join(dir, 'a.jpg')
  writeFileSync(jpegPath, jpeg)
  const jp = imageSize(jpegPath)
  assert.equal(jp.width, 747)
  assert.equal(jp.height, 1328)
  assert.equal(jp.format, 'jpeg')

  // not an image at all: a report with nulls, not a throw
  const junkPath = join(dir, 'a.txt')
  writeFileSync(junkPath, 'hello')
  assert.deepEqual(imageSize(junkPath), { width: null, height: null, bytes: 5, format: null })

  // a missing file is null, never an exception
  assert.equal(imageSize(join(dir, 'nope.png')), null)
})

test('the material requirement is mode-gated, before any ComfyUI work', async () => {
  // A deliberately broken install path: if a call gets past the mode gate it
  // fails on ComfyUI instead, which is how the two cases are told apart.
  const broken = { ...DEFAULTS, comfy: { ...DEFAULTS.comfy, installDir: join(tmpdir(), 'nope-not-comfyui') } }
  const dir = mkdtempSync(join(tmpdir(), 'pbr-gate-'))
  const photo = join(dir, 'photo.png')
  writeFileSync(photo, 'not really a png')

  await assert.rejects(
    () => materialFromPhoto(broken, { imagePath: photo, mode: 'generate' }),
    /material.*required/,
    'generate mode must demand a description',
  )
  await assert.rejects(
    () => materialFromPhoto(broken, { imagePath: photo, mode: 'generate', material: '   ' }),
    /material.*required/,
    'whitespace is not a description',
  )
  // direct mode needs no description, so it must get PAST the gate and die on
  // the missing install instead.
  await assert.rejects(
    () => materialFromPhoto(broken, { imagePath: photo, mode: 'direct' }),
    /main\.py not found/,
    'direct mode must not ask for a description',
  )
  // an unknown mode falls back to generate, not to the permissive path
  await assert.rejects(
    () => materialFromPhoto(broken, { imagePath: photo, mode: 'whatever' }),
    /material.*required/,
  )
})

test('python helpers speak utf8 through the pipe, so non-ASCII paths survive', async () => {
  // The bug this guards: a piped CPython encodes stdout with the LOCALE codec
  // (cp936 on Chinese Windows) while this side decodes utf8, so every path the
  // helper echoes back becomes U+FFFD. `pbr_check_maps` on D:\DSH材质\... really
  // did record "D:\DSH????\..." in the manifest's metrics block.
  const python = loadConfig().comfy.python
  if (!python || !existsSync(python)) {
    console.log('  (skipped: no python discovered on this machine)')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'pbr-utf8-'))
  const script = join(dir, 'emit.py')
  writeFileSync(
    script,
    'import json, sys\nprint(json.dumps({"dir": r"D:/DSH材质/x"}, ensure_ascii=False))\nprint(sys.stdout.encoding)\n',
    'utf8',
  )
  const { stdout } = await runPython(python, script, [], { timeoutMs: 60000 })
  const [line, encoding] = stdout.split(/\r?\n/)
  assert.equal(JSON.parse(line).dir, 'D:/DSH材质/x', 'the Chinese path must come back intact')
  assert.match(String(encoding), /utf-?8/i, `stdout encoding must be forced to utf-8, got ${encoding}`)
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
