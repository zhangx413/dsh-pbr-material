/**
 * Find the local ComfyUI without asking the user, where that is possible.
 *
 * The authoritative sources are files Comfy Desktop writes itself, not guesses:
 *
 *   %APPDATA%\Comfy Desktop\comfy-procs\inst-<id>.json
 *       { "installPath": "D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI", "port": 8188, ... }
 *   %APPDATA%\Comfy Desktop\instance-model-paths\inst-<id>.yaml
 *       comfy.desktop_0:
 *         base_path: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models'
 *         is_default: true
 *
 * Everything is returned with the `source` it came from, because "found it" and
 * "guessed it" must not look the same in a status report.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, join } from 'node:path'

const isWin = (p) => p === 'win32'

function newestFile(dir, filter) {
  if (!existsSync(dir)) return null
  let best = null
  let bestTime = -1
  for (const name of readdirSync(dir)) {
    if (!filter(name)) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (st.mtimeMs > bestTime) {
        bestTime = st.mtimeMs
        best = full
      }
    } catch {}
  }
  return best
}

function safeJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Pull `base_path` out of the generated model-paths yaml, without a yaml dep.
 * Block-aware: `is_default` appears AFTER `base_path` inside each block, so a
 * flag collected while scanning lines would land on the wrong entry.
 */
export function parseModelPathsYaml(text) {
  const blocks = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const isBlockHeader = raw.length === raw.trimStart().length && /^[^\s:]+(\.[^\s:]+)*:\s*$/.test(raw)
    if (isBlockHeader) {
      current = { path: null, isDefault: false }
      blocks.push(current)
      continue
    }
    if (!current) {
      current = { path: null, isDefault: false }
      blocks.push(current)
    }
    const m = /^base_path:\s*['"]?(.+?)['"]?\s*$/.exec(line)
    if (m) current.path = m[1].replace(/\\\\/g, '\\')
    if (/^is_default:\s*true\b/i.test(line)) current.isDefault = true
  }
  return blocks.filter((b) => b.path)
}

function readComfyDesktop(appData) {
  const root = join(appData, 'Comfy Desktop')
  const result = { installRoot: null, port: null, models: [], sources: {} }

  const proc = newestFile(join(root, 'comfy-procs'), (n) => n.endsWith('.json'))
  if (proc) {
    const j = safeJson(proc)
    if (j && typeof j.installPath === 'string') {
      result.installRoot = j.installPath
      result.port = typeof j.port === 'number' ? j.port : null
      result.sources.installRoot = proc
      if (result.port) result.sources.port = proc
    }
  }

  const yamlFile = newestFile(join(root, 'instance-model-paths'), (n) => n.endsWith('.yaml') || n.endsWith('.yml'))
  if (yamlFile) {
    try {
      const found = parseModelPathsYaml(readFileSync(yamlFile, 'utf8'))
      result.models = found
      if (found.length) result.sources.models = yamlFile
    } catch {}
  }
  return result
}

/** The app root is the directory that actually holds main.py. */
function appRootFrom(installPath) {
  const candidates = [join(installPath, 'ComfyUI'), installPath]
  return candidates.find((c) => existsSync(join(c, 'main.py'))) ?? null
}

function pythonFrom(appRoot, installRoot, win) {
  const rel = win ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python']
  const relBundle = win ? ['standalone-env', 'python.exe'] : ['standalone-env', 'bin', 'python3']
  const candidates = []
  if (appRoot) candidates.push(join(appRoot, ...rel), join(appRoot, ...relBundle), join(dirname(appRoot), ...rel))
  if (installRoot) candidates.push(join(installRoot, ...rel), join(installRoot, ...relBundle))
  return candidates.find((c) => existsSync(c)) ?? null
}

/**
 * @returns {{
 *   appRoot: {value: string|null, source: string},
 *   installRoot: {value: string|null, source: string},
 *   modelsDir: {value: string|null, source: string},
 *   python: {value: string|null, source: string},
 *   portHint: number|null,
 *   problems: string[]
 * }}
 */
