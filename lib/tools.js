/**
 * The three model-facing tools.
 *
 * Descriptions are the interface: they carry the parts of the skill's measured
 * judgement that must reach the model at call time (what `material` has to
 * contain, and the reference-resolution limit that no amount of retrying fixes).
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { checkMaps, materialFromPhoto, status } from './pipeline.js'
import { setupStatus, startSetup } from './setup.js'

const text = (t) => [{ type: 'text', text: t }]

function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function abs(p, exec) {
  if (!p) return p
  return isAbsolute(p) ? p : resolve(cwdOf(exec), p)
}

/**
 * PBRLabTileValidator's pass rule is `!hard_seam && (ratio <= 1.4 || wrap <= 0.02)`.
 * `wrap_max` is a single-pixel extreme and is documented as a blunt veto only —
 * so distinguish "the veto fired while the primary criterion passed" from a real
 * seam, instead of reporting both as FAIL.
 */
function verdictOf(m) {
  if (m.pass) return 'PASS'
  const primaryOk = m.wrap_ratio <= 1.4 || m.wrap <= 0.02
  if (m.hard_seam && primaryOk) return 'FAIL(veto only)'
  return 'FAIL'
}

function fmtMap(m) {
  const bits = m.file_bits ? `${m.file_bits}-bit` : ''
  const size = m.size ? `${m.size[0]}x${m.size[1]}` : ''
  return `  ${String(m.key ?? m.name).padEnd(10)} ${String(m.name).padEnd(24)} ${size.padEnd(11)} ${bits.padEnd(7)} wrap=${String(m.wrap).padEnd(9)} ratio=${String(m.wrap_ratio).padEnd(8)} ${verdictOf(m)}`
}

function vetoOnlyNote(maps) {
  const only = (maps ?? []).filter((m) => verdictOf(m) === 'FAIL(veto only)')
  if (only.length === 0) return null
  return (
    `${only.map((m) => m.key ?? m.name).join(', ')}: 主判据通过（wrap <= 0.02），只有单像素否决线 ` +
    `wrap_max 触发。wrap_max 是全图极值，pbrlab 自己的注释就写着它"只做粗暴否决、不能当通过标准"——` +
    '高频法线图上它经常打空枪。以 3x3 预览为准。'
  )
}

/**
 * The veto verdict is not stable: the same input and the same seed produced
 * wrap_max 0.5025 (FAIL) and 0.3424 (PASS) on two runs, because ComfyUI's async
 * weight offloading does not pin the reduction order. Say so rather than
 * letting one number look authoritative.
 */
function unstableNote(maps) {
  const near = (maps ?? []).filter((m) => m.wrap_max > 0.32 && m.wrap_max <= 0.5)
  if (near.length === 0) return null
  return (
    `${near.map((m) => m.key ?? m.name).join(', ')} 的 wrap_max 贴着否决线：同一份输入、同一个 seed ` +
    '重跑，GPU 的非确定性会让它在两侧跳（实测 0.50 / 0.34）。这一档不是稳定判据，以 3×3 预览为准。'
  )
}

