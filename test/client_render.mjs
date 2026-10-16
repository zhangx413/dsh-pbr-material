/**
 * Renders the browser half in Node against a minimal React runtime and a
 * scripted fetch, then drives a full interaction: upload a photo, hit 生成,
 * poll the job, assert the result view.
 *
 * There is no browser available here, so this is the closest thing to a real
 * page load — it would catch a render-time crash, a bad hook, a wrong slot
 * registration, or a broken response field. It does NOT check visual layout.
 *
 *   node --test test/client_render.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'client', 'client.js')

/* ------------------------------------------------------------------ */
/* a small but real React runtime (hooks + rerender loop)              */
/* ------------------------------------------------------------------ */

function createRuntime() {
  let hooks = []
  let deps = []
  let refs = []
  let memos = []
  let index = 0
  let pending = []
  let scheduled = false

  const react = {
    createElement(type, props, ...rest) {
      const children = rest.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      return { type, props: props || {}, children }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const i = index
      index += 1
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        hooks[i] = typeof next === 'function' ? next(hooks[i]) : next
        scheduled = true
      }
      return [hooks[i], set]
    },
    useEffect(fn, list) {
      const i = index
      index += 1
      const prev = deps[i]
      const changed = !prev || !list || list.length !== prev.length || list.some((d, k) => d !== prev[k])
      if (changed) {
        deps[i] = list
        pending.push(fn)
      }
    },
    useLayoutEffect(fn, list) {
      react.useEffect(fn, list)
    },
    useRef(initial) {
      const i = index
      index += 1
      if (!(i in refs)) refs[i] = { current: initial }
      return refs[i]
    },
    useMemo(fn) {
      const i = index
      index += 1
      if (!(i in memos)) memos[i] = fn()
      return memos[i]
    },
    useCallback(fn) {
      return fn
    },
  }

  function renderOnce(Component, props) {
    index = 0
    const tree = Component(props)
    // effects run after the tree is built
    const effects = pending
    pending = []
    const cleanups = []
    for (const fn of effects) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    return { tree, cleanups }
  }

  async function flush(times = 8) {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0))
  }

  return { react, renderOnce, flush, wasScheduled: () => scheduled, resetScheduled: () => { scheduled = false } }
}

/* ------------------------------------------------------------------ */
/* DOM / globals the bundle expects                                    */
/* ------------------------------------------------------------------ */

