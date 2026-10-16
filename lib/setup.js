/**
 * Deployment: make a machine ready, without the user editing files.
 *
 * The whole point of the exercise — "install the plugin and the agent deploys
 * it" — is this module plus the two tools over it. Everything here is
 * idempotent: running it twice is a no-op the second time, and every step
 * reports what it found, what it did, and what is still missing.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { discovery, PLUGIN_DIR } from './config.js'
import { ensureRunRoot, attachOrSpawn, ComfyClient, stopSpawned, spawnedInfo } from './comfy.js'
import { inspectModels, measureThroughput, MODEL_MANIFEST, downloadModel, freeBytes, modelPath } from './models.js'

const TOTAL_BYTES = MODEL_MANIFEST.reduce((n, m) => n + m.bytes, 0)

function runPythonProbe(python, code, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(python, ['-c', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, error: `python 探测超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(e?.message ?? e) })
    })
    child.on('close', (code2) => {
      clearTimeout(timer)
      resolve({ ok: code2 === 0, code: code2, stdout: out.trim(), stderr: err.trim() })
    })
  })
}

/** numpy + Pillow are what step 2/3/4 actually import. torch is ComfyUI's business. */
export async function checkPython(python) {
  if (!python) return { ok: false, error: '没有 python' }
  const which = await runPythonProbe(python, 'import sys; print(sys.version.split()[0]); print(sys.executable)')
  if (!which.ok) return { ok: false, error: which.error ?? which.stderr ?? 'python 起不来' }
  const modules = await runPythonProbe(python, 'import numpy, PIL; print(numpy.__version__); print(PIL.__version__)')
  const parts = (modules.stdout ?? '').split(/\r?\n/)
  return {
    ok: modules.ok,
    version: (which.stdout ?? '').split(/\r?\n/)[0] || null,
    resolved: (which.stdout ?? '').split(/\r?\n/)[1] || python,
    numpy: modules.ok ? parts[0] : null,
    pillow: modules.ok ? parts[1] : null,
    error: modules.ok ? null : (modules.stderr ?? '').slice(-400) || 'import numpy/PIL 失败',
  }
}

/** Everything a status report needs. `throughput` costs a few MB of traffic. */
export async function setupStatus(cfg, { throughput = false } = {}) {
  const found = cfg.discovery ?? discovery()
  const installDir = cfg.comfy.installDir
  const mainPy = installDir ? join(installDir, 'main.py') : null
  const models = inspectModels(cfg.comfy.modelsDir)
  const missing = models.filter((m) => !m.present)
  const partial = models.filter((m) => m.present && m.sizeMismatch)
  const needBytes = missing.reduce((n, m) => n + m.expectedBytes, 0)
  const python = await checkPython(cfg.comfy.python)
  const runRoot = cfg.comfy.runRoot
  const bundledPack = join(PLUGIN_DIR, 'assets', 'pbrlab', 'nodes.py')

  let instance = null
  try {
    const { findAttached } = await import('./comfy.js')
    instance = await findAttached(cfg)
  } catch {}

  const report = {
    ready: Boolean(mainPy && existsSync(mainPy) && python.ok && missing.length === 0),
    discovery: {
      problems: found.problems ?? [],
      appRoot: found.appRoot,
      modelsDir: found.modelsDir,
      python: found.python,
      portHint: found.portHint,
    },
    comfy: {
      installDir,
      mainPy,
      mainPyFound: Boolean(mainPy && existsSync(mainPy)),
    },
    python: { path: cfg.comfy.python, ...python },
    models: {
      dir: cfg.comfy.modelsDir,
      dirExists: Boolean(cfg.comfy.modelsDir && existsSync(cfg.comfy.modelsDir)),
      entries: models,
      missing: missing.map((m) => m.key),
      sizeMismatch: partial.map((m) => ({ key: m.key, bytes: m.bytes, expected: m.expectedBytes })),
      missingBytes: needBytes,
      totalBytes: TOTAL_BYTES,
    },
    nodePack: {
      bundledPath: bundledPack,
      bundled: existsSync(bundledPack),
      linked: existsSync(join(runRoot, 'custom_nodes', 'pbrlab', 'nodes.py')),
    },
    runRoot: { path: runRoot, exists: existsSync(runRoot) },
    downloadTransport: { proxy: cfg.comfy.downloadProxy || '(direct only)' },
    disk: { freeBytes: freeBytes(cfg.comfy.modelsDir || runRoot || '.') },
    instance: instance ? { attached: true, port: instance.port } : { attached: false, spawned: spawnedInfo() },
    installJob: installJob ? jobView(installJob) : null,
    throughput: null,
  }

  if (throughput && missing.length > 0) {
    report.throughput = await measureThroughput(MODEL_MANIFEST.find((m) => m.key === missing[0].key), {
      proxy: cfg.comfy.downloadProxy || null,
    })
  }

  report.nextSteps = []
  if (!report.comfy.mainPyFound) {
    report.nextSteps.push('装一个 ComfyUI（桌面版最省事），或用 config.json 的 comfy.installDir 指到含 main.py 的目录')
  }
  if (!python.ok) report.nextSteps.push(`python 不可用（${python.error}），装 numpy + Pillow 后重试`)
  if (missing.length > 0) {
    report.nextSteps.push(`缺 ${missing.length} 个权重（${(needBytes / 1024 ** 3).toFixed(2)} GB）——调 pbr_setup_install 自动下`)
  }
  if (!report.nodePack.linked) report.nextSteps.push('调 pbr_setup_install 会把内置的 pbrlab 节点包链进 run root')
  if (report.disk.freeBytes !== null && report.disk.freeBytes < needBytes * 1.15) {
    report.nextSteps.push(`磁盘空间可能不够：可用 ${(report.disk.freeBytes / 1024 ** 3).toFixed(1)} GB，需要约 ${(needBytes / 1024 ** 3).toFixed(1)} GB`)
  }
  if (report.ready) report.nextSteps.push('环境就绪，可以直接生成')
  return report
}

