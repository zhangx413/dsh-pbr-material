/**
 * End-to-end test of the web UI's host half, over real HTTP.
 *
 * Starts the same route table the plugin mounts inside DSH on an ephemeral
 * port and drives it with fetch. The GPU part (a real generate) is opt-in
 * because it loads ~5 GB of weights:
 *
 *   node --test test/webui_api.mjs                       # routes only
 *   $env:PBR_WEBUI_GENERATE=1; node --test test/webui_api.mjs
 *
 * The generate case deliberately writes into a directory whose name contains
 * non-ASCII characters: an earlier PowerShell-driven probe silently turned
 * "D:\DSH材质" into "D:\DSH??", so UTF-8 across the wire is asserted here.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadConfig } from '../lib/config.js'
import { resetModelCache } from '../lib/draft.js'
import { handleRequest, injectClientTag } from '../lib/webui.js'

/**
 * Fixtures are optional so this runs on any machine. The upload/serve/guard
 * cases use a synthetic buffer; only two cases need real files, and they skip
 * with instructions instead of failing.
 *   PBR_TEST_PHOTO   a real photo, for the opt-in generate case
 *   PBR_TEST_MAPSET  a directory of albedo/normal/... PNGs, for the check case
 */
const REFERENCE = process.env.PBR_TEST_PHOTO ?? ''
const EXISTING_MAP_SET = process.env.PBR_TEST_MAPSET ?? ''
// Deliberately non-ASCII: the earlier PowerShell-driven probe silently turned
// "D:\DSH材质" into "D:\DSH??", so UTF-8 across the wire is an assertion.
const OUT_DIR = join(mkdtempSync(join(tmpdir(), 'pbr-webui-')), 'DSH材质', 'pbr-materials', 'web-api-test')

/** A byte buffer is all the upload route stores — no need for a real image. */
function syntheticImage(bytes = 4096) {
  const buf = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 1) buf[i] = (i * 31 + 7) & 0xff
  return buf
}

/**
 * Stand-in for the DSH host context: a provider that advertises a vision model,
 * a `stream` that answers like a chatty model, and an attachment store that
 * records what was handed over.
 */
