/**
 * Deterministic tests for the downloader — no internet, no GPU.
 *
 * The risky part of "the agent deploys the models" is not the HTTP request, it
 * is everything around it: resuming a `.part`, honouring a 206, retrying after
 * a connection that dies mid-stream, discarding a `.part` that is longer than
 * the file, and never reporting a short file as complete. A local server makes
 * all of that reproducible, so this runs in every test pass.
 *
 *   node --test test/download.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { downloadModel, freeBytes, inspectModels, modelPath } from '../lib/models.js'

/** 5 MB of pseudo-random bytes, plus its hash so truncation cannot pass. */
function makePayload(bytes = 5 * 1024 * 1024) {
  const buf = Buffer.alloc(bytes)
  let seed = 12345
  for (let i = 0; i < bytes; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    buf[i] = seed & 0xff
  }
  return buf
}

const PAYLOAD = makePayload()
const PAYLOAD_SHA = createHash('sha1').update(PAYLOAD).digest('hex')

/**
 * @param {object} opts
 * @param {number} [opts.dropAfter] close the socket after this many bytes (once)
 * @param {string[]} [opts.requests] collects Range headers
 */
function serve(opts = {}) {
  const state = { ranged: [], dropAfter: opts.dropAfter ?? null, dropped: false }
  const server = createServer((req, res) => {
    state.ranged.push(req.headers.range ?? null)
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    if (start >= PAYLOAD.length) {
      res.writeHead(416, { 'content-length': '0' })
      res.end()
      return
    }
    const body = PAYLOAD.subarray(start)
    res.writeHead(range ? 206 : 200, {
      'content-length': String(body.length),
      'content-type': 'application/octet-stream',
      ...(range ? { 'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` } : {}),
    })
    if (state.dropAfter !== null && !state.dropped) {
      state.dropped = true
      res.write(body.subarray(0, state.dropAfter))
      setTimeout(() => res.destroy(), 10)
      return
    }
    res.end(body)
  })
  return { server, state }
}

async function withServer(opts, run) {
  const { server, state } = serve(opts)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base, state)
  } finally {
    server.close()
  }
}

const descriptor = (base) => ({
  key: 'test',
  name: 'test-model.safetensors',
  directory: 'diffusion_models',
  bytes: PAYLOAD.length,
  urls: [`${base}/file.safetensors`],
})

/** Pre-seed a `.part` (or the target) the way an interrupted run would leave it. */
function seed(modelsDir, name, bytes) {
  const target = join(modelsDir, 'diffusion_models', 'test-model.safetensors')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(name === 'part' ? `${target}.part` : target, bytes)
  return target
}

test('downloads a fresh file and lands it byte-exact under the target name', async () => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  await withServer({}, async (base, state) => {
    const result = await downloadModel(descriptor(base), { modelsDir, retryDelayMs: 50 })
    assert.equal(result.skipped, false)
    assert.equal(result.bytes, PAYLOAD.length)
    assert.equal(result.drift, null)
    const target = modelPath(modelsDir, descriptor(base))
    assert.ok(existsSync(target))
    assert.equal(createHash('sha1').update(readFileSync(target)).digest('hex'), PAYLOAD_SHA)
    assert.equal(existsSync(`${target}.part`), false, 'the .part must be gone after a successful rename')
    assert.deepEqual(state.ranged, [null], 'a fresh download must not send a Range header')
  })
})

test('resumes from an existing .part instead of restarting', async () => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  const model = descriptor('http://placeholder')
  const target = modelPath(modelsDir, model)
  const resumeFrom = 1_500_000
  seed(modelsDir, 'part', PAYLOAD.subarray(0, resumeFrom))

  await withServer({}, async (base, state) => {
    const result = await downloadModel(descriptor(base), { modelsDir, retryDelayMs: 50 })
    assert.equal(result.bytes, PAYLOAD.length)
    assert.equal(result.attempts.length, 0, 'a clean resume is not a retry')
    assert.deepEqual(state.ranged, [`bytes=${resumeFrom}-`], 'the request must ask for exactly the missing range')
  })
  assert.equal(createHash('sha1').update(readFileSync(target)).digest('hex'), PAYLOAD_SHA)
})

test('retries after the connection dies mid-stream, and finishes', async () => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  await withServer({ dropAfter: 400_000 }, async (base) => {
    const result = await downloadModel(descriptor(base), { modelsDir, retryDelayMs: 30 })
    assert.equal(result.bytes, PAYLOAD.length)
    assert.equal(createHash('sha1').update(readFileSync(modelPath(modelsDir, descriptor(base)))).digest('hex'), PAYLOAD_SHA)
    assert.ok(result.attempts.length >= 1, 'a mid-stream death must be recorded as an attempt')
    assert.match(result.attempts[0].error, /提前结束|socket|aborted|ECONNRESET/i)
  })
})

test('aborts the retry loop when the signal fires', async () => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  const controller = new AbortController()
  await withServer({ dropAfter: 100_000 }, async (base) => {
    controller.abort()
    await assert.rejects(
      () => downloadModel(descriptor(base), { modelsDir, retryDelayMs: 10, signal: controller.signal }),
      /aborted/,
    )
  })
})

test('a .part longer than the file is discarded rather than trusted', async () => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  const model = descriptor('http://placeholder')
  const target = modelPath(modelsDir, model)
  // Longer than the real file: the server answers 416, and the downloader must
  // throw the junk away and fetch it again.
  seed(modelsDir, 'part', Buffer.concat([PAYLOAD, Buffer.alloc(1000)]))
  await withServer({}, async (base) => {
    const result = await downloadModel(descriptor(base), { modelsDir, retryDelayMs: 20 })
    assert.equal(result.bytes, PAYLOAD.length)
    assert.equal(createHash('sha1').update(readFileSync(target)).digest('hex'), PAYLOAD_SHA)
    assert.ok(
      result.attempts.some((a) => /416/.test(a.error)),
      `expected a 416 attempt, got ${JSON.stringify(result.attempts)}`,
    )
  })
})

test('an existing complete file is skipped, and a size mismatch is reported not hidden', async () => {
  const modelsDir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  const model = descriptor('http://placeholder')
  const target = seed(modelsDir, 'target', PAYLOAD)

  const skipped = await downloadModel(descriptor('http://unused'), { modelsDir })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.transport, 'existing')
  assert.equal(skipped.drift, null)

  // a wrong-sized existing file is reported with its drift, never overwritten
  writeFileSync(target, PAYLOAD.subarray(0, 1000))
  const drifted = await downloadModel(descriptor('http://unused'), { modelsDir })
  assert.equal(drifted.skipped, true)
  assert.equal(drifted.drift, 1000 - PAYLOAD.length)
  assert.equal(statSync(target).size, 1000, 'the existing file must be left alone')

  // inspectModels speaks about the three real weights, with explicit keys
  const fresh = inspectModels(modelsDir)
  assert.deepEqual(fresh.map((m) => m.key), ['unet', 'textEncoder', 'vae'])
  assert.ok(fresh.every((m) => m.present === false), 'a temp dir holds none of the real weights')
  assert.ok(fresh.every((m) => m.complete === false))
})

test('freeBytes reports something usable for an existing and a missing path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pbr-dl-'))
  const free = freeBytes(dir)
  assert.ok(free === null || free > 0, `expected a number or null, got ${free}`)
  assert.ok(freeBytes(join(dir, 'does', 'not', 'exist')) !== undefined)
})