/* ------------------------------------------------------------------ */
/* the deploy job                                                      */
/* ------------------------------------------------------------------ */

let installJob = null

function pushLog(job, line) {
  job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
  if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
}

function jobView(job) {
  return {
    id: job.id,
    state: job.state,
    step: job.step,
    stepIndex: job.stepIndex,
    stepCount: job.steps.length,
    steps: job.steps,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    current: job.current,
    errors: job.errors,
    log: job.log.slice(-60),
  }
}

export function setupJob() {
  return installJob ? jobView(installJob) : null
}

export function cancelSetupJob() {
  if (!installJob || installJob.state !== 'running') return false
  installJob.controller.abort()
  installJob.state = 'cancelled'
  pushLog(installJob, '用户取消')
  return true
}

const STEPS = ['检查 ComfyUI', '准备 run root 与节点包', '下载权重', '验证实例能加载节点']

/**
 * Make the machine ready. Idempotent and resumable: `.part` files survive, so
 * re-running after a network failure continues instead of restarting 12.5 GB.
 */
export async function startSetup(cfg, options = {}) {
  if (installJob && installJob.state === 'running') return jobView(installJob)

  const job = {
    id: `setup-${Date.now().toString(36)}`,
    state: 'running',
    steps: STEPS,
    stepIndex: 0,
    step: STEPS[0],
    startedAt: Date.now(),
    finishedAt: null,
    current: null,
    errors: [],
    log: [],
    result: null,
    controller: new AbortController(),
  }
  installJob = job
  const log = (line) => pushLog(job, line)
  const { signal } = job.controller
  const includeModels = options.includeModels !== false

  runSetup(cfg, { job, log, signal, includeModels, options }).catch((error) => {
    job.state = 'error'
    job.finishedAt = Date.now()
    const message = String(error?.message ?? error)
    job.errors.push(message)
    log(`失败：${message}`)
  })
  return jobView(job)
}