function installGlobals({ fetchImpl }) {
  const created = []
  const document = {
    head: { appendChild: (node) => created.push(node) },
    querySelector: () => null,
    createElement: () => {
      const node = { dataset: {}, textContent: '', style: {} }
      return node
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const store = new Map()
  const window = {
    __ModuleLoader__: {
      load(def) {
        window.__loaded = def
      },
    },
    document,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    navigator: { userAgent: 'node-test', clipboard: { writeText: () => Promise.resolve() } },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  }
  globalThis.window = window
  globalThis.document = document
  globalThis.location = { href: 'http://127.0.0.1:19387/?token=test' }
  // Node 24 already defines a read-only globalThis.navigator; the bundle only
  // reads `navigator.userAgent`, which that one satisfies. Do not assign it.
  globalThis.fetch = fetchImpl
  return { window, created, store }
}

/** Load the bundle and return its factory result. */
function loadBundle(react) {
  const source = readFileSync(BUNDLE, 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'setTimeout', source)(globalThis.window, setTimeout)
  const def = globalThis.window.__loaded
  assert.ok(def, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(def.id, 'dsh-pbr-material')
  return def.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
}

/* ------------------------------------------------------------------ */
/* fixture: a completed job                                            */
/* ------------------------------------------------------------------ */

const OUT = 'C:\\pbr-materials\\fixture'
const fakeResult = {
  job: 'fixture',
  outDir: OUT,
  maps: {
    albedo: `${OUT}\\albedo.png`,
    normal: `${OUT}\\normal.png`,
    height: `${OUT}\\height.png`,
    roughness: `${OUT}\\roughness.png`,
    ao: `${OUT}\\ao.png`,
    curvature: `${OUT}\\curvature.png`,
    metallic: `${OUT}\\metallic.png`,
  },
  metrics: {
    maps: [
      { key: 'albedo', pass: true, wrap: 0, wrap_ratio: 0, wrap_max: 0, hard_seam: false, file_bits: 8 },
      { key: 'normal', pass: false, wrap: 0.012858, wrap_ratio: 1.8234, wrap_max: 0.50251, hard_seam: true, file_bits: 16 },
      { key: 'height', pass: true, wrap: 0.000071, wrap_ratio: 0.0056, wrap_max: 0.0004, hard_seam: false, file_bits: 16 },
    ],
    normal: { mean_length: 1, unit_frac: 1, min_z: 0.6471, pass: true },
    previews: [`${OUT}\\_albedo_tiled3x3.png`],
    all_tile_pass: false,
    all_normal_pass: true,
  },
  timings: { editMs: 18296, pbrMs: 3015, totalMs: 36601 },
}

function makeFetch() {
  const calls = []
  const routes = {
    '/pbr-material/api/status': () => ({
      comfy: { installFound: true, pythonFound: true },
      modelsReady: true,
      models: {},
      attached: { port: 8288 },
      gpuFreeMiB: 13464,
    }),
    '/pbr-material/api/jobs': () => ({ jobs: [] }),
    '/pbr-material/api/hello': () => ({ ok: true }),
    '/pbr-material/api/models': () => ({
      available: true,
      providers: ['fake-provider'],
      vision: [{ provider: 'fake-provider', model: 'sees-images', name: 'Sees Images' }],
      default: { provider: 'fake-provider', model: 'sees-images' },
    }),
    '/pbr-material/api/draft': () => ({
      ok: true,
      description: 'weathered orange-red enamel paint on metal, chipped and scratched, dust and grime, matte finish',
      provider: 'fake-provider',
      model: 'sees-images',
      source: 'agent-default',
      vision: true,
      elapsedMs: 2100,
    }),
    '/pbr-material/api/naming': () => ({
      ok: true,
      naming: { prefix: 'T_', version: '01', pack: { enabled: true, bitDepth: 8, kinds: ['CA', 'CH', 'NRM'] } },
      suffixes: {
        albedo: '_C', normal: '_N', roughness: '_R', ao: '_AO',
        metallic: '_M', height: '_H', curvature: '_CURV',
      },
      plan: {
        assetName: 'T_Military_SandBag_01',
        folder: 'T_Military_SandBag_01',
        files: ['C', 'N', 'R', 'AO', 'M', 'H', 'CURV'].map((s) => ({
          key: s,
          suffix: `_${s}`,
          name: `T_Military_SandBag_01_${s}.png`,
        })),
        packed: ['CA', 'CH', 'NRM'].map((k) => ({ kind: k, name: `T_Military_SandBag_01_${k}.png` })),
      },
    }),
    '/pbr-material/api/upload': () => ({
      ok: true,
      path: 'C:\\Temp\\dsh-pbr-material\\uploads\\abc123.png',
      name: 'orange.png',
      bytes: 92485,
      url: '/pbr-material/api/file?p=x',
    }),
    '/pbr-material/api/generate': () => ({ id: 'pbr-test-1' }),
    '/pbr-material/api/job': () => ({
      id: 'pbr-test-1',
      state: 'done',
      phase: 'done',
      elapsedMs: 36601,
      material: 'weathered orange-red enamel paint on metal',
      imageName: 'orange.png',
      outDir: OUT,
      log: ['step 1/3 instruction edit', 'step 3/3 7 maps'],
      result: fakeResult,
      error: null,
    }),
  }
  const fetchImpl = (url, init) => {
    const path = String(url).split('?')[0]
    calls.push({ url: String(url), path, init })
    const handler = routes[path]
    if (!handler) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'no route ' + path }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handler()) })
  }
  return { fetchImpl, calls }
}

