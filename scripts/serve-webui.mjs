#!/usr/bin/env node
/**
 * Standalone harness for the web UI's host half.
 *
 * Mounts exactly the routes the plugin mounts inside DSH, on a plain Node HTTP
 * server, so the REST surface can be exercised (and debugged) without starting
 * DSH at all:
 *
 *   node scripts/serve-webui.mjs --port 8391
 *   curl http://127.0.0.1:8391/pbr-material/api/status
 *
 * `/` serves a tiny diagnostic page (with the same index injection applied) so
 * the route list is discoverable in a browser. The panel itself needs the DSH
 * shell for `window.__ModuleLoader__`, so it only renders inside DSH.
 */
import { createServer } from 'node:http'

import { loadConfig } from '../lib/config.js'
import { handleRequest, injectClientTag } from '../lib/webui.js'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8391

const cfg = loadConfig()

const INDEX = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-pbr-material harness</title></head>
<body><h3>dsh-pbr-material — host API harness</h3>
<ul>
  <li>GET  /pbr-material/api/status</li>
  <li>GET  /pbr-material/api/jobs</li>
  <li>GET  /pbr-material/api/job?id=</li>
  <li>POST /pbr-material/api/generate</li>
  <li>POST /pbr-material/api/upload?name=</li>
  <li>GET  /pbr-material/api/file?p=</li>
  <li>POST /pbr-material/api/check</li>
  <li>POST /pbr-material/api/hello</li>
  <li>GET  /pbr-material/api/clients</li>
  <li>GET  /pbr-material/client.js</li>
</ul>
<p id="marker">injected-script-ok</p>
</body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname.startsWith('/pbr-material/')) {
    handleRequest(cfg, req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error?.message ?? error) }))
    })
    return
  }
  const html = injectClientTag(INDEX)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`dsh-pbr-material harness on http://127.0.0.1:${port}/`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
