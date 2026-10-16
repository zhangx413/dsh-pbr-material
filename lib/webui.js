/**
 * The plugin's browser half, served and wired from the host.
 *
 * Why this does not use the `dsh.client` bundle table: this plugin is loaded by
 * ABSOLUTE PATH (the profile patch `insert` form), so there is no profile
 * package for the client scan to find. Instead the host serves its own client
 * bundle and injects one <script> into index.html — the same
 * `webServer.register` + `tapIndex` surface dsh-balance uses for its routes.
 * A side benefit: editing client/client.js only needs a page refresh.
 *
 * Routes (all under /pbr-material/):
 *   GET  client.js            the bundle
 *   GET  api/status           environment readiness (install/models/VRAM/instance)
 *   GET  api/jobs             job list, newest first
 *   GET  api/job?id=          one job (progress, log tail, result)
 *   POST api/generate         start a job  -> {id}
 *   POST api/upload?name=     raw image bytes -> staged path
 *   GET  api/file?p=<abs>     a PNG, restricted to roots the host has itself used
 *   POST api/check            measure an existing map directory
 *   POST api/reveal           open a directory in the OS file manager
 *   POST api/hello            the browser half checks in (load verification)
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'

import { PLUGIN_DIR } from './config.js'
import { checkMaps, materialFromPhoto, status } from './pipeline.js'
import { defaultSelection, draftMaterial, listVisionModels } from './draft.js'
import { DEFAULT_SUFFIXES, planNames } from './naming.js'

const PREFIX = '/pbr-material/'
// The route is registered without the trailing slash so it also claims the
// bare '/pbr-material' path; a plain prefix match covers everything under it.
const MOUNT = '/pbr-material'
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const MAX_LOG_LINES = 300

const jobs = new Map()
const allowedRoots = new Set()
let jobSeq = 0
/**
 * Load diagnostics for the browser half. The host can observe its own routes
 * but not the page, so the bundle reports each stage back:
 *   bundleRequests 0              -> the tag/route never reached the renderer
 *   bundleRequests > 0, no beacon -> fetched but never executed (CSP, MIME…)
 *   beacon 'boot' but no 'applied'-> the module loader refused the bundle
 */
let bundleRequests = 0
const beacons = []

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendBytes(res, code, buf, type) {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  })
  res.end(buf)
}

function allowRoot(dir) {
  if (!dir) return
  try {
    allowedRoots.add(resolve(dir))
  } catch {}
}

function isAllowed(filePath) {
  const target = resolve(filePath)
  for (const root of allowedRoots) {
    if (target === root || target.startsWith(root + sep)) return true
  }
  return false
}

function readBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const buf = await readBody(req, 4 * 1024 * 1024)
  if (buf.length === 0) return {}
  return JSON.parse(buf.toString('utf8'))
}

function newJob(request) {
  jobSeq += 1
  const id = `pbr-${Date.now().toString(36)}-${jobSeq}`
  const job = {
    id,
    state: 'queued',
    phase: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    log: [],
    request,
    result: null,
    error: null,
  }
  jobs.set(id, job)
  return job
}

function pushLog(job, line) {
  job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES)
}

function jobView(job, { full = false } = {}) {
  const base = {
    id: job.id,
    state: job.state,
    phase: job.phase,
    createdAt: job.createdAt,
    elapsedMs: job.state === 'running' ? Date.now() - job.startedAt : job.elapsedMs,
    material: job.request?.material ?? '',
    imageName: job.request?.imagePath ? basename(job.request.imagePath) : '',
    outDir: job.request?.outDir ?? null,
    error: job.error,
  }
  if (!full) return base
  return { ...base, startedAt: job.startedAt, finishedAt: job.finishedAt, log: job.log, result: job.result }
}