export function discoverComfy(options = {}) {
  const env = options.env ?? process.env
  const win = isWin(options.platform ?? osPlatform())
  const appData = options.appData ?? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const desktop = readComfyDesktop(appData)
  const problems = []

  // --- app root ---------------------------------------------------------
  let appRoot = null
  let appRootSource = 'not found'
  if (env.PBR_MATERIAL_COMFY_DIR) {
    const fromEnv = appRootFrom(env.PBR_MATERIAL_COMFY_DIR) ?? (existsSync(join(env.PBR_MATERIAL_COMFY_DIR, 'main.py')) ? env.PBR_MATERIAL_COMFY_DIR : null)
    if (fromEnv) {
      appRoot = fromEnv
      appRootSource = 'PBR_MATERIAL_COMFY_DIR'
    } else {
      problems.push(`PBR_MATERIAL_COMFY_DIR 指向的目录里没有 main.py: ${env.PBR_MATERIAL_COMFY_DIR}`)
    }
  }
  if (!appRoot && desktop.installRoot) {
    const fromDesktop = appRootFrom(desktop.installRoot)
    if (fromDesktop) {
      appRoot = fromDesktop
      appRootSource = `${desktop.sources.installRoot} (Comfy Desktop)`
    }
  }
  if (!appRoot) {
    // Last resort: the layouts people actually use, shallow, so it stays fast.
    const guesses = win
      ? [
        'C:\\ComfyUI', 'D:\\ComfyUI', 'C:\\Comfy-Desktop\\ComfyUI', 'D:\\Comfy-Desktop\\ComfyUI',
        join(homedir(), 'ComfyUI'), join(env.LOCALAPPDATA ?? '', 'Programs', 'ComfyUI'),
        join(env.USERPROFILE ?? '', 'Documents', 'ComfyUI'),
      ]
      : [join(homedir(), 'ComfyUI'), '/opt/ComfyUI', '/usr/local/ComfyUI']
    for (const g of guesses) {
      const hit = g && appRootFrom(g)
      if (hit) {
        appRoot = hit
        appRootSource = `common location (${g})`
        break
      }
    }
  }
  if (!appRoot) problems.push('没找到 ComfyUI（需要含 main.py 的目录）——装一个 ComfyUI 桌面版，或用 PBR_MATERIAL_COMFY_DIR 指路')

  const installRoot = appRoot ? dirname(appRoot) : desktop.installRoot ?? null

  // --- models library ---------------------------------------------------
  let modelsDir = null
  let modelsSource = 'not found'
  if (env.PBR_MATERIAL_MODELS_DIR && existsSync(env.PBR_MATERIAL_MODELS_DIR)) {
    modelsDir = env.PBR_MATERIAL_MODELS_DIR
    modelsSource = 'PBR_MATERIAL_MODELS_DIR'
  }
  if (!modelsDir && desktop.models.length) {
    const preferred = desktop.models.find((m) => m.isDefault) ?? desktop.models[0]
    modelsDir = preferred.path
    modelsSource = `${desktop.sources.models} (Comfy Desktop, is_default=${preferred.isDefault})`
  }
  if (!modelsDir) {
    for (const candidate of [
      installRoot && join(installRoot, '..', 'ComfyUI-Shared', 'models'),
      installRoot && join(installRoot, 'ComfyUI-Shared', 'models'),
      installRoot && join(installRoot, 'models'),
      appRoot && join(appRoot, 'models'),
    ]) {
      if (candidate && existsSync(candidate)) {
        modelsDir = candidate
        modelsSource = `sibling of the install (${candidate})`
        break
      }
    }
  }
  if (!modelsDir) problems.push('没找到模型库目录')
  if (modelsDir && !existsSync(modelsDir)) problems.push(`模型库目录不存在: ${modelsDir}`)

  // --- python -----------------------------------------------------------
  let python = null
  let pythonSource = 'not found'
  if (env.PBR_MATERIAL_PYTHON && existsSync(env.PBR_MATERIAL_PYTHON)) {
    python = env.PBR_MATERIAL_PYTHON
    pythonSource = 'PBR_MATERIAL_PYTHON'
  }
  if (!python) {
    const found = pythonFrom(appRoot, installRoot, win)
    if (found) {
      python = found
      pythonSource = 'inside the ComfyUI install'
    }
  }
  if (!python && appRoot) {
    // A ComfyUI install that was launched with a system interpreter still has
    // one on PATH; say so rather than leaving the field empty.
    python = win ? 'python.exe' : 'python3'
    pythonSource = 'PATH (no venv found next to ComfyUI)'
    problems.push('没找到 ComfyUI 自带的 venv，退回 PATH 上的 python——它必须装了 numpy 和 Pillow')
  }
  if (!python) problems.push('没找到 python')

  return {
    appRoot: { value: appRoot, source: appRootSource },
    installRoot: { value: installRoot, source: appRoot ? 'derived from the app root' : desktop.sources.installRoot ?? 'not found' },
    modelsDir: { value: modelsDir, source: modelsSource },
    python: { value: python, source: pythonSource },
    portHint: desktop.port,
    problems,
  }
}

/** Where the plugin keeps its own working data (run root, staging, caches). */
export function defaultDataDir(env = process.env) {
  const base = env.LOCALAPPDATA ?? env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(base, 'dsh-pbr-material')
}
