/**
 * The weights this plugin needs, and a resumable downloader for them.
 *
 * Every URL below was read out of ComfyUI's OWN blueprint
 * (`blueprints/Image Edit (Flux.2 Klein 4B).json`, node `properties.models`),
 * not from memory. Project rule: a URL nobody requested is a URL that 404s.
 * All three were then probed: 302 -> CDN -> 200, not gated, no HF token needed.
 *
 * Two things learned the hard way:
 *  - hf-mirror.com works where huggingface.co does not (and vice versa on other
 *    days), so each file lists both and the downloader rotates.
 *  - the upstream VAE is 2264 bytes LARGER than the copy on this machine, so the
 *    recorded size is a sanity check that may legitimately drift. It warns; it
 *    never rejects a file that arrived complete.
 */
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statfsSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { openStream, probeTransport } from './fetch-util.js'

export const MODEL_MANIFEST = [
  {
    key: 'unet',
    name: 'flux-2-klein-base-4b-fp8.safetensors',
    directory: 'diffusion_models',
    bytes: 4_089_498_488,
    urls: [
      'https://hf-mirror.com/black-forest-labs/FLUX.2-klein-base-4b-fp8/resolve/main/flux-2-klein-base-4b-fp8.safetensors',
      'https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4b-fp8/resolve/main/flux-2-klein-base-4b-fp8.safetensors',
    ],
    note: 'FLUX.2 Klein 4B fp8 — the only model that generates. Check its licence before commercial use.',
  },
  {
    key: 'textEncoder',
    name: 'qwen_3_4b.safetensors',
    directory: 'text_encoders',
    bytes: 8_044_982_048,
    urls: [
      'https://hf-mirror.com/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
      'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
    ],
    note: 'Qwen3-4B text encoder. Bigger than the unet, and mandatory: the instructions are read here.',
  },
  {
    key: 'vae',
    name: 'flux2-vae.safetensors',
    directory: 'vae',
    bytes: 336_213_556,
    urls: [
      'https://hf-mirror.com/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
      'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
    ],
    note: 'VAE. The copy measured here is 2264 bytes smaller than upstream — the file was revised.',
  },
]

export function modelPath(modelsDir, model) {
  return join(modelsDir, model.directory, model.name)
}

export function inspectModels(modelsDir) {
  return MODEL_MANIFEST.map((model) => {
    const path = modelPath(modelsDir, model)
    let present = false
    let bytes = 0
    try {
      const st = statSync(path)
      present = st.isFile()
      bytes = st.size
    } catch {}
    return {
      key: model.key,
      name: model.name,
      directory: model.directory,
      path,
      present,
      bytes,
      expectedBytes: model.bytes,
      complete: present && bytes === model.bytes,
      // A size that differs is worth reporting, never silently accepted.
      sizeMismatch: present && bytes !== model.bytes,
    }
  })
}

