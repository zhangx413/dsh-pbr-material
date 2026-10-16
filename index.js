/**
 * dsh-pbr-material — host half.
 *
 * Registers three tools and the skill that carries the measured judgement.
 * Deliberately dependency-free: it may be loaded by absolute path (the
 * `insert:` form in a profile patch), where a bare `@deepseek-ai/schemastery`
 * import cannot resolve. Config therefore comes from defaults + config.json +
 * the patch row, and the Config schema is exported only when schemastery does
 * happen to resolve.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_FILE, describeConfig, loadConfig, PLUGIN_DIR } from './lib/config.js'
import { stopSpawned } from './lib/comfy.js'
import { makeTools } from './lib/tools.js'
import { registerWebUI } from './lib/webui.js'

export const name = 'dsh-pbr-material'

export const inject = ['tools']

let Schema
try {
  // Optional: present when installed as a bundle into a profile.
  Schema = (await import('@deepseek-ai/schemastery')).default
} catch {
  Schema = undefined
}

export const Config = Schema
  ? Schema.object({
      enabled: Schema.boolean().default(true).description('Load the tools and skill.'),
      configFile: Schema.string().default(CONFIG_FILE).description('JSON file merged over the built-in defaults.'),
      colorMatchMode: Schema.string().default('hue').description('hue | reinhard | off'),
      outputDir: Schema.string().default('').description('Where material sets land; empty = session cwd.'),
    })
  : undefined

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { data: {}, body: source }
  const data = {}
  let current = null
  for (const raw of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw)
    if (kv) {
      current = kv[1]
      data[current] = kv[2].trim()
    } else if (current && raw.trim()) {
      data[current] += ` ${raw.trim()}`
    }
  }
  return { data, body: source.slice(match[0].length) }
}

function skillDefinition() {
  const file = join(PLUGIN_DIR, 'skill', 'SKILL.md')
  const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
  return {
    name: data.name ?? 'pbr-material-from-photo',
    description: data.description ?? 'Photo -> tileable PBR material set.',
    whenToUse:
      'The user wants a PBR/texture material from a photo, asks for game-ready maps, or reports that a ' +
      'generated material is not flat / not seamless / not faithful.',
    content: body.trim(),
    source: 'bundled',
    resourceBase: { kind: 'directory', path: join(PLUGIN_DIR, 'skill') },
  }
}

/**
 * Registered into the system prompt so a fresh install knows the plugin needs an
 * environment — and that the agent is allowed to deploy it itself. Static text
 * on purpose: live readiness is one `pbr_setup_status` call away, and a section
 * re-registered on every change would thrash the prompt cache.
 */
const SETUP_GUIDE = `## PBR 材质插件（dsh-pbr-material）

它把照片变成可平铺的 PBR 贴图集。跑起来需要这台机器上有：ComfyUI、三个权重（共约 12.5 GB）、
以及 pbrlab 节点包（**节点包已经在插件里**，其余需要装一次）。

- **先看环境**：\`pbr_setup_status\`。它会报每个路径是从哪发现的（ComfyUI 桌面版自己写的配置 /
  环境变量 / 常见位置）、缺哪些权重、磁盘够不够。
- **缺就直接部署**：\`pbr_setup_install\`。它在**后台**跑并立刻返回任务号，用 \`pbr_setup_status\`
  的 \`installJob\` 字段看进度。幂等且可续传，重跑不会从零开始。
- **别默默开始一个几小时的下载**：下 12.5 GB 之前先 \`pbr_setup_status(probe_speed=true)\` 测实际速度，
  把预计耗时告诉用户，等他同意。慢的时候可能十几小时。
- 机器上没有 ComfyUI：让用户装一个 ComfyUI 桌面版（最省事），或用 \`config.json\` 的
  \`comfy.installDir\` 指到含 \`main.py\` 的目录。
- 权重来自 HuggingFace / hf-mirror，两个来源各有各的许可，**商用前让用户自己确认**。
- 这个插件默认不占用用户的 ComfyUI：它用自己独立的 run root 和端口跑，自起自停。`

export function apply(ctx, config = {}) {
  const cfg = loadConfig(config)
  if (config.enabled === false) {
    ctx.logger?.info?.('[dsh-pbr-material] disabled by config')
    return
  }

  const tools = makeTools(cfg)
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  ctx.logger?.info?.(
    `[dsh-pbr-material] ${tools.length} tools registered (${tools.map((t) => t.name).join(', ')})`,
  )

  // The skill travels with the plugin so its paths/config stay in one place.
  ctx.inject?.(['skills'], (skillsCtx) => {
    try {
      skillsCtx.effect(() => skillsCtx.skills.register(skillDefinition()))
      ctx.logger?.info?.('[dsh-pbr-material] skill "pbr-material-from-photo" registered')
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-pbr-material] skill registration failed: ${error.message}`)
    }
  })

  // The browser half: main panel + sidebar icon, plus the REST routes it uses.
  // Config is re-read per request so editing config.json does not need a restart.
  registerWebUI(ctx, () => loadConfig(config))

  // A fresh install knows nothing about ComfyUI. This tells the agent the plugin
  // needs an environment, and that it may deploy it itself.
  ctx.inject?.(['systemPrompt'], (promptCtx) => {
    try {
      promptCtx.effect(() =>
        promptCtx.systemPrompt.section({ name: 'dsh-pbr-material:setup', order: 132, text: SETUP_GUIDE }),
      )
      ctx.logger?.info?.('[dsh-pbr-material] setup guide registered into the system prompt')
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-pbr-material] setup guide registration failed: ${error.message}`)
    }
  })

  // Never leave a headless ComfyUI holding ~5 GB of weights after an unload.
  ctx.effect(() => () => {
    void stopSpawned('plugin unloaded')
  })

  ctx.logger?.info?.(`[dsh-pbr-material] config: ${JSON.stringify(describeConfig(cfg))}`)
}