function fakeCtx({ providerId = 'fake-provider', visionModel = true, defaultSel = null } = {}) {
  const state = { saved: [], streamed: [], providers: 0 }
  const llm = {
    async listProviders() {
      state.providers += 1
      return [{ id: providerId, name: 'Fake Provider' }]
    },
    async listModels(provider) {
      const models = [{ provider, id: 'text-only', name: 'Text Only', inputModalities: ['text'] }]
      if (visionModel) models.push({ provider, id: 'sees-images', name: 'Sees Images', inputModalities: ['text', 'image'] })
      return models
    },
    stream(options) {
      state.streamed.push(options)
      return (async function* () {
        // A preamble and quotes: cleanDescription must strip both.
        yield { type: 'text-delta', index: 0, text: 'Here is the description:\n\n' }
        yield {
          type: 'text-delta',
          index: 0,
          text: '"weathered orange-red enamel paint on metal, chipped and scratched, dust and grime, matte finish"',
        }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 24 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const attachments = {
    async saveImage(input) {
      state.saved.push(input)
      return {
        attachmentId: 'att-test-1',
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 230,
        height: 242,
        name: input.name,
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'attachments') return attachments
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => defaultSel ?? { provider: providerId, model: 'text-only' } }
      }
      return undefined
    },
  }
  return { ctx, state }
}

async function startServer(ctx = null) {
  const cfg = loadConfig()
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/pbr-material/')) {
      handleRequest(cfg, req, res, ctx).catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(injectClientTag('<!doctype html><html><body><p>x</p></body></html>'))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { server, base: `http://127.0.0.1:${port}` }
}

test('routes: index injection, bundle, status, upload, file guard, check, hello', async () => {
  const { server, base } = await startServer()
  try {
    const index = await (await fetch(`${base}/`)).text()
    assert.match(index, /<script defer src="\/pbr-material\/client\.js"><\/script>/)
    assert.ok(index.indexOf('client.js') < index.indexOf('</body>'))

    const bundle = await fetch(`${base}/pbr-material/client.js`)
    assert.equal(bundle.status, 200)
    assert.match(bundle.headers.get('content-type'), /javascript/)
    assert.match(await bundle.text(), /__ModuleLoader__/)

    const status = await (await fetch(`${base}/pbr-material/api/status`)).json()
    assert.equal(status.comfy.installFound, true)
    assert.equal(status.modelsReady, true)

    // upload
    const buf = syntheticImage()
    const up = await (
      await fetch(`${base}/pbr-material/api/upload?name=${encodeURIComponent('橙色油桶.png')}`, {
        method: 'POST',
        body: buf,
        headers: { 'content-type': 'image/png' },
      })
    ).json()
    assert.equal(up.bytes, buf.length)
    assert.equal(up.name, '橙色油桶.png', 'the original (non-ASCII) filename must survive')
    assert.ok(existsSync(up.path))

    // content addressing: the same bytes must not create a second file
    const again = await (
      await fetch(`${base}/pbr-material/api/upload?name=other.png`, { method: 'POST', body: buf })
    ).json()
    assert.equal(again.path, up.path)

    // serving the staged file
    const served = await fetch(`${base}/pbr-material/api/file?p=${encodeURIComponent(up.path)}`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    assert.equal((await served.arrayBuffer()).byteLength, buf.length)

    // anything outside the roots the host has itself used is refused
    const denied = await fetch(`${base}/pbr-material/api/file?p=${encodeURIComponent('C:\\Windows\\win.ini')}`)
    assert.equal(denied.status, 403)

    // check an existing map set (needs PBR_TEST_MAPSET; skipped otherwise)
    if (!EXISTING_MAP_SET || !existsSync(EXISTING_MAP_SET)) {
      const refused = await fetch(`${base}/pbr-material/api/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: join(tmpdir(), 'definitely-not-here') }),
      })
      assert.equal(refused.status, 404, 'a missing directory must be a clean 404')
      console.log('  (skipped the map-set check: set PBR_TEST_MAPSET to run it)')
    } else {
      const check = await (
        await fetch(`${base}/pbr-material/api/check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir: EXISTING_MAP_SET }),
        })
      ).json()
      assert.ok(Array.isArray(check.maps) && check.maps.length > 0)
      for (const m of check.maps) assert.equal(typeof m.pass, 'boolean')
      // and its previews become servable because check() allowed that root
      if (check.previews && check.previews.length) {
        const prev = await fetch(`${base}/pbr-material/api/file?p=${encodeURIComponent(check.previews[0])}`)
        assert.equal(prev.status, 200)
      }
    }

    // the browser half's load beacons
    await fetch(`${base}/pbr-material/api/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'applied' }),
    })
    const clients = await (await fetch(`${base}/pbr-material/api/clients`)).json()
    assert.equal(clients.bundleRequests, 1, 'the bundle fetch must be observable from the host')
    assert.equal(clients.appliedCount, 1)
    assert.equal(clients.beacons.at(-1).stage, 'applied')

    // reveal refuses paths it never used
    const revealDenied = await fetch(`${base}/pbr-material/api/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'C:\\Windows' }),
    })
    assert.equal(revealDenied.status, 403)
  } finally {
    server.close()
  }
})

test('models: lists what can actually see an image, and what the agent default is', async () => {
  resetModelCache()
  const { ctx } = fakeCtx()
  const { server, base } = await startServer(ctx)
  try {
    const listed = await (await fetch(`${base}/pbr-material/api/models`)).json()
    assert.equal(listed.available, true)
    assert.deepEqual(listed.providers, ['fake-provider'])
    assert.deepEqual(listed.vision.map((v) => v.model), ['sees-images'], 'text-only models must not be offered')
    assert.equal(listed.default.model, 'text-only')
  } finally {
    server.close()
  }
})