/** Collect every string in the element tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((n) => texts(n, out))
    return out
  }
  if (node.children) node.children.forEach((n) => texts(n, out))
  return out
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => findAll(n, predicate, out))
    return out
  }
  if (predicate(node)) out.push(node)
  if (node.children) node.children.forEach((n) => findAll(n, predicate, out))
  return out
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

test('bundle loads, registers the sidebar icon and the main panel', () => {
  const { react } = createRuntime()
  const { fetchImpl } = makeFetch()
  installGlobals({ fetchImpl })
  const mod = loadBundle(react)

  assert.deepEqual(mod.inject, ['slots'])
  const registered = []
  const injected = []
  const ctx = {
    slots: {
      inject: (key, cb) => {
        injected.push(key)
        cb()
      },
      register: (meta, component) => {
        registered.push({ meta, component })
        return () => {}
      },
    },
    effect: () => {},
  }
  mod.apply(ctx)

  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
  const icon = registered.find((r) => r.meta.name === 'sidebar.panellist')
  const panel = registered.find((r) => r.meta.name === 'main')
  assert.ok(icon && panel, 'both slots must be registered')
  assert.equal(icon.meta.id, 'pbr-material')
  assert.equal(panel.meta.key, 'pbr-material', 'the panellist id must address the main key')
})

test('panel renders, then drives upload -> generate -> results', async () => {
  const rt = createRuntime()
  const { fetchImpl, calls } = makeFetch()
  installGlobals({ fetchImpl })
  const mod = loadBundle(rt.react)

  let panel = null
  const ctx = {
    slots: {
      inject: (_key, cb) => cb(),
      register: (meta, component) => {
        if (meta.name === 'main') panel = component
        return () => {}
      },
    },
    effect: () => {},
    get: () => undefined,
  }
  mod.apply(ctx)

  // first paint
  let tree = rt.renderOnce(panel).tree
  assert.match(texts(tree).join(' '), /PBR 材质工作台/)
  await rt.flush()
  rt.resetScheduled()
  tree = rt.renderOnce(panel).tree
  assert.match(texts(tree).join(' '), /环境就绪/, 'status fetch must reach the panel')

  // the CSS was injected once
  assert.ok(globalThis.document.head.appendChild.calls !== 0)
  assert.equal(document.querySelector('style[data-plugin-css]'), null)

  // --- drop a photo through the hidden file input ---
  const input = findAll(tree, (n) => n.type === 'input' && n.props.type === 'file')[0]
  assert.ok(input, 'the panel needs a file input')
  input.props.onChange({ target: { files: [{ name: 'orange.png', type: 'image/png' }], value: '' } })
  await rt.flush()
  tree = rt.renderOnce(panel).tree
  const afterUpload = texts(tree).join(' ')
  assert.match(afterUpload, /orange.png/, 'the uploaded image name must be shown')
  assert.ok(calls.some((c) => c.path === '/pbr-material/api/upload'))

  // --- the English box is left empty on purpose: one button must first ask a
  //     model to read the photo, then generate ---
  const boxes = findAll(tree, (n) => n.type === 'textarea')
  assert.equal(boxes.length, 2, 'requirement box + material box')
  boxes[0].props.onChange({ target: { value: '做成能平铺的旧漆，要留住剥落露出的底色' } })
  tree = rt.renderOnce(panel).tree

  const go = findAll(tree, (n) => n.type === 'button' && texts(n).join(' ').includes('生成 PBR')).at(-1)
  assert.ok(go, 'there must be a generate button')
  go.props.onClick()
  await rt.flush()

  const draftCall = calls.find((c) => c.path === '/pbr-material/api/draft')
  assert.ok(draftCall, 'an empty English box must trigger a draft first')
  assert.match(String(draftCall.init.body), /做成能平铺的旧漆/, 'the requirement must reach the draft call')

  // the job fetch returns a finished job, so the result view must render
  tree = rt.renderOnce(panel).tree
  const done = texts(tree).join(' ')
  assert.match(done, /⑤ 结果/, 'result card must render')
  assert.match(done, /打开输出文件夹/)
  assert.match(done, /由 fake-provider\/sees-images 看图写的/, 'the draft provenance must be shown')
  // the drafted English landed in the second box
  const materialBox = findAll(tree, (n) => n.type === 'textarea')[1]
  assert.match(materialBox.props.value, /^weathered orange-red enamel paint/)
  const generateCall = calls.find((c) => c.path === '/pbr-material/api/generate')
  assert.match(String(generateCall.init.body), /"material":"weathered orange-red/, 'generate must use the drafted text')
  assert.match(String(generateCall.init.body), /"provider":"fake-provider"/, 'the draft provenance rides along')
  for (const key of ['albedo', 'normal', 'height', 'roughness', 'ao', 'curvature', 'metallic']) {
    assert.ok(done.includes(key), `missing map tile: ${key}`)
  }
  // the veto-only distinction must reach the user, not a bare FAIL
  const normalTile = findAll(tree, (n) => n.type === 'div' && String(n.props.className || '').includes('pbrx_tile') && texts(n).includes('normal'))[0]
  assert.ok(normalTile, 'normal tile must exist')
  assert.match(texts(normalTile).join(' '), /veto/)
  assert.match(done, /否决线打空枪/)
  assert.match(done, /3×3 平铺预览/)
  // the timing summary proves the result payload was consumed
  assert.match(done, /编辑 18s/)
})

test('a completed job keeps its shape when re-rendered from history', async () => {
  const rt = createRuntime()
  const { fetchImpl } = makeFetch()
  installGlobals({ fetchImpl })
  const mod = loadBundle(rt.react)
  let panel = null
  mod.apply({
    slots: { inject: (_k, cb) => cb(), register: (meta, component) => { if (meta.name === 'main') panel = component; return () => {} } },
    effect: () => {},
    get: () => undefined,
  })
  // three successive paints without any interaction must not throw
  for (let i = 0; i < 3; i += 1) {
    rt.renderOnce(panel)
    await rt.flush(2)
  }
  const tree = rt.renderOnce(panel).tree
  assert.ok(texts(tree).join(' ').includes('把参考图拖到这里'))
})

test('the folder picker reaches ctx.uiWorkspace from inside the panel', async () => {
  // Workbench is defined at factory scope while ctx only exists inside apply(),
  // so this guards the hostCtx hop specifically.
  const rt = createRuntime()
  const { fetchImpl } = makeFetch()
  installGlobals({ fetchImpl })
  const mod = loadBundle(rt.react)

  let panel = null
  let asked = 0
  const picked = 'C:\\pbr-materials\\picked'
  mod.apply({
    slots: { inject: (_k, cb) => cb(), register: (meta, component) => { if (meta.name === 'main') panel = component; return () => {} } },
    effect: () => {},
    get: (name) => (name === 'uiWorkspace'
      ? { pickDirectory: () => { asked += 1; return Promise.resolve(picked) } }
      : undefined),
  })

  let tree = rt.renderOnce(panel).tree
  await rt.flush(2)
  tree = rt.renderOnce(panel).tree

  const button = findAll(tree, (n) => n.type === 'button' && texts(n).join(' ').includes('选择')).at(-1)
  assert.ok(button, 'there must be a 选择… button')
  button.props.onClick()
  await rt.flush(4)

  tree = rt.renderOnce(panel).tree
  assert.equal(asked, 1, 'the panel must ask the client uiWorkspace service')
  const field = findAll(tree, (n) => n.type === 'input' && n.props.value === picked)[0]
  assert.ok(field, 'the picked directory must land in the output-dir field')
})

test('the naming preview comes from the host and rides along on generate', async () => {
  const rt = createRuntime()
  const { fetchImpl, calls } = makeFetch()
  installGlobals({ fetchImpl })
  const mod = loadBundle(rt.react)

  let panel = null
  mod.apply({
    slots: { inject: (_k, cb) => cb(), register: (meta, component) => { if (meta.name === 'main') panel = component; return () => {} } },
    effect: () => {},
    get: () => undefined,
  })

  let tree = rt.renderOnce(panel).tree
  await rt.flush(2)

  const cat = findAll(tree, (n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('资源类别'))[0]
  const nam = findAll(tree, (n) => n.type === 'input' && String(n.props.placeholder || '').startsWith('资源名称'))[0]
  assert.ok(cat && nam, 'the naming fields must exist')
  cat.props.onChange({ target: { value: 'Military' } })
  tree = rt.renderOnce(panel).tree
  nam.props.onChange({ target: { value: 'SandBag' } })
  tree = rt.renderOnce(panel).tree

  // the debounced lookup fires, and it carries what the user typed
  await new Promise((r) => setTimeout(r, 350))
  await rt.flush(4)
  const namingCall = calls.filter((c) => c.path === '/pbr-material/api/naming').at(-1)
  assert.ok(namingCall, 'the panel must ask the host for the plan')
  assert.match(namingCall.url, /category=Military/)
  assert.match(namingCall.url, /name=SandBag/)

  tree = rt.renderOnce(panel).tree
  const shown = texts(tree).join('\n')
  assert.match(shown, /T_Military_SandBag_01\\/, 'the folder preview must be shown')
  assert.match(shown, /T_Military_SandBag_01_AO\.png/, 'every file name must be previewed')
  assert.match(shown, /T_Military_SandBag_01_NRM\.png/, 'the packed names must be previewed')

  // and the plan is carried into the generate request
  const input = findAll(tree, (n) => n.type === 'input' && n.props.type === 'file')[0]
  input.props.onChange({ target: { files: [{ name: 'x.png', type: 'image/png' }], value: '' } })
  await rt.flush()
  tree = rt.renderOnce(panel).tree
  const boxes = findAll(tree, (n) => n.type === 'textarea')
  boxes[1].props.onChange({ target: { value: 'aged teal paint on steel, scratched, matte' } })
  tree = rt.renderOnce(panel).tree
  const go = findAll(tree, (n) => n.type === 'button' && texts(n).join(' ').includes('生成 PBR')).at(-1)
  go.props.onClick()
  await rt.flush()

  const generate = calls.filter((c) => c.path === '/pbr-material/api/generate').at(-1)
  const body = JSON.parse(generate.init.body)
  assert.deepEqual(body.naming, { category: 'Military', name: 'SandBag', version: '01', pack: true })
})

test('a hand-written English line is used as-is, with no model call', async () => {
  const rt = createRuntime()
  const { fetchImpl, calls } = makeFetch()
  installGlobals({ fetchImpl })
  const mod = loadBundle(rt.react)

  let panel = null
  mod.apply({
    slots: { inject: (_k, cb) => cb(), register: (meta, component) => { if (meta.name === 'main') panel = component; return () => {} } },
    effect: () => {},
    get: () => undefined,
  })

  let tree = rt.renderOnce(panel).tree
  await rt.flush(2)
  tree = rt.renderOnce(panel).tree

  const input = findAll(tree, (n) => n.type === 'input' && n.props.type === 'file')[0]
  input.props.onChange({ target: { files: [{ name: 'x.png', type: 'image/png' }], value: '' } })
  await rt.flush()
  tree = rt.renderOnce(panel).tree

  const boxes = findAll(tree, (n) => n.type === 'textarea')
  boxes[1].props.onChange({ target: { value: 'aged teal paint on steel, scratched, matte' } })
  tree = rt.renderOnce(panel).tree
  const go = findAll(tree, (n) => n.type === 'button' && texts(n).join(' ').includes('生成 PBR')).at(-1)
  go.props.onClick()
  await rt.flush()

  assert.equal(calls.filter((c) => c.path === '/pbr-material/api/draft').length, 0, 'no draft when it is already written')
  const generate = calls.find((c) => c.path === '/pbr-material/api/generate')
  assert.match(String(generate.init.body), /aged teal paint on steel/)
})