function stagingDir() {
  const dir = join(tmpdir(), 'dsh-pbr-material', 'uploads')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Run one pipeline job in the background and keep its observable state.
 * The HTTP request returns immediately with the job id; the panel polls.
 */
function startJob(cfg, request) {
  const job = newJob(request)
  job.state = 'running'
  job.startedAt = Date.now()
  job.phase = 'starting'

  const run = materialFromPhoto(cfg, request, {
    log: (line) => {
      pushLog(job, line)
      lastLogger?.info?.(`[pbr] ${line}`)
    },
    onProgress: ({ phase, elapsedMs }) => {
      job.phase = phase
      job.elapsedMs = elapsedMs
    },
  })

  run
    .then((result) => {
      job.state = 'done'
      job.phase = 'done'
      job.finishedAt = Date.now()
      job.elapsedMs = job.finishedAt - job.startedAt
      job.result = result
      if (result?.outDir) allowRoot(result.outDir)
      pushLog(job, `done: ${Object.keys(result?.maps ?? {}).length} maps -> ${result?.outDir}`)
    })
    .catch((error) => {
      job.state = 'error'
      job.phase = 'error'
      job.finishedAt = Date.now()
      job.elapsedMs = job.finishedAt - job.startedAt
      job.error = String(error?.message ?? error)
      pushLog(job, `FAILED: ${job.error}`)
    })

  return job
}

let lastLogger = null

export async function handleRequest(cfg, req, res, ctx = null) {
  const url = new URL(req.url ?? PREFIX, 'http://127.0.0.1')
  const path = url.pathname

  if (path === `${PREFIX}client.js`) {
    bundleRequests += 1
    const file = join(PLUGIN_DIR, 'client', 'client.js')
    if (!existsSync(file)) return json(res, 500, { error: 'client bundle missing' })
    return sendBytes(res, 200, readFileSync(file), 'application/javascript; charset=utf-8')
  }

  if (path === `${PREFIX}api/hello`) {
    let payload = {}
    try {
      payload = await readJson(req)
    } catch {}
    beacons.push({ at: Date.now(), ...payload })
    if (beacons.length > 50) beacons.splice(0, beacons.length - 50)
    return json(res, 200, { ok: true })
  }

  if (path === `${PREFIX}api/clients`) {
    return json(res, 200, {
      bundleRequests,
      checkins: beacons.length,
      appliedCount: beacons.filter((b) => b.stage === 'applied').length,
      beacons: beacons.slice(-12),
    })
  }

  if (path === `${PREFIX}api/status`) {
    return json(res, 200, await status(cfg))
  }

  // What the panel offers for "let a model look at the photo and write the
  // English material description". Discovery talks to the configured
  // providers, so the result is cached in draft.js.
  if (path === `${PREFIX}api/models`) {
    if (!ctx) return json(res, 200, { available: false, reason: '不在 DSH 内运行', providers: [], vision: [] })
    const listed = await listVisionModels(ctx)
    return json(res, 200, { ...listed, default: defaultSelection(ctx) })
  }

  // The exact file plan for the studio naming convention. The panel renders it
  // verbatim, so what the user reads is what the host will write — one source
  // of truth instead of a second copy of the rules inside the browser bundle.
  if (path === `${PREFIX}api/naming`) {
    const suffixes = cfg.naming?.suffixes ?? {}
    const plan = planNames(
      {
        prefix: url.searchParams.get('prefix') ?? cfg.naming?.prefix,
        category: url.searchParams.get('category') ?? '',
        name: url.searchParams.get('name') ?? '',
        version: url.searchParams.get('version') ?? cfg.naming?.version,
      },
      suffixes,
    )
    return json(res, 200, {
      ok: true,
      naming: cfg.naming,
      suffixes: { ...DEFAULT_SUFFIXES, ...suffixes },
      plan,
    })
  }

  if (path === `${PREFIX}api/draft` && req.method === 'POST') {
    if (!ctx) return json(res, 503, { error: '不在 DSH 内运行，没有 llm/attachments 服务' })
    const body = await readJson(req)
    const imagePath = body.imagePath ? resolve(String(body.imagePath)) : ''
    if (!imagePath || !existsSync(imagePath)) {
      return json(res, 400, { error: `reference image not found: ${imagePath || '(none)'}` })
    }
    allowRoot(resolve(imagePath, '..'))
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const started = Date.now()
    try {
      const result = await draftMaterial(ctx, {
        imagePath,
        requirement: body.requirement,
        provider: body.provider,
        model: body.model,
        signal: controller.signal,
      })
      return json(res, 200, { ok: true, ...result, elapsedMs: Date.now() - started })
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error) })
    }
  }

  if (path === `${PREFIX}api/jobs`) {
    return json(res, 200, { jobs: [...jobs.values()].reverse().map((j) => jobView(j)) })
  }

  if (path === `${PREFIX}api/job`) {
    const job = jobs.get(url.searchParams.get('id') ?? '')
    if (!job) return json(res, 404, { error: 'unknown job' })
    return json(res, 200, jobView(job, { full: true }))
  }

  if (path === `${PREFIX}api/upload` && req.method === 'POST') {
    const raw = url.searchParams.get('name') ?? 'reference.png'
    // Keep Unicode letters: a name like 橙色油桶.png must not become _.png, it is
    // what the panel shows back to the user. The stored file is content
    // addressed anyway, so the display name is the only thing at stake.
    const safe = (basename(raw).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'reference.png')
    const ext = extname(safe) || '.png'
    const buf = await readBody(req)
    if (buf.length === 0) return json(res, 400, { error: 'empty upload' })
    const dir = stagingDir()
    // Content-addressed name: re-dropping the same photo reuses one file.
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12)
    const file = join(dir, `${hash}${ext}`)
    if (!existsSync(file)) writeFileSync(file, buf)
    allowRoot(dir)
    return json(res, 200, {
      ok: true,
      path: file,
      name: safe,
      bytes: buf.length,
      url: `${PREFIX}api/file?p=${encodeURIComponent(file)}`,
    })
  }

  if (path === `${PREFIX}api/file`) {
    const target = url.searchParams.get('p')
    if (!target) return json(res, 400, { error: 'missing p' })
    const abs = resolve(target)
    if (!isAllowed(abs)) return json(res, 403, { error: 'path not in an allowed root' })
    if (!existsSync(abs) || !statSync(abs).isFile()) return json(res, 404, { error: 'not a file' })
    const ext = extname(abs).toLowerCase()
    const type = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'
    return sendBytes(res, 200, readFileSync(abs), type)
  }

  if (path === `${PREFIX}api/generate` && req.method === 'POST') {
    const body = await readJson(req)
    if (!body.imagePath || !existsSync(body.imagePath)) {
      allowRoot(body.imagePath ? resolve(body.imagePath, '..') : null)
      return json(res, 400, { error: `reference image not found: ${body.imagePath ?? '(none)'}` })
    }
    if (!body.material || !String(body.material).trim()) {
      return json(res, 400, { error: 'material description is required' })
    }
    allowRoot(resolve(body.imagePath, '..'))
    const naming = body.naming && (body.naming.category || body.naming.name)
      ? {
        prefix: body.naming.prefix ?? cfg.naming?.prefix,
        category: body.naming.category,
        name: body.naming.name,
        version: body.naming.version ?? cfg.naming?.version,
        pack: body.naming.pack !== false,
      }
      : null
    if (naming && !planNames(naming, cfg.naming?.suffixes)) {
      return json(res, 400, { error: '命名不完整：资源类别和资源名称都要填' })
    }
    const request = {
      imagePath: resolve(body.imagePath),
      material: String(body.material),
      name: body.name ? String(body.name) : undefined,
      outDir: body.outDir ? resolve(String(body.outDir)) : undefined,
      naming,
      size: body.size,
      steps: body.steps,
      cfg: body.cfg,
      seed: body.seed,
      colorMatch: body.colorMatch,
      pbr: body.pbr,
      keepInstance: body.keepInstance === true,
      forceSpawn: body.forceSpawn === true,
    }
    const job = startJob(cfg, request)
    if (body.draft && typeof body.draft === 'object') {
      job.draft = {
        requirement: String(body.draft.requirement ?? '').slice(0, 500),
        provider: body.draft.provider ?? null,
        model: body.draft.model ?? null,
      }
      pushLog(job, `材质描述由 ${job.draft.provider}/${job.draft.model} 看图生成`)
    }
    pushLog(job, `queued: ${basename(request.imagePath)} -> ${request.outDir ?? '(default)'}`)
    return json(res, 200, { id: job.id })
  }

  if (path === `${PREFIX}api/check` && req.method === 'POST') {
    const body = await readJson(req)
    if (!body.dir) return json(res, 400, { error: 'dir is required' })
    const dir = resolve(String(body.dir))
    if (!existsSync(dir)) return json(res, 404, { error: `not found: ${dir}` })
    allowRoot(dir)
    const result = await checkMaps(cfg, { dir, normal: body.normal })
    return json(res, 200, result)
  }

  if (path === `${PREFIX}api/reveal` && req.method === 'POST') {
    const body = await readJson(req)
    const dir = resolve(String(body.path ?? ''))
    if (!isAllowed(dir)) return json(res, 403, { error: 'path not in an allowed root' })
    if (!existsSync(dir)) return json(res, 404, { error: `not found: ${dir}` })
    try {
      const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
      return json(res, 200, { ok: true })
    } catch (error) {
      return json(res, 500, { error: String(error?.message ?? error) })
    }
  }

  return json(res, 404, { error: `no route for ${path}` })
}

/** One <script> before </body>; the bundle itself waits for the module loader. */
export function injectClientTag(html) {
  const tag = `<script defer src="${PREFIX}client.js"></script>`
  if (html.includes(`${PREFIX}client.js`)) return html
  if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`)
  return html + tag
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => object} getConfig resolved config, re-read per request
 */
export function registerWebUI(ctx, getConfig) {
  lastLogger = ctx.logger
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: MOUNT,
          handler: (req, res) => handleRequest(getConfig(), req, res, ctx).catch((error) => {
            try {
              json(res, 500, { error: String(error?.message ?? error) })
            } catch {}
          }),
        }),
      'dsh-pbr-material: routes',
    )
    webCtx.effect(
      () => webCtx.webServer.tapIndex((html) => injectClientTag(html)),
      'dsh-pbr-material: index injection',
    )
    ctx.logger?.info?.(`[dsh-pbr-material] web UI mounted at ${PREFIX}`)
  })
}