export function makeTools(cfg) {
  const byName = (dir, normal) => ({
    type: 'object',
    properties: {
      dir: { type: 'string' },
      normal: { type: ['string', 'null'] },
      maps: { type: 'array' },
      normal_metrics: { type: ['object', 'null'] },
      all_tile_pass: { type: 'boolean' },
    },
  })

  const statusTool = {
    name: 'pbr_comfy_status',
    description:
      'Check whether this machine can produce PBR materials right now: ComfyUI install + python, the ' +
      'three FLUX.2 Klein model files, the pbrlab node pack, the headless run root, free VRAM, and any ' +
      'ComfyUI instance already running. Call this before pbr_material_from_photo when anything is ' +
      'uncertain, and after a failure to see what is missing.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const v = value
        const lines = ['ComfyUI 环境状态', '']
        lines.push(`install  : ${v.comfy.installFound ? 'ok' : 'MISSING'}  ${v.comfy.installDir}`)
        lines.push(`python   : ${v.comfy.pythonFound ? 'ok' : 'MISSING'}  ${v.comfy.python}`)
        lines.push(`run root : ${v.runRoot.path}${v.runRoot.repairs.length ? `  (repaired: ${v.runRoot.repairs.join('; ')})` : ''}`)
        lines.push('')
        for (const [k, m] of Object.entries(v.models)) {
          lines.push(`model ${k.padEnd(12)} ${m.found ? 'ok' : 'MISSING'}  ${m.file}`)
        }
        lines.push('')
        lines.push(`instance : ${v.attached ? `attached on port ${v.attached.port}` : 'none running'}` +
          (v.spawned ? `  (plugin-owned pid ${v.spawned.pid}, alive=${v.spawned.alive})` : ''))
        if (v.attachedNodes) {
          for (const [k, ok] of Object.entries(v.attachedNodes)) lines.push(`node ${k.padEnd(22)} ${ok ? 'ok' : 'MISSING'}`)
        }
        lines.push(`free VRAM: ${v.gpuFreeMiB === null ? 'unknown (nvidia-smi unavailable)' : `${v.gpuFreeMiB} MiB`}`)
        lines.push(`colour match default: ${v.colorMatch.mode} (strength ${v.colorMatch.strength})`)
        lines.push('')
        lines.push(v.note)
        return text(lines.join('\n'))
      },
    },
    async execute() {
      return status(cfg)
    },
    presentCall: () => ({ card: 'generic', title: 'pbr: 环境自检', kind: 'read' }),
    isConcurrencySafe: () => true,
  }

  const generateTool = {
    name: 'pbr_material_from_photo',
    description:
      'Turn a photo of an object or surface into a complete tileable PBR material set ' +
      '(albedo, normal, height, roughness, AO, curvature, metallic; 16-bit PNG for the data maps). ' +
      'Runs fully locally through ComfyUI: FLUX.2 Klein 4B does an instruction edit that removes ' +
      'object structure and perspective, then deterministic pixel maths tiles it and derives the maps. ' +
      'Takes minutes on the first call (weights load).\n' +
      '`material` must describe the SURFACE, in English: colour + substrate + what the wear looks like, ' +
      'e.g. "heavily worn pale yellow-cream paint on metal, large flakes chipped off revealing dark ' +
      'brown bare metal, fine scratches, dust, matte aged finish". A vague `material` produces a ' +
      'generic AI texture.\n' +
      'Hard limit, tell the user rather than retrying: output fidelity is capped by the reference\'s ' +
      'usable flat area. Keep output/source_side <= ~1.6. If the flat surface in the photo occupies ' +
      'only ~100-200 px, or a big embossed feature (ridge, label, frame) crosses it, ask for a closer ' +
      'photo of a flat area instead of shipping something that looks like a different material.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['image_path', 'material'],
      properties: {
        image_path: { type: 'string', description: 'Reference photo. Absolute, or relative to the session working directory.' },
        material: {
          type: 'string',
          description:
            'English description of the material identity: colour, substrate, and the wear (chips, ' +
            'scratches, dust, finish). This is the single most important parameter.',
        },
        name: { type: 'string', description: 'Job slug for the output folder (default: derived from the image name + timestamp).' },
        out_dir: { type: 'string', description: 'Output directory. Default: config outputDir, else <cwd>/pbr-materials/<job>.' },
        size: { type: 'integer', description: 'Square output resolution in px (default 1024; use 768 for a first smoke test).' },
        steps: { type: 'integer', description: 'Sampler steps (default 20).' },
        cfg: { type: 'number', description: 'CFG scale (default 5.0).' },
        seed: { type: 'integer', description: 'Fixed seed for reproducibility; 0 or omitted = random.' },
        color_match: {
          type: 'string',
          enum: ['hue', 'reinhard', 'off'],
          description:
            'hue (default) = saturation-gated transfer, leaves neutral pixels alone — the measured-correct ' +
            'one. reinhard = in-graph per-channel match, tints neutrals. off = keep the generated palette.',
        },
        color_strength: { type: 'number', description: 'Colour-match strength (default 0.6; 1.0 overshoots).' },
        metallic: { type: 'number', description: '0..1, broadcast. Cannot be inferred from a 2D image — you pick it.' },
        base_roughness: { type: 'number', description: '0..1 roughness centre (default 0.55).' },
        force_spawn: { type: 'boolean', description: 'Start a plugin-owned headless ComfyUI even if another instance is running (usually a bad idea on 16 GB).' },
        keep_instance: { type: 'boolean', description: 'Leave a plugin-spawned ComfyUI running after the job (keeps ~5 GB of weights in VRAM).' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const v = value
        const lines = []
        lines.push(`PBR 材质集: ${v.job}`)
        lines.push(`输出目录: ${v.outDir}`)
        lines.push(
          `参数: ${v.size}px, ${v.steps} steps, cfg ${v.cfgScale}, seed ${v.seed}` +
            (v.instance.attached ? ` | 复用了端口 ${v.instance.port} 上的实例` : ` | 自建 headless 实例 pid ${v.instance.pid}`),
        )
        const cm = v.colorMatch
        lines.push(
          `调色: ${cm.mode}` +
            (cm.applied === false ? ' (跳过)' : '') +
            (cm.reference_paint_pixels !== undefined ? ` | 参考图命中漆色像素 ${cm.reference_paint_pixels}` : '') +
            (cm.target_rgb ? ` | 目标漆色 rgb ${cm.target_rgb.join(', ')}` : ''),
        )
        lines.push('')
        lines.push('贴图:')
        for (const [k, p] of Object.entries(v.maps)) lines.push(`  ${k.padEnd(10)} ${p}`)
        if (v.metrics?.maps?.length) {
          lines.push('')
          lines.push('平铺量测（wrap_ratio < 1.4 且 wrap_max <= 0.5 才算过）:')
          for (const m of v.metrics.maps) lines.push(fmtMap(m))
          if (v.metrics.normal) {
            lines.push(
              `  法线 |n| 均值 ${v.metrics.normal.mean_length}, unit_frac ${v.metrics.normal.unit_frac}, ` +
                `min Z ${v.metrics.normal.min_z} -> ${v.metrics.normal.pass ? 'PASS' : 'FAIL'}`,
            )
          }          lines.push('')
          lines.push(
            `整体: 平铺 ${v.metrics.all_tile_pass ? 'PASS' : 'FAIL'}, 法线 ${v.metrics.all_normal_pass ? 'PASS' : 'FAIL'}`,
          )
          const veto = vetoOnlyNote(v.metrics.maps)
          if (veto) lines.push(`说明: ${veto}`)
          const unstable = unstableNote(v.metrics.maps)
          if (unstable) lines.push(`说明: ${unstable}`)
          lines.push(
            '注意：wrap_ratio 通过只说明边界与内部统计上无差别，不代表没有 MakeSeamless 留下的镜像花纹 —— 看 3x3 预览图。',
          )
          if (v.metrics.previews?.length) for (const p of v.metrics.previews) lines.push(`  预览 ${p}`)
        } else {
          lines.push('')
          lines.push('（未取得量测结果）')
        }
        if (v.notes?.length) {
          lines.push('')
          lines.push(`备注: ${v.notes.join(' | ')}`)
        }
        lines.push('')
        lines.push(`耗时: 编辑 ${(v.timings.editMs / 1000).toFixed(1)}s, PBR ${(v.timings.pbrMs / 1000).toFixed(1)}s, 合计 ${(v.timings.totalMs / 1000).toFixed(1)}s`)
        lines.push('—— 看一眼输出图再下结论。数字好看不等于图好看（"结构保持 0.91"那次，模型把所有碎屑重排成了矩形轮廓）。')
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const a = args ?? {}
      return materialFromPhoto(
        cfg,
        {
          imagePath: abs(a.image_path, exec),
          material: a.material,
          name: a.name,
          outDir: a.out_dir ? abs(a.out_dir, exec) : a.out_dir,
          size: a.size,
          steps: a.steps,
          cfg: a.cfg,
          seed: a.seed,
          metallic: a.metallic,
          colorMatch: {
            ...(a.color_match ? { mode: a.color_match } : {}),
            ...(a.color_strength !== undefined ? { strength: a.color_strength } : {}),
          },
          pbr: {
            ...(a.metallic !== undefined ? { metallic: a.metallic } : {}),
            ...(a.base_roughness !== undefined ? { baseRoughness: a.base_roughness } : {}),
          },
          forceSpawn: a.force_spawn === true,
          keepInstance: a.keep_instance === true,
        },
        {
          log: (m) => exec?.logger?.info?.(`[pbr] ${m}`),
        },
      )
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `pbr: ${args?.name ?? 'material'} ← ${args?.image_path ?? ''}`.slice(0, 120),
      kind: 'execute',
    }),
    isConcurrencySafe: () => false,
    timeoutMs: 45 * 60 * 1000,
  }

  const checkTool = {
    name: 'pbr_check_maps',
    description:
      'Measure whether an existing PBR map set tiles: per-file wrap / wrap_ratio / wrap_max against the ' +
      'calibrated threshold, plus normal-map validity (|n|, min Z), and write 3x3 tiling previews. ' +
      'Use it on any map set, however it was produced. Threshold: wrap_ratio < 1.4 and wrap_max <= 0.5.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['dir'],
      properties: {
        dir: { type: 'string', description: 'Directory holding albedo.png / normal.png / ...' },
        normal: { type: 'string', description: 'Explicit normal map path if the filename does not contain "normal".' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const v = value
        const lines = [`平铺量测: ${v.dir}`, '']
        for (const m of v.maps ?? []) lines.push(fmtMap(m))
        if (v.normal) {
          lines.push('')
          lines.push(
            `法线 ${v.normal.file}: |n|=${v.normal.mean_length} unit_frac=${v.normal.unit_frac} ` +
              `minZ=${v.normal.min_z} -> ${v.normal.pass ? 'PASS' : 'FAIL'}`,
          )
        }
        lines.push('')
        lines.push(`整体: 平铺 ${v.all_tile_pass ? 'PASS' : 'FAIL'}, 法线 ${v.all_normal_pass ? 'PASS' : 'FAIL'}`)
        const veto = vetoOnlyNote(v.maps)
        if (veto) lines.push(`说明: ${veto}`)
        const unstable = unstableNote(v.maps)
        if (unstable) lines.push(`说明: ${unstable}`)
        for (const p of v.previews ?? []) lines.push(`预览 ${p}`)
        if (v.comfy_note) lines.push(`注意: ${v.comfy_note}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args, exec) {
      const a = args ?? {}
      const result = await checkMaps(cfg, {
        dir: abs(a.dir, exec),
        normal: a.normal ? abs(a.normal, exec) : undefined,
      })
      return {
        dir: result.dir,
        maps: result.maps,
        normal: result.normal,
        normal_metrics: result.normal,
        previews: result.previews,
        all_tile_pass: result.all_tile_pass,
        all_normal_pass: result.all_normal_pass,
        comfy_note: result.comfy_note,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `pbr: 量测 ${args?.dir ?? ''}`.slice(0, 100), kind: 'read' }),
    isConcurrencySafe: () => true,
  }

  const setupStatusTool = {
    name: 'pbr_setup_status',
    description:
      'Is this machine ready to make PBR materials? Reports what auto-discovery found (ComfyUI install, ' +
      'model library, python) AND where each path came from, which of the three model weights are ' +
      'present/missing with sizes, whether the bundled node pack is linked, free disk space, and any ' +
      'already-running ComfyUI. Call this first on a fresh install, and after any failure.\n' +
      'Pass probe_speed=true to also download a few MB and project how long the missing weights would ' +
      'take — worth doing before recommending a ~12.5 GB download on a slow link.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe_speed: { type: 'boolean', description: 'Measure real throughput (~4 MB of traffic) and project the download time.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const v = value
        const lines = []
        lines.push(v.ready ? '环境：就绪 ✅' : '环境：不完整 ❌')
        lines.push('')
        lines.push(`ComfyUI   ${v.comfy.mainPyFound ? 'ok' : '缺失'}  ${v.comfy.installDir || '(未发现)'}`)
        lines.push(`          来源：${v.discovery.appRoot.source}`)
        lines.push(`python    ${v.python.ok ? 'ok' : '不可用'}  ${v.python.path || '(未发现)'}`)
        lines.push(`          来源：${v.discovery.python.source}${v.python.ok ? ` · ${v.python.version ?? ''} numpy ${v.python.numpy} Pillow ${v.python.pillow}` : ` · ${v.python.error ?? ''}`}`)
        lines.push(`模型库    ${v.models.dirExists ? 'ok' : '缺失'}  ${v.models.dir || '(未发现)'}`)
        lines.push(`          来源：${v.discovery.modelsDir.source}`)
        lines.push(`run root  ${v.runRoot.path}`)
        lines.push(`节点包    ${v.nodePack.bundled ? '插件自带' : '缺失'} · ${v.nodePack.linked ? '已链入 run root' : '未链入'}`)
        lines.push('')
        for (const m of v.models.entries) {
          const size = `${(m.expectedBytes / 1024 ** 3).toFixed(2)} GB`
          lines.push(`权重 ${m.key.padEnd(12)} ${m.present ? (m.complete ? 'ok' : `大小不符(${m.bytes})`) : '缺失'}  ${size}  ${m.name}`)
        }
        if (v.models.missing.length > 0) {
          lines.push(`  待下载合计 ${(v.models.missingBytes / 1024 ** 3).toFixed(2)} GB`)
        }
        lines.push('')
        lines.push(`磁盘可用  ${v.disk.freeBytes === null ? '未知' : `${(v.disk.freeBytes / 1024 ** 3).toFixed(1)} GB`}`)
        lines.push(`下载通道  ${v.downloadTransport.proxy}`)
        lines.push(`实例      ${v.instance.attached ? `已接入 :${v.instance.port}` : '未运行（生成/验证时自起）'}`)
        if (v.throughput) {
          const mb = v.throughput.bytesPerSecond / 1024 ** 2
          lines.push(
            `实测速度  ${mb.toFixed(2)} MB/s（${v.throughput.transport}，${v.throughput.url.split('/')[2]}）` +
              ` → 全部权重约 ${(v.throughput.projectedSecondsForAll / 3600).toFixed(1)} 小时`,
          )
        }
        if (v.discovery.problems.length) {
          lines.push('')
          lines.push('发现过程的问题：')
          for (const p of v.discovery.problems) lines.push(`  · ${p}`)
        }
        if (v.installJob) {
          lines.push('')
          lines.push(`部署任务 ${v.installJob.id}：${v.installJob.state} · ${v.installJob.step}（${v.installJob.stepIndex + 1}/${v.installJob.stepCount}）`)
          if (v.installJob.current) {
            const c = v.installJob.current
            lines.push(`  正在下 ${c.name}：${(c.received / 1024 ** 3).toFixed(2)}/${(c.total / 1024 ** 3).toFixed(2)} GB` +
              (c.percent ? `（${c.percent.toFixed(1)}%）` : '') +
              (c.bytesPerSecond ? ` ${(c.bytesPerSecond / 1024 ** 2).toFixed(2)} MB/s` : '') +
              (c.etaMs ? ` 预计还需 ${(c.etaMs / 60000).toFixed(0)} 分钟` : ''))
          }
        }
        if (v.nextSteps.length) {
          lines.push('')
          lines.push('下一步：')
          for (const s of v.nextSteps) lines.push(`  · ${s}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      return setupStatus(cfg, { throughput: args?.probe_speed === true })
    },
    presentCall: () => ({ card: 'generic', title: 'pbr: 部署自检', kind: 'read' }),
    isConcurrencySafe: () => true,
  }

  const setupInstallTool = {
    name: 'pbr_setup_install',
    description:
      'Deploy everything this plugin needs, on this machine, without the user editing files: verify ' +
      'ComfyUI + python, create the plugin\'s own run root, link the bundled pbrlab node pack into it, ' +
      'download the missing model weights (~12.5 GB total, resumable), then verify by actually loading ' +
      'the nodes in a real ComfyUI instance.\n' +
      'Runs in the BACKGROUND and returns a job id immediately — a 12.5 GB download must not block a ' +
      'tool call. Poll it with pbr_setup_status (its installJob field shows step, bytes, speed and ETA). ' +
      'Idempotent: re-running continues `.part` files instead of restarting, and skips whatever is already ' +
      'correct. Use include_models=false to only fix the run root / node pack / verification.\n' +
      'Do NOT start this without the user knowing: it can take hours on a slow link. Report the projected ' +
      'time from pbr_setup_status(probe_speed=true) first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_models: { type: 'boolean', description: 'Download missing weights (default true). Set false to only prepare the run root and verify.' },
        keep_instance: { type: 'boolean', description: 'Leave the verification instance running afterwards.' },
        proxy: { type: 'string', description: 'Override the download proxy for this run, e.g. http://127.0.0.1:7897. Empty = direct only.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const v = value
        const lines = [
          `部署任务已启动：${v.id}`,
          `步骤 ${v.stepIndex + 1}/${v.stepCount} · ${v.step}`,
          '',
          '它在后台跑，不阻塞对话。用 pbr_setup_status 看进度（installJob 字段有已下字节、速度和预计时间）。',
        ]
        if (v.state !== 'running') lines.push(`当前状态：${v.state}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const a = args ?? {}
      const effective = a.proxy !== undefined
        ? { ...cfg, comfy: { ...cfg.comfy, downloadProxy: String(a.proxy) } }
        : cfg
      return startSetup(effective, {
        includeModels: a.include_models !== false,
        keepInstance: a.keep_instance === true,
      })
    },
    presentCall: () => ({ card: 'generic', title: 'pbr: 部署环境', kind: 'execute' }),
    isConcurrencySafe: () => false,
  }

  void byName
  return [setupStatusTool, setupInstallTool, statusTool, generateTool, checkTool]
}

export function ensurePath(p) {
  return existsSync(p)
}
