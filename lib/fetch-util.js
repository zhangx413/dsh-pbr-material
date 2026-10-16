/**
 * HTTP(S) with the three transports this machine actually needs.
 *
 * Measured on 2026-10-16, and the reason this file exists at all:
 *   huggingface.co  direct        -> times out
 *   huggingface.co  via the proxy -> 302 arrives, the CDN body stalls (60 B/s)
 *   hf-mirror.com   direct        -> 308 to the HF CDN, then 330 KB/s
 *
 * So no single transport can be assumed. A download tries each candidate in
 * order and keeps the one that produces bytes, and every failure carries the
 * transport it came from so the report is actionable.
 *
 * Node has no public proxy API for `fetch`, so the CONNECT tunnel is written
 * out by hand. There are no dependencies.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/** Open a CONNECT tunnel, then hand the socket to TLS. */
function throughProxy(target, proxyUrl, options) {
  return new Promise((resolve, reject) => {
    let proxy
    try {
      proxy = new URL(proxyUrl)
    } catch {
      reject(new Error(`invalid proxy url: ${proxyUrl}`))
      return
    }
    const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
    const socket = netConnect({ host: proxy.hostname, port })
    const fail = (error) => {
      try {
        socket.destroy()
      } catch {}
      reject(error)
    }
    socket.setTimeout(options.timeoutMs, () => fail(new Error(`代理 CONNECT 超时 (${proxy.host})`)))
    socket.once('error', (e) => fail(new Error(`连不上代理 ${proxy.host}:${port} — ${e.message}`)))
    socket.once('connect', () => {
      const hostport = `${target.hostname}:${target.port || 443}`
      socket.write(`CONNECT ${hostport} HTTP/1.1\r\nHost: ${hostport}\r\nProxy-Connection: keep-alive\r\n\r\n`)
      let head = ''
      const onData = (chunk) => {
        head += chunk.toString('latin1')
        const end = head.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.removeListener('data', onData)
        socket.setTimeout(0)
        const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(head)?.[1] ?? 0)
        if (status !== 200) {
          fail(new Error(`代理拒绝 CONNECT（HTTP ${status}）`))
          return
        }
        const tlsSocket = tlsConnect({ socket, servername: target.hostname })
        tlsSocket.once('error', (e) => fail(new Error(`隧道 TLS 失败 — ${e.message}`)))
        tlsSocket.once('secureConnect', () => {
          resolve(
            httpsRequest({
              host: target.hostname,
              port: target.port || 443,
              path: `${target.pathname}${target.search}`,
              method: options.method ?? 'GET',
              headers: { ...options.headers, host: target.hostname },
              agent: false,
              createConnection: () => tlsSocket,
            }),
          )
        })
      }
      socket.on('data', onData)
    })
  })
}

function directly(target, options) {
  const fn = target.protocol === 'https:' ? httpsRequest : httpRequest
  return Promise.resolve(
    fn({
      host: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: { ...options.headers, host: target.hostname },
      agent: false,
    }),
  )
}

/**
 * One request, redirects followed, options.proxy honoured when set.
 * @returns {Promise<{status:number, headers:object, stream:import('node:stream').Readable, finalUrl:string}>}
 */
export function openStream(url, options = {}) {
  const { headers = {}, proxy = null, timeoutMs = 30000, maxRedirects = 6, method = 'GET', transport = 'direct' } = options
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`invalid url: ${url}`))
      return
    }
    const useProxy = transport === 'proxy' && proxy
    const start = useProxy ? throughProxy(target, proxy, { headers, method, timeoutMs }) : directly(target, { headers, method })

    start.then((req) => {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时 ${timeoutMs}ms`)))
      req.once('error', (e) => reject(e))
      req.once('response', (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
          res.resume() // drain
          const next = new URL(res.headers.location, url).toString()
          resolve(openStream(next, { ...options, maxRedirects: maxRedirects - 1 }))
          return
        }
        resolve({ status, headers: res.headers, stream: res, finalUrl: url })
      })
      req.end()
    }, reject)
  })
}

/** Read a whole (small) response body as text. */
export async function getText(url, options = {}) {
  const { status, stream } = await openStream(url, { ...options, method: 'GET' })
  if (status < 200 || status >= 300) {
    stream.resume()
    throw new Error(`HTTP ${status} for ${url}`)
  }
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Report the reachable transports for one URL, cheapest possible probe:
 * a single ranged byte. Returns null when nothing works.
 */
export async function probeTransport(url, { proxy = null, timeoutMs = 12000 } = {}) {
  const results = []
  for (const transport of proxy ? ['direct', 'proxy'] : ['direct']) {
    const started = Date.now()
    try {
      const { status, headers, stream } = await openStream(url, {
        headers: { range: 'bytes=0-0' },
        proxy,
        transport,
        timeoutMs,
      })
      stream.resume()
      const ok = status === 206 || status === 200
      results.push({ transport, ok, status, bytes: Number(headers['content-length'] ?? 0), ms: Date.now() - started })
      if (ok) return { transport, status, ms: Date.now() - started, results }
    } catch (error) {
      results.push({ transport, ok: false, error: String(error?.message ?? error), ms: Date.now() - started })
    }
  }
  return { transport: null, results }
}