async function runSetup(cfg, { job, log, signal, includeModels, options }) {
  const step = (i, name) => {
    job.stepIndex = i
    job.step = name
    log(`── ${name}`)
  }

  // 1 ── ComfyUI + python
  step(0, STEPS[0])
  const mainPy = cfg.comfy.installDir ? join(cfg.comfy.installDir, 'main.py') : null
  if (!mainPy || !existsSync(mainPy)) {
    throw new Error(
      `没找到 ComfyUI：${cfg.comfy.installDir || '(空)'}\n` +
        '装一个 ComfyUI 桌面版最省事；已经有了的话在 config.json 里把 comfy.installDir 指到含 main.py 的目录。',
    )
  }
  const py = await checkPython(cfg.comfy.python)
  log(`ComfyUI: ${cfg.comfy.installDir}`)
  log(`python : ${py.resolved ?? cfg.comfy.python} (numpy ${py.numpy ?? '?'}, Pillow ${py.pillow ?? '?'})`)
  if (!py.ok) {
    throw new Error(
      `python 不可用：${py.error}\n` +
        `它需要 numpy 和 Pillow（第二步的调色/量测/合图都在这里跑）：\n  ${cfg.comfy.python} -m pip install numpy Pillow`,
    )
  }

  // 2 ── run root + node pack
  step(1, STEPS[1])
  mkdirSync(cfg.comfy.runRoot, { recursive: true })
  const { notes } = ensureRunRoot(cfg)
  notes.forEach(log)
  const packLinked = existsSync(join(cfg.comfy.runRoot, 'custom_nodes', 'pbrlab', 'nodes.py'))
  log(packLinked ? 'pbrlab 节点包已就位（插件自带）' : 'pbrlab 节点包没能链上，见上面的报错')

  // 3 ── weights
  step(2, STEPS[2])
  const before = inspectModels(cfg.comfy.modelsDir)
  const missing = before.filter((m) => !m.present)
  if (!includeModels) {
    log(`跳过下载（includeModels=false），当前缺 ${missing.length} 个`)
  } else if (missing.length === 0) {
    log('三个权重都在，跳过下载')
    for (const m of before) {
      if (m.sizeMismatch) log(`注意 ${m.name} 大小与清单不符（${m.bytes} vs ${m.expectedBytes}），沿用现有文件`)
    }
  } else {
    const need = missing.reduce((n, m) => n + m.expectedBytes, 0)
    const free = freeBytes(cfg.comfy.modelsDir)
    log(`缺 ${missing.length} 个，共 ${(need / 1024 ** 3).toFixed(2)} GB；目标目录可用 ${free === null ? '未知' : (free / 1024 ** 3).toFixed(1) + ' GB'}`)
    if (free !== null && free < need * 1.05) {
      throw new Error(`磁盘空间不足：需要约 ${(need / 1024 ** 3).toFixed(2)} GB，可用 ${(free / 1024 ** 3).toFixed(1)} GB`)
    }
    for (const entry of missing) {
      const model = MODEL_MANIFEST.find((m) => m.key === entry.key)
      log(`开始下载 ${model.name}（${(model.bytes / 1024 ** 3).toFixed(2)} GB）`)
      const started = Date.now()
      try {
        const result = await downloadModel(model, {
          modelsDir: cfg.comfy.modelsDir,
          proxy: cfg.comfy.downloadProxy || null,
          signal,
          onProgress: (p) => {
            job.current = { model: model.key, name: model.name, ...p }
          },
        })
        job.current = null
        if (result.skipped) {
          log(`${model.name} 已存在，跳过`)
        } else {
          const secs = (Date.now() - started) / 1000
          log(`${model.name} 完成：${(result.bytes / 1024 ** 3).toFixed(2)} GB，用时 ${(secs / 60).toFixed(1)} 分钟，通道 ${result.transport}`)
          if (result.drift) log(`注意：与清单记录差 ${result.drift} 字节，上游可能更新过（已按实际长度接受）`)
          if (result.attempts.length) log(`重试 ${result.attempts.length} 次才成功`)
        }
      } catch (error) {
        job.errors.push(`${model.name}: ${error.message}`)
        log(`下载 ${model.name} 失败：${error.message}`)
        log('.part 已保留，重新调用 pbr_setup_install 会从断点续传')
        throw error
      }
    }
  }

  // 4 ── verify by actually loading the nodes
  step(3, STEPS[3])
  const remaining = inspectModels(cfg.comfy.modelsDir).filter((m) => !m.present)
  if (remaining.length > 0) {
    job.state = 'blocked'
    job.finishedAt = Date.now()
    job.result = { ok: false, reason: `还缺 ${remaining.length} 个权重`, missing: remaining.map((m) => m.key) }
    log('权重不全，跳过验证')
    return
  }
  let instance
  try {
    instance = await attachOrSpawn(cfg, { onLog: log })
    const client = new ComfyClient(instance)
    const nodes = {}
    for (const cls of ['PBRLabPBRSynth', 'PBRLabMakeSeamless', 'PBRLabSaveImage16']) {
      nodes[cls] = await client.hasNode(cls)
    }
    job.result = { ok: Object.values(nodes).every(Boolean), port: instance.port, attached: !!instance.attached, nodes }
    log(`实例 :${instance.port}${instance.attached ? '（复用了已运行的）' : '（本次自起）'}，节点 ${JSON.stringify(nodes)}`)
    if (!Object.values(nodes).every(Boolean)) {
      throw new Error('pbrlab 节点没有注册上——看上面 ensureRunRoot 的报错，通常是链接失败')
    }
  } finally {
    if (instance && instance.spawnedPid && options.keepInstance !== true) {
      await stopSpawned('setup verification finished')
      log('验证完毕，已关闭自起实例')
    }
  }

  job.state = 'done'
  job.finishedAt = Date.now()
  log('环境就绪')
}