export function freeBytes(path) {
  try {
    let probe = path
    while (probe && !existsSync(probe)) probe = dirname(probe)
    const fs = statfsSync(probe)
    return Number(fs.bavail) * Number(fs.bsize)
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** A real abort must be distinguishable from a socket that died saying "aborted". */
function abortError() {
  return Object.assign(new Error('download aborted'), { aborted: true })
}

/**
 * Fetch one file, resuming from a `.part` and rotating transports on failure.
 *
 * @returns {Promise<{path:string, bytes:number, skipped:boolean, attempts:Array, drift:number|null, transport:string}>}
 */
export async function downloadModel(model, options = {}) {
  const {
    modelsDir,
    proxy = null,
    onProgress = () => {},
    signal,
    maxAttempts = 8,
    prefer = 'direct',
    retryDelayMs = 4000,
  } = options
  if (!modelsDir) throw new Error('downloadModel: modelsDir is required')

  const target = modelPath(modelsDir, model)
  mkdirSync(dirname(target), { recursive: true })
  const part = `${target}.part`
  const attempts = []

  if (existsSync(target)) {
    const size = statSync(target).size
    if (size === model.bytes) {
      return { path: target, bytes: size, skipped: true, attempts, drift: null, transport: 'existing' }
    }
    // Present but a different size: keep it, say so, and do not overwrite a
    // possibly-good file with a download the user did not ask for.
    return {
      path: target,
      bytes: size,
      skipped: true,
      attempts,
      drift: size - model.bytes,
      transport: 'existing',
    }
  }

  const candidates = []
  for (const url of model.urls) for (const transport of prefer === 'proxy' ? ['proxy', 'direct'] : ['direct', 'proxy']) {
    if (transport === 'proxy' && !proxy) continue
    candidates.push({ url, transport })
  }

  let lastError = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortError()
    const candidate = candidates[attempt % candidates.length]
    const offset = existsSync(part) ? statSync(part).size : 0
    const started = Date.now()
    let received = 0
    let fd = null
    try {
      const headers = offset > 0 ? { range: `bytes=${offset}-` } : {}
      const { status, headers: resHeaders, stream } = await openStream(candidate.url, {
        headers,
        proxy,
        transport: candidate.transport,
        timeoutMs: 30000,
      })
      if (status === 416) {
        // The part is at least as long as the file: it is finished or corrupt.
        stream.resume()
        if (offset === model.bytes) {
          renameSync(part, target)
          return { path: target, bytes: offset, skipped: false, attempts, drift: null, transport: candidate.transport }
        }
        unlinkSync(part)
        throw new Error(`range 416 且已下长度 ${offset} ≠ 期望 ${model.bytes}，已丢弃 .part 重来`)
      }
      if (status !== 200 && status !== 206) {
        stream.resume()
        throw new Error(`HTTP ${status}`)
      }
      const length = Number(resHeaders['content-length'] ?? 0)
      const total = status === 206 && offset > 0 ? offset + length : length || model.bytes
      fd = openSync(part, 'a')
      let lastTick = Date.now()
      let lastBytes = 0
      for await (const chunk of stream) {
        if (signal?.aborted) throw abortError()
        writeSync(fd, chunk)
        received += chunk.length
        const now = Date.now()
        if (now - lastTick > 1500) {
          const rate = ((received - lastBytes) * 1000) / (now - lastTick)
          onProgress({
            url: candidate.url,
            transport: candidate.transport,
            received: offset + received,
            total,
            percent: total ? ((offset + received) / total) * 100 : null,
            bytesPerSecond: rate,
            etaMs: rate > 0 && total ? ((total - offset - received) / rate) * 1000 : null,
          })
          lastTick = now
          lastBytes = received
        }
      }
      closeSync(fd)
      fd = null

      const finalSize = existsSync(part) ? statSync(part).size : 0
      const expected = length > 0 && status === 206 ? offset + length : length
      if (expected > 0 && finalSize < expected) {
        throw new Error(`提前结束：${finalSize} < ${expected}（已保留 .part，下次续传）`)
      }
      renameSync(part, target)
      const drift = finalSize - model.bytes
      return {
        path: target,
        bytes: finalSize,
        skipped: false,
        attempts,
        drift: drift === 0 ? null : drift,
        transport: candidate.transport,
      }
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {}
      }
      lastError = error
      attempts.push({
        url: candidate.url,
        transport: candidate.transport,
        error: String(error?.message ?? error),
        offset,
        received,
        ms: Date.now() - started,
      })
      // Only a real cancellation stops the loop. A socket that dies mid-stream
      // also reports "aborted", and retrying THAT is the entire point of the
      // loop — treating the two the same threw away 12.5 GB of progress.
      if (error?.aborted === true || signal?.aborted) throw abortError()
      await sleep(retryDelayMs)
    }
  }
  const detail = attempts
    .slice(-3)
    .map((a) => `${a.transport} ${a.url.split('/')[2]} → ${a.error}`)
    .join('\n')
  throw new Error(
    `下载失败（试了 ${attempts.length} 次，.part 已保留可续传）：${lastError?.message}\n最近几次：\n${detail}`,
  )
}

/**
 * Measure the reachable transport and throughput before committing to ~12.5 GB.
 * Downloads at most `sampleBytes`, so this is safe to call from a status check.
 */
export async function measureThroughput(model, { proxy = null, sampleBytes = 4_000_000, timeoutMs = 30000 } = {}) {
  for (const url of model.urls) {
    const probe = await probeTransport(url, { proxy, timeoutMs: 12000 })
    if (!probe.transport) continue
    try {
      const started = Date.now()
      const { status, stream } = await openStream(url, {
        headers: { range: `bytes=0-${sampleBytes - 1}` },
        proxy,
        transport: probe.transport,
        timeoutMs,
      })
      if (status !== 206 && status !== 200) {
        stream.resume()
        continue
      }
      let got = 0
      for await (const chunk of stream) {
        got += chunk.length
        if (got >= sampleBytes) break
        if (Date.now() - started > timeoutMs) break
      }
      stream.destroy()
      const seconds = (Date.now() - started) / 1000
      if (got > 0 && seconds > 0) {
        return {
          url,
          transport: probe.transport,
          bytesPerSecond: got / seconds,
          sampleBytes: got,
          seconds,
          projectedSecondsForAll: Math.round((MODEL_MANIFEST.reduce((n, m) => n + m.bytes, 0) / (got / seconds))),
        }
      }
    } catch {}
  }
  return null
}