test('draft: the photo goes to the model and its answer becomes the material line', async () => {
  resetModelCache()
  const { ctx, state } = fakeCtx()
  const { server, base } = await startServer(ctx)
  try {
    const buf = syntheticImage(8192)
    const up = await (
      await fetch(`${base}/pbr-material/api/upload?name=橙色油桶.png`, { method: 'POST', body: buf })
    ).json()

    const drafted = await (
      await fetch(`${base}/pbr-material/api/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imagePath: up.path, requirement: '做成能平铺的旧漆，要留住剥落露出的底色' }),
      })
    ).json()

    assert.equal(drafted.ok, true, JSON.stringify(drafted))
    // the preamble paragraph and the surrounding quotes are gone
    assert.equal(
      drafted.description,
      'weathered orange-red enamel paint on metal, chipped and scratched, dust and grime, matte finish',
    )
    assert.equal(drafted.model, 'sees-images', 'the default (text-only) model must not be chosen')
    assert.equal(drafted.vision, true)

    // the reference bytes were admitted, and the model actually received both
    // the user's intent and the image
    assert.equal(state.saved.length, 1)
    assert.equal(state.saved[0].data.length, buf.length)
    assert.equal(state.saved[0].mediaType, 'image/png')
    assert.equal(state.streamed.length, 1)
    const content = state.streamed[0].messages[0].content
    assert.equal(content[0].type, 'text')
    assert.match(content[0].text, /能平铺的旧漆/)
    assert.equal(content[1].type, 'image')
    assert.equal(content[1].attachment.attachmentId, 'att-test-1')
  } finally {
    server.close()
  }
})

test('draft: a missing image and a model-less host both fail with a usable message', async () => {
  resetModelCache()
  const { ctx } = fakeCtx()
  const { server, base } = await startServer(ctx)
  try {
    const missing = await fetch(`${base}/pbr-material/api/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imagePath: 'D:\\nope\\missing.png', requirement: 'x' }),
    })
    assert.equal(missing.status, 400)
  } finally {
    server.close()
  }

  // no ctx at all == not running inside DSH
  const bare = await startServer(null)
  try {
    const refused = await fetch(`${bare.base}/pbr-material/api/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imagePath: REFERENCE, requirement: 'x' }),
    })
    assert.equal(refused.status, 503)
    const models = await (await fetch(`${bare.base}/pbr-material/api/models`)).json()
    assert.equal(models.available, false)
  } finally {
    bare.server.close()
  }
})

test('naming: the plan the panel previews is the plan the host will write', async () => {
  const { server, base } = await startServer()
  try {
    const filled = await (
      await fetch(`${base}/pbr-material/api/naming?category=Military&name=SandBag&version=01`)
    ).json()
    assert.equal(filled.plan.assetName, 'T_Military_SandBag_01')
    assert.equal(filled.plan.folder, 'T_Military_SandBag_01')
    assert.equal(filled.plan.files.find((f) => f.key === 'albedo').name, 'T_Military_SandBag_01_C.png')
    assert.deepEqual(
      filled.plan.packed.map((p) => p.name),
      ['T_Military_SandBag_01_CA.png', 'T_Military_SandBag_01_CH.png', 'T_Military_SandBag_01_NRM.png'],
    )
    assert.equal(filled.suffixes.normal, '_N')

    const empty = await (await fetch(`${base}/pbr-material/api/naming?category=Military`)).json()
    assert.equal(empty.plan, null, 'an incomplete name must not pretend to have a plan')
    assert.ok(empty.naming, 'defaults still come back so the panel can seed the fields')
  } finally {
    server.close()
  }
})

test('generate: full job through HTTP, asset naming + non-ASCII output path', {
  skip: !process.env.PBR_WEBUI_GENERATE
    ? 'set PBR_WEBUI_GENERATE=1 (needs a GPU and ~5 GB of weights)'
    : (!REFERENCE || !existsSync(REFERENCE) ? 'set PBR_TEST_PHOTO to a reference photo' : false),
}, async () => {
  const { server, base } = await startServer()
  try {
    const buf = readFileSync(REFERENCE)
    const up = await (
      await fetch(`${base}/pbr-material/api/upload?name=orange.png`, { method: 'POST', body: buf })
    ).json()

    const gen = await (
      await fetch(`${base}/pbr-material/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          imagePath: up.path,
          material: 'weathered orange-red enamel paint on metal, chipped, dust and grime, matte aged finish',
          outDir: OUT_DIR,
          naming: { category: 'Test', name: 'OrangeCan', version: '01', pack: true },
          size: 320,
          steps: 8,
          seed: 11,
          colorMatch: { mode: 'hue', strength: 0.6 },
          pbr: { metallic: 0, baseRoughness: 0.55 },
        }),
      })
    ).json()
    assert.ok(gen.id, `generate must return a job id, got ${JSON.stringify(gen)}`)

    const deadline = Date.now() + 8 * 60 * 1000
    let job = null
    while (Date.now() < deadline) {
      job = await (await fetch(`${base}/pbr-material/api/job?id=${gen.id}`)).json()
      if (job.state === 'done' || job.state === 'error') break
      await new Promise((r) => setTimeout(r, 3000))
    }
    assert.equal(job.state, 'done', `job failed: ${job.error}`)
    assert.equal(
      job.outDir,
      `${OUT_DIR}\\T_Test_OrangeCan_01`,
      'one folder per material set, named by the convention',
    )
    assert.equal(job.result.asset, 'T_Test_OrangeCan_01')
    assert.equal(Object.keys(job.result.maps).length, 7)
    assert.ok(job.log.length > 3, 'the job must expose progress logs')

    const asset = 'T_Test_OrangeCan_01'
    const files = readdirSync(job.outDir)
    for (const name of [
      `${asset}_C.png`, `${asset}_N.png`, `${asset}_R.png`, `${asset}_AO.png`,
      `${asset}_M.png`, `${asset}_H.png`, `${asset}_CURV.png`,
    ]) {
      assert.ok(files.includes(name), `missing ${name} in ${files.join(', ')}`)
    }
    for (const name of [`${asset}_CA.png`, `${asset}_CH.png`, `${asset}_NRM.png`]) {
      assert.ok(files.includes(name), `missing packed ${name}`)
    }
    assert.ok(files.includes('manifest.json'))
    assert.equal(job.result.packed.length, 3)
    const previews = readdirSync(`${job.outDir}\\preview`)
    assert.ok(previews.some((f) => f.endsWith('_tiled3x3.png')), `no tiling preview in ${previews.join(', ')}`)
    assert.ok(previews.includes(`${asset}_ref.png`), 'the reference copy lives with the previews')

    // the maps still map to keys, even though the file names no longer say so
    // (this is why the pipeline passes --map explicitly instead of scanning)
    const metricKeys = job.result.metrics.maps.map((m) => m.key)
    assert.deepEqual(metricKeys.sort(), ['albedo', 'ao', 'curvature', 'height', 'metallic', 'normal', 'roughness'])

    // every produced map is servable
    for (const [key, p] of Object.entries(job.result.maps)) {
      const r = await fetch(`${base}/pbr-material/api/file?p=${encodeURIComponent(p)}`)
      assert.equal(r.status, 200, `${key} not servable`)
      assert.ok(Number(r.headers.get('content-length')) > 0)
    }
    assert.deepEqual(metricKeys.sort(), ['albedo', 'ao', 'curvature', 'height', 'metallic', 'normal', 'roughness'])
  } finally {
    server.close()
  }
})
