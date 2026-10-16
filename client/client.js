/* dsh-pbr-material — browser half.
 *
 * Registered as a main panel (key `pbr-material`) plus a sidebar icon
 * (`sidebar.panellist`, whose id addresses exactly that main panel, so no
 * layout API call is needed).
 *
 * Delivery: this file is the package's `dsh.client` entry, so the shell's
 * module loader fetches and executes it the same way it does for every other
 * client plugin. The host ALSO injects it into index.html as a fallback; the
 * `__dshPbrMaterialLoaded` guard makes the second execution a no-op.
 *
 * Everything the panel needs is under /pbr-material/api/*. The host cannot see
 * the page, so each load stage reports back to /api/hello — that is the only
 * way to tell "never fetched" from "fetched but refused" without a devtools.
 */
;(function () {
  if (window.__dshPbrMaterialLoaded) return
  window.__dshPbrMaterialLoaded = true

  function beacon(stage, detail) {
    try {
      var href = typeof location !== 'undefined' && location ? String(location.href).slice(0, 120) : ''
      var payload = { stage: stage, href: href }
      if (detail !== undefined) {
        try {
          payload.detail = typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)
        } catch (e) {
          payload.detail = String(detail).slice(0, 300)
        }
      }
      fetch('/pbr-material/api/hello', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {})
    } catch (e) {}
  }

  var bootTries = 0
  function boot() {
    if (!window.__ModuleLoader__) {
      bootTries += 1
      if (bootTries === 1) {
        beacon('bundle-start', { hasLoader: false, src: document.currentScript && document.currentScript.src })
      }
      if (bootTries === 334) beacon('loader-timeout', { tries: bootTries })
      setTimeout(boot, 30)
      return
    }
    beacon('loader-found', { tries: bootTries, keys: Object.keys(window.__ModuleLoader__ || {}).slice(0, 8) })
    try {
      window.__ModuleLoader__.load({
        id: 'dsh-pbr-material',
        factory: function (require) {
          var module = { exports: {} }
          var exports = module.exports
          var react = require('react')
          var h = react.createElement

          /**
           * Where the host lives. Normally the panel is same-origin and a
           * relative URL is right; but the desktop shell may render from a
           * custom scheme (dsh-app://), in which case a relative fetch would
           * resolve against that scheme and go nowhere. Fall back to whatever
           * the boot payload says the transport origin is.
           */
          var HOST = (function () {
            try {
              if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return ''
              var sources = [window.__DSH_BOOT__, window.__DSH_TRANSPORT__, window.__DSH_BOOT__ && window.__DSH_BOOT__.transport]
              for (var i = 0; i < sources.length; i += 1) {
                var s = sources[i]
                if (!s || typeof s !== 'object') continue
                var keys = ['baseUrl', 'url', 'origin', 'httpUrl', 'serverUrl', 'host']
                for (var k = 0; k < keys.length; k += 1) {
                  var v = s[keys[k]]
                  if (typeof v === 'string' && /^https?:\/\//.test(v)) return v.replace(/\/+$/, '')
                }
              }
            } catch (e) {}
            return ''
          })()
          var API = HOST + '/pbr-material/api'
          var pageOrigin = (typeof location !== 'undefined' && location.origin) || '(none)'
          /** set in apply(); lets components reach services without closing over ctx */
          var hostCtx = null

        /* ------------------------------------------------------------------ */
        /* styles                                                              */
        /* ------------------------------------------------------------------ */

        var CSS_ID = 'dsh-pbr-material/styles.css'
        if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
          var tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-pbr-material'
          tag.dataset.pluginCss = CSS_ID
          tag.textContent = [
            '.pbrx_root{display:flex;flex-direction:column;gap:14px;height:100%;overflow:auto;box-sizing:border-box;padding:18px 20px 28px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px}',
            '.pbrx_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
            '.pbrx_title{font-size:15px;font-weight:600}',
            '.pbrx_sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8b8b)}',
            '.pbrx_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));font-size:12px}',
            '.pbrx_badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:500;line-height:16px}',
            '.pbrx_badge_ok{background:rgba(16,185,129,.14);color:var(--dsw-alias-state-success-primary,#10b981)}',
            '.pbrx_badge_warn{background:rgba(245,158,11,.14);color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
            '.pbrx_badge_bad{background:rgba(239,68,68,.14);color:var(--dsw-alias-state-error-primary,#ef4444)}',
            '.pbrx_badge_plain{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:var(--dsw-alias-label-secondary,#b5b5b5)}',
            '.pbrx_cols{display:grid;grid-template-columns:minmax(220px,320px) 1fr;gap:18px;align-items:start}',
            '@media (max-width:820px){.pbrx_cols{grid-template-columns:1fr}}',
            '.pbrx_card{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16))}',
            '.pbrx_cardTitle{font-size:12.5px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px}',
            '.pbrx_drop{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:1/1;border-radius:10px;border:1.5px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05));cursor:pointer;overflow:hidden;text-align:center;transition:border-color .15s ease,background-color .15s ease}',
            '.pbrx_drop:hover{border-color:var(--dsw-alias-brand-primary,#3b82f6)}',
            '.pbrx_dropOver{border-color:var(--dsw-alias-brand-primary,#3b82f6);background:rgba(59,130,246,.10)}',
            '.pbrx_dropHint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8b8b);line-height:1.7;padding:12px}',
            '.pbrx_dropImg{width:100%;height:100%;object-fit:contain;background:repeating-conic-gradient(rgba(128,128,128,.14) 0 25%,transparent 0 50%) 0 0/18px 18px}',
            '.pbrx_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
            '.pbrx_field{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}',
            '.pbrx_label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#b5b5b5)}',
            '.pbrx_hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8b8b);line-height:1.5}',
            '.pbrx_warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#f59e0b);line-height:1.5}',
            '.pbrx_input,.pbrx_textarea,.pbrx_select{width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2,rgba(128,128,128,.09)));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:8px;color:var(--dsw-alias-label-primary,#e6e6e6);padding:7px 9px;font-size:12.5px;font-family:inherit;outline:none}',
            '.pbrx_textarea{min-height:92px;resize:vertical;line-height:1.55}',
            '.pbrx_input:focus,.pbrx_textarea:focus,.pbrx_select:focus{border-color:var(--dsw-alias-brand-primary,#3b82f6);box-shadow:0 0 0 2px rgba(59,130,246,.18)}',
            '.pbrx_btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.09));color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12.5px;font-family:inherit;cursor:pointer;transition:background-color .12s ease,transform .08s ease}',
            '.pbrx_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}',
            '.pbrx_btn:active{transform:scale(.98)}',
            '.pbrx_btn:disabled{opacity:.5;cursor:not-allowed}',
            '.pbrx_btnPrimary{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 22%,transparent);border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6);font-weight:600;padding:8px 20px}',
            '.pbrx_btnPrimary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b82f6) 34%,transparent)}',
            '.pbrx_chips{display:flex;gap:6px;flex-wrap:wrap}',
            '.pbrx_chip{padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));background:transparent;color:var(--dsw-alias-label-secondary,#b5b5b5);font-size:11.5px;cursor:pointer;font-family:inherit}',
            '.pbrx_chip:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-brand-primary,#3b82f6)}',
            '.pbrx_adv{border-top:1px dashed var(--dsw-alias-separator-primary,rgba(128,128,128,.28));padding-top:10px;display:flex;flex-direction:column;gap:10px}',
            '.pbrx_disclosure{display:flex;align-items:center;gap:6px;background:none;border:none;padding:0;color:var(--dsw-alias-label-secondary,#b5b5b5);font-size:12px;cursor:pointer;font-family:inherit}',
            '.pbrx_disclosure:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}',
            '.pbrx_grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
            '.pbrx_params{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
            '.pbrx_log{margin:0;max-height:132px;overflow:auto;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary,#b5b5b5);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all}',
            '.pbrx_maps{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}',
            '.pbrx_tile{display:flex;flex-direction:column;gap:5px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));padding:6px;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05))}',
            '.pbrx_tileImg{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:5px;background:#000;image-rendering:auto;cursor:zoom-in}',
            '.pbrx_tileName{font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:4px}',
            '.pbrx_tileMeta{font-size:10px;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-variant-numeric:tabular-nums}',
            '.pbrx_pass{color:var(--dsw-alias-state-success-primary,#10b981)}',
            '.pbrx_fail{color:var(--dsw-alias-state-error-primary,#ef4444)}',
            '.pbrx_veto{color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
            '.pbrx_preview{width:100%;max-width:420px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background:#000;image-rendering:auto;cursor:zoom-in}',
            '.pbrx_path{font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary,#b5b5b5);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));padding:6px 9px;border-radius:7px;word-break:break-all;user-select:all}',
            '.pbrx_plan{display:flex;flex-direction:column;gap:6px;font:11.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-secondary,#b5b5b5);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));padding:8px 10px;border-radius:8px;white-space:pre-line;user-select:all}',
            '.pbrx_toast{padding:8px 12px;border-radius:9px;font-size:12.5px;line-height:1.5}',
            '.pbrx_toastErr{background:rgba(239,68,68,.13);color:var(--dsw-alias-state-error-primary,#ef4444)}',
            '.pbrx_toastOk{background:rgba(16,185,129,.13);color:var(--dsw-alias-state-success-primary,#10b981)}',
            '.pbrx_jobsList{display:flex;flex-direction:column;gap:5px}',
            '.pbrx_jobRow{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:5px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}',
            '.pbrx_jobRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
            '.pbrx_jobRowActive{border-color:var(--dsw-alias-brand-primary,#3b82f6)}',
            '.pbrx_mono{font-variant-numeric:tabular-nums}',
            '.pbrx_lightbox{position:fixed;inset:0;z-index:99998;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.72));display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:4vh 4vw}',
            '.pbrx_lightboxImg{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}',
            '.pbrx_icon{display:block}',
          ].join('\n')
          document.head.appendChild(tag)
        }

        /* ------------------------------------------------------------------ */
        /* helpers                                                             */
        /* ------------------------------------------------------------------ */

        var PRESETS = [
          { label: '橙红旧漆', text: 'weathered orange-red enamel paint on metal, chipped and scratched revealing pale grey primer and bare metal underneath, fine scratches, dust and grime, matte aged finish' },
          { label: '风化黄漆', text: 'heavily worn pale yellow-cream paint on metal, large flakes of paint chipped off revealing dark brown and black bare metal underneath, fine scratches, dust and grime, matte aged finish' },
          { label: '锈蚀钢板', text: 'heavily rusted steel plate, orange-brown corrosion with dark pitting, flaking scale, uneven oxide patches, dried grime, matte rough finish' },
          { label: '清水混凝土', text: 'poured concrete surface, pale grey cement with fine aggregate speckle, small air bubbles and pores, faint formwork marks, chalky matte finish, no large stains' },
          { label: '脏帆布', text: 'coarse woven canvas fabric, off-white cotton weave with visible warp and weft threads, dirt smudges, slight fraying, matte finish' },
          { label: '木地板', text: 'aged oak floorboards, warm mid-brown wood with visible grain and fine cracks, worn finish, thin scratches, light dust, satin sheen' },
        ]

        var CJK = /[\u3400-\u9fff\uf900-\ufaff]/

        function fmtDuration(ms) {
          if (!ms && ms !== 0) return '-'
          var s = Math.round(ms / 1000)
          if (s < 60) return s + 's'
          return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
        }

        function fileUrl(p) {
          return API + '/file?p=' + encodeURIComponent(p)
        }

        function verdictOf(m) {
          if (m.pass) return 'pass'
          var primaryOk = m.wrap_ratio <= 1.4 || m.wrap <= 0.02
          if (m.hard_seam && primaryOk) return 'veto'
          return 'fail'
        }

        function loadPrefs() {
          try {
            return JSON.parse(window.localStorage.getItem('dsh-pbr-material/prefs') || '{}') || {}
          } catch (e) {
            return {}
          }
        }

        function savePrefs(patch) {
          try {
            var cur = loadPrefs()
            Object.keys(patch).forEach(function (k) { cur[k] = patch[k] })
            window.localStorage.setItem('dsh-pbr-material/prefs', JSON.stringify(cur))
          } catch (e) {}
        }

        /* ------------------------------------------------------------------ */
        /* main panel                                                          */
        /* ------------------------------------------------------------------ */

        function Workbench() {
          var prefs = react.useMemo(loadPrefs, [])

          var [status, setStatus] = react.useState(null)
          var [image, setImage] = react.useState(null)
          // Two ways to get maps, and the choice changes everything downstream:
          //   direct  — the photo is already a flat, front-facing texture; tile it
          //             and derive. No prompt, ~3 s, the photo's detail survives.
          //   generate— the photo shows an object/angle; a model reworks it into
          //             flat albedo first. ~30 s, and the detail is re-invented.
          var [mode, setMode] = react.useState(prefs.mode === 'direct' ? 'direct' : 'generate')
          var [requirement, setRequirement] = react.useState(prefs.requirement || '')
          var [material, setMaterial] = react.useState(prefs.material || '')
          var [drafting, setDrafting] = react.useState(false)
          var [draftInfo, setDraftInfo] = react.useState(null)
          var [models, setModels] = react.useState(null)
          var [modelChoice, setModelChoice] = react.useState(prefs.modelChoice || '')
          var [outDir, setOutDir] = react.useState(prefs.outDir || '')
          var [category, setCategory] = react.useState(prefs.category || '')
          var [assetName, setAssetName] = react.useState(prefs.assetName || '')
          var [version, setVersion] = react.useState(prefs.version || '01')
          var [packEnabled, setPackEnabled] = react.useState(prefs.packEnabled !== false)
          var [namingInfo, setNamingInfo] = react.useState(null)
          var [advOpen, setAdvOpen] = react.useState(false)
          var [size, setSize] = react.useState(prefs.size || 1024)
          var [steps, setSteps] = react.useState(prefs.steps || 20)
          var [cfgScale, setCfgScale] = react.useState(prefs.cfgScale || 5)
          var [seed, setSeed] = react.useState(prefs.seed || 0)
          var [cmMode, setCmMode] = react.useState(prefs.cmMode || 'hue')
          var [cmStrength, setCmStrength] = react.useState(prefs.cmStrength === undefined ? 0.6 : prefs.cmStrength)
          var [metallic, setMetallic] = react.useState(prefs.metallic || 0)
          var [baseRoughness, setBaseRoughness] = react.useState(prefs.baseRoughness === undefined ? 0.55 : prefs.baseRoughness)
          var [keepInstance, setKeepInstance] = react.useState(false)
          var [busy, setBusy] = react.useState('')
          var [toast, setToast] = react.useState(null)
          var [drag, setDrag] = react.useState(false)
          var [job, setJob] = react.useState(null)
          var [jobs, setJobs] = react.useState([])
          var [zoom, setZoom] = react.useState(null)
          var fileInput = react.useRef(null)
          /** provenance of the last AI-written description, attached to the job */
          var lastDraft = react.useRef(null)

          function note(kind, text) {
            setToast({ kind: kind, text: text })
          }

          function refreshStatus() {
            fetch(API + '/status', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(setStatus)
              .catch(function () { setStatus(null) })
          }

          function refreshJobs() {
            fetch(API + '/jobs', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (d) { setJobs((d && d.jobs) || []) })
              .catch(function () {})
          }

          react.useEffect(function () {
            refreshStatus()
            refreshJobs()
            fetch(API + '/models', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(setModels)
              .catch(function () {})
            fetch(API + '/hello', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ agent: navigator.userAgent.slice(0, 80) }),
            }).catch(function () {})
          }, [])

          react.useEffect(function () { savePrefs({ requirement: requirement }) }, [requirement])
          react.useEffect(function () { savePrefs({ mode: mode }) }, [mode])
          react.useEffect(function () { savePrefs({ modelChoice: modelChoice }) }, [modelChoice])
          react.useEffect(function () { savePrefs({ material: material }) }, [material])
          react.useEffect(function () {
            savePrefs({ category: category, assetName: assetName, version: version, packEnabled: packEnabled })
          }, [category, assetName, version, packEnabled])

          // The host owns the naming rules; this asks it for the exact plan so
          // the preview below cannot drift from what will actually be written.
          react.useEffect(function () {
            var timer = setTimeout(function () {
              fetch(
                API + '/naming?category=' + encodeURIComponent(category) +
                '&name=' + encodeURIComponent(assetName) +
                '&version=' + encodeURIComponent(version),
                { cache: 'no-store' },
              )
                .then(function (r) { return r.json() })
                .then(setNamingInfo)
                .catch(function () {})
            }, 250)
            return function () { clearTimeout(timer) }
          }, [category, assetName, version])
          react.useEffect(function () { savePrefs({ outDir: outDir }) }, [outDir])
          react.useEffect(function () {
            savePrefs({ size: size, steps: steps, cfgScale: cfgScale, seed: seed, cmMode: cmMode, cmStrength: cmStrength, metallic: metallic, baseRoughness: baseRoughness })
          }, [size, steps, cfgScale, seed, cmMode, cmStrength, metallic, baseRoughness])

          var jobId = job && job.id
          var jobState = job && job.state
          react.useEffect(function () {
            if (!jobId || (jobState !== 'running' && jobState !== 'queued')) return undefined
            var stop = false
            var timer = 0
            function tick() {
              fetch(API + '/job?id=' + encodeURIComponent(jobId), { cache: 'no-store' })
                .then(function (r) { return r.json() })
                .then(function (d) { if (!stop) setJob(d) })
                .catch(function () {})
                .then(function () { if (!stop) timer = setTimeout(tick, 2000) })
            }
            timer = setTimeout(tick, 1200)
            return function () {
              stop = true
              clearTimeout(timer)
            }
          }, [jobId, jobState])

          react.useEffect(function () {
            if (jobState === 'done' || jobState === 'error') refreshJobs()
          }, [jobState])

          function upload(file) {
            if (!file) return
            setBusy('upload')
            note(null, null)
            fetch(API + '/upload?name=' + encodeURIComponent(file.name || 'reference.png'), {
              method: 'POST',
              body: file,
              headers: { 'content-type': file.type || 'application/octet-stream' },
            })
              .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
              .then(function (r) {
                if (!r.ok) throw new Error(r.d.error || 'upload failed')
                setImage(r.d)
              })
              .catch(function (e) { note('err', '上传失败：' + e.message) })
              .then(function () { setBusy('') })
          }

          react.useEffect(function () {
            function onPaste(e) {
              var items = (e.clipboardData && e.clipboardData.items) || []
              for (var i = 0; i < items.length; i += 1) {
                if (items[i].type && items[i].type.indexOf('image/') === 0) {
                  var f = items[i].getAsFile()
                  if (f) {
                    upload(f)
                    e.preventDefault()
                  }
                  return
                }
              }
            }
            window.addEventListener('paste', onPaste)
            return function () { window.removeEventListener('paste', onPaste) }
          }, [])

          function chooseDir() {
            // `ctx` is not in scope here: Workbench is defined at factory scope,
            // while ctx only exists inside apply(). hostCtx carries it across.
            var svc = hostCtx && hostCtx.get ? hostCtx.get('uiWorkspace') : null
            if (!svc || !svc.pickDirectory) {
              note('err', '当前环境没有目录选择服务，请手工填写路径')
              return
            }
            svc.pickDirectory().then(function (p) {
              if (p) setOutDir(p)
            }).catch(function (e) { note('err', String(e && e.message ? e.message : e)) })
          }

          /**
           * Ask a vision model to read the reference photo plus the user's
           * intent and write the English material description FLUX needs.
           * @returns {Promise<string|null>} the description, or null on failure
           */
          function draft() {
            if (!image) {
              note('err', '先放入一张参考图')
              return Promise.resolve(null)
            }
            setDrafting(true)
            setDraftInfo(null)
            var parts = modelChoice ? modelChoice.split('|') : []
            return fetch(API + '/draft', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                imagePath: image.path,
                requirement: requirement,
                provider: parts[0] || undefined,
                model: parts[1] || undefined,
              }),
            })
              .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
              .then(function (r) {
                if (!r.ok || !r.d.ok) throw new Error(r.d.error || 'draft failed')
                lastDraft.current = r.d
                setMaterial(r.d.description)
                setDraftInfo({
                  ok: true,
                  text: '由 ' + r.d.provider + '/' + r.d.model + ' 看图写的（' +
                    ((r.d.elapsedMs || 0) / 1000).toFixed(1) + 's）' +
                    (r.d.vision ? '' : ' · 注意：这个模型没有声明支持图片输入，它可能没真的看到图'),
                })
                return r.d.description
              })
              .catch(function (e) {
                setDraftInfo({ ok: false, text: '写描述失败：' + e.message })
                return null
              })
              .then(function (v) { setDrafting(false); return v })
          }

          function generate() {
            if (!image) { note('err', '先放入一张参考图'); return }
            setBusy('generate')
            note(null, null)
            var isDirect = mode === 'direct'
            // One button: if there is no English description yet, write it
            // first. An explicit description is never overwritten.
            // Direct mode has no prompt at all, so nothing is required of the user.
            var pending = isDirect
              ? Promise.resolve(null)
              : material.trim()
                ? Promise.resolve(material.trim())
                : (requirement.trim()
                  ? draft().then(function (d) { return d || '' })
                  : Promise.reject(new Error('② 里写点需求，或者在 ③ 里直接填材质描述')))
            pending
              .then(function (finalMaterial) {
                if (!isDirect && !finalMaterial) throw new Error('没有拿到可用的材质描述')
                var drafted = lastDraft.current
                return fetch(API + '/generate', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    imagePath: image.path,
                    mode: mode,
                    material: finalMaterial || undefined,
                    outDir: outDir.trim() || undefined,
                    naming: namingPayload,
                    size: Number(size),
                    steps: Number(steps),
                    cfg: Number(cfgScale),
                    seed: Number(seed),
                    colorMatch: { mode: cmMode, strength: Number(cmStrength) },
                    pbr: { metallic: Number(metallic), baseRoughness: Number(baseRoughness) },
                    keepInstance: keepInstance,
                    draft: !isDirect && drafted
                      ? { requirement: requirement, provider: drafted.provider, model: drafted.model }
                      : undefined,
                  }),
                })
              })
              .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d } }) })
              .then(function (r) {
                if (!r.ok) throw new Error(r.d.error || 'generate failed')
                return fetch(API + '/job?id=' + encodeURIComponent(r.d.id), { cache: 'no-store' })
                  .then(function (x) { return x.json() })
                  .then(function (d) {
                    setJob(d)
                    setJobs(function (prev) { return [d].concat(prev) })
                  })
              })
              .catch(function (e) { note('err', e.message) })
              .then(function () { setBusy('') })
          }

          function reveal(dir) {
            fetch(API + '/reveal', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: dir }),
            }).catch(function () {})
          }

          /* ---------- derived ---------- */
          var envReady = !!(status && status.comfy && status.comfy.installFound && status.comfy.pythonFound && status.modelsReady)
          var missing = []
          if (status) {
            if (!status.comfy.installFound) missing.push('ComfyUI 安装目录')
            if (!status.comfy.pythonFound) missing.push('ComfyUI python')
            if (!status.modelsReady) {
              Object.keys(status.models || {}).forEach(function (k) {
                if (!status.models[k].found) missing.push(status.models[k].file)
              })
            }
          }
          var cjkInMaterial = CJK.test(material)
          var namingPlan = namingInfo && namingInfo.plan ? namingInfo.plan : null
          var namingPayload = namingPlan
            ? { category: category.trim(), name: assetName.trim(), version: version.trim() || undefined, pack: packEnabled }
            : undefined
          var visionModels = (models && models.available && models.vision) || []
          var anyModels = (models && models.available && models.all) || []
          var offerable = visionModels.length > 0 ? visionModels : anyModels
          var modelOptions = []
          if (offerable.length > 0) {
            modelOptions.push({
              value: '',
              label: '自动：优先 ' + (models.default ? models.default.model : offerable[0].model),
            })
            offerable.forEach(function (m) {
              modelOptions.push({
                value: m.provider + '|' + m.model,
                label: m.model + ' · ' + m.provider + (visionModels.length === 0 ? '（未声明支持图片）' : ''),
              })
            })
          }
          var result = job && job.state === 'done' ? job.result : null
          var metricsByKey = {}
          if (result && result.metrics && result.metrics.maps) {
            result.metrics.maps.forEach(function (m) { metricsByKey[m.key] = m })
          }
          var MAP_ORDER = ['albedo', 'normal', 'height', 'roughness', 'ao', 'curvature', 'metallic']
          var running = job && (job.state === 'running' || job.state === 'queued')

          /* ---------- render ---------- */
          var bar = h('div', { className: 'pbrx_bar' }, [
            h('span', { key: 'env', className: 'pbrx_badge ' + (envReady ? 'pbrx_badge_ok' : 'pbrx_badge_bad') },
              envReady ? '环境就绪' : '环境不完整'),
            status ? h('span', { key: 'i', className: 'pbrx_sub' },
              (status.comfy.installFound ? 'ComfyUI ✓' : 'ComfyUI ✗') + ' · ' +
              (status.modelsReady ? '模型 ✓' : '模型 ✗') + ' · ' +
              (status.attached ? '已接入实例 :' + status.attached.port : '实例未运行（生成时自起）')) : h('span', { key: 'i', className: 'pbrx_sub' }, '读取环境…'),
            status && status.gpuFreeMiB !== null && status.gpuFreeMiB !== undefined
              ? h('span', { key: 'v', className: 'pbrx_badge ' + (status.gpuFreeMiB > 9000 ? 'pbrx_badge_plain' : 'pbrx_badge_warn') }, '空闲显存 ' + Math.round(status.gpuFreeMiB / 1024 * 10) / 10 + ' GB')
              : null,
            h('span', { key: 'sp', style: { flex: 1 } }),
            h('button', { key: 'r', className: 'pbrx_btn', onClick: refreshStatus }, '刷新'),
          ].filter(Boolean))

          var banner = null
          if (status && missing.length > 0) {
            banner = h('div', { className: 'pbrx_toast pbrx_toastErr' }, '缺少：' + missing.join('、') + ' —— 修好之前无法生成。')
          } else if (toast) {
            banner = h('div', { className: 'pbrx_toast ' + (toast.kind === 'err' ? 'pbrx_toastErr' : 'pbrx_toastOk') }, toast.text)
          }

          var drop = h('div', {
            className: 'pbrx_drop' + (drag ? ' pbrx_dropOver' : ''),
            onClick: function () { if (fileInput.current) fileInput.current.click() },
            onDragOver: function (e) { e.preventDefault(); setDrag(true) },
            onDragLeave: function () { setDrag(false) },
            onDrop: function (e) {
              e.preventDefault()
              setDrag(false)
              var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
              upload(f)
            },
            title: '点击选择 / 拖入 / 直接粘贴',
          }, image
            ? h('img', { className: 'pbrx_dropImg', src: image.url, alt: image.name })
            : h('div', { className: 'pbrx_dropHint' }, busy === 'upload' ? '上传中…' : '把参考图拖到这里\n或点击选择 / Ctrl+V 粘贴'))

          var imageCol = h('div', { className: 'pbrx_card' }, [
            h('div', { key: 't', className: 'pbrx_cardTitle' }, [
              h('span', { key: 'l' }, '① 参考图'),
              image ? h('span', { key: 'n', className: 'pbrx_sub' }, image.name + '  ' + Math.round(image.bytes / 1024) + ' KB') : null,
            ]),
            drop,
            h('input', {
              key: 'f',
              ref: fileInput,
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              onChange: function (e) {
                var f = e.target.files && e.target.files[0]
                upload(f)
                e.target.value = ''
              },
            }),
            h('div', { key: 'h', className: 'pbrx_hint' }, '平铺质量受参考图里可用的平面面积限制：输出边长约为参考边长的 1.6 倍以内最稳。'),
          ])

          var formCol = h('div', { className: 'pbrx_card' }, [
            h('div', { key: 't', className: 'pbrx_cardTitle' }, [
              h('span', { key: 'l' }, '② 怎么处理这张照片'),
              h('span', { key: 'h', className: 'pbrx_sub' }, '选错了会白等 30 秒，或者把你要的细节丢掉'),
            ]),
            h('div', { key: 'm', className: 'pbrx_row', style: { gap: '8px' } }, [
              h('button', {
                key: 'd',
                className: 'pbrx_btn' + (mode === 'direct' ? ' pbrx_btn_on' : ''),
                style: mode === 'direct' ? { background: 'var(--pbrx_accent)', color: '#fff', borderColor: 'var(--pbrx_accent)' } : null,
                onClick: function () { setMode('direct') },
              }, '① 照片已经是正面贴图 → 直接推导'),
              h('button', {
                key: 'g',
                className: 'pbrx_btn' + (mode === 'generate' ? ' pbrx_btn_on' : ''),
                style: mode === 'generate' ? { background: 'var(--pbrx_accent)', color: '#fff', borderColor: 'var(--pbrx_accent)' } : null,
                onClick: function () { setMode('generate') },
              }, '② 照片里有物体/透视 → 先生成再推导'),
            ]),
            h('div', { key: 'e', className: mode === 'direct' ? 'pbrx_hint' : 'pbrx_warn' },
              mode === 'direct'
                ? '直通：照片就是 albedo，只做平铺 + 推导 PBR，约 3 秒，照片原始分辨率与细节原样保留。不需要写任何描述。'
                : '生成式：FLUX.2 Klein 会先把照片重绘成平面 albedo，约 30 秒。它会把真实纹理（模板缝、骨料、水渍、精确颜色）替换成"看起来合理"的通用细节 —— 对一张已经拍好的贴图，这通常不是你想要的。'),
          ])

          var intentCol = mode === 'direct' ? null : h('div', { className: 'pbrx_card' }, [
            h('div', { key: 't', className: 'pbrx_cardTitle' }, [
              h('span', { key: 'l' }, '③ 你的需求'),
              h('span', { key: 'h', className: 'pbrx_sub' }, '中文就行 —— 这是说给模型听的，不是给生图软件'),
            ]),
            h('textarea', {
              key: 'r',
              className: 'pbrx_textarea',
              value: requirement,
              placeholder: '我想把这个做成能平铺的旧漆材质，注意有种被磨过的感觉，剥落的地方露出的底色要留住…',
              onChange: function (e) { setRequirement(e.target.value) },
            }),
            h('div', { key: 'd', className: 'pbrx_row' }, [
              h('button', {
                key: 'b',
                className: 'pbrx_btn',
                disabled: !image || drafting,
                onClick: draft,
              }, drafting ? '模型看图…' : '让模型看图写英文描述'),
              modelOptions.length > 1
                ? h('select', {
                  key: 's',
                  className: 'pbrx_select',
                  style: { maxWidth: '230px' },
                  value: modelChoice,
                  onChange: function (e) { setModelChoice(e.target.value) },
                }, modelOptions.map(function (m) {
                  return h('option', { key: m.value, value: m.value }, m.label)
                }))
                : null,
            ]),
            models && models.available === false
              ? h('div', { key: 'mu', className: 'pbrx_warn' }, '读不到模型列表：' + (models.reason || 'llm 服务不可用'))
              : null,
            models && models.available && visionModels.length === 0 && anyModels.length > 0
              ? h('div', { key: 'mv', className: 'pbrx_warn' },
                '没有任何 provider 声明支持图片输入。下拉里手动挑一个多模态模型，否则模型可能根本没看到参考图。')
              : null,
            draftInfo
              ? h('div', {
                key: 'i',
                className: draftInfo.ok ? 'pbrx_hint' : 'pbrx_warn',
              }, draftInfo.text)
              : null,

            h('div', { key: 't2', className: 'pbrx_cardTitle', style: { marginTop: '2px' } }, [
              h('span', { key: 'l' }, '③ 给生图模型的材质描述'),
              h('span', { key: 'h', className: 'pbrx_sub' }, '英文 · 颜色 + 基底 + 磨损 · 可手改'),
            ]),
            h('textarea', {
              key: 'm',
              className: 'pbrx_textarea',
              style: { minHeight: '78px' },
              value: material,
              placeholder: 'e.g. weathered orange-red enamel paint on metal, chipped and scratched revealing pale grey primer, dust and grime, matte aged finish',
              onChange: function (e) { setMaterial(e.target.value) },
            }),
            h('div', { key: 'p', className: 'pbrx_chips' }, PRESETS.map(function (p) {
              return h('button', { key: p.label, className: 'pbrx_chip', onClick: function () { setMaterial(p.text) } }, p.label)
            })),
            cjkInMaterial
              ? h('div', { key: 'w', className: 'pbrx_warn' }, '这一栏是直接喂给 FLUX 的，中文基本无效——先让上面的模型看图写，或者把那句话丢给对话里的我。')
              : null,
          ])

          // Output location, naming, advanced params and the run button are
          // mode-independent — a direct run still needs a folder. Only ② and ③
          // (the prompt) belong to generate mode.
          var setupCol = h('div', { className: 'pbrx_card' }, [
            h('div', { key: 'o', className: 'pbrx_field' }, [
              h('span', { key: 'l', className: 'pbrx_label' }, '④ 输出文件夹'),
              h('div', { key: 'r', className: 'pbrx_row' }, [
                h('input', {
                  key: 'i',
                  className: 'pbrx_input',
                  value: outDir,
                  placeholder: '留空 = 当前工作区 /pbr-materials',
                  onChange: function (e) { setOutDir(e.target.value) },
                }),
                h('button', { key: 'b', className: 'pbrx_btn', onClick: chooseDir }, '选择…'),
              ]),
            ]),
            h('div', { key: 'nm', className: 'pbrx_field' }, [
              h('span', { key: 'l', className: 'pbrx_label' }, '资产命名（每套材质自动一个文件夹）'),
              h('div', { key: 'r', className: 'pbrx_row' }, [
                h('input', {
                  key: 'c',
                  className: 'pbrx_input',
                  placeholder: '资源类别  Military',
                  value: category,
                  onChange: function (e) { setCategory(e.target.value) },
                }),
                h('input', {
                  key: 'n',
                  className: 'pbrx_input',
                  placeholder: '资源名称  SandBag',
                  value: assetName,
                  onChange: function (e) { setAssetName(e.target.value) },
                }),
                h('input', {
                  key: 'v',
                  className: 'pbrx_input',
                  style: { maxWidth: '84px' },
                  placeholder: '01',
                  value: version,
                  onChange: function (e) { setVersion(e.target.value) },
                }),
              ]),
            ]),
            namingPlan
              ? h('div', { key: 'plan', className: 'pbrx_plan' }, [
                h('div', { key: 'f', className: 'pbrx_path' }, (outDir.trim() || 'pbr-materials') + '\\' + namingPlan.folder + '\\'),
                h('div', { key: 'l' }, namingPlan.files.map(function (f) { return f.name }).join('\n')),
                packEnabled && namingPlan.packed.length
                  ? h('div', { key: 'p', className: 'pbrx_sub' }, '合图：' + namingPlan.packed.map(function (p) { return p.name }).join('  '))
                  : null,
              ])
              : h('div', { key: 'planHint', className: 'pbrx_hint' },
                '留空 = 按任务名建文件夹（不走资产命名）。填了类别和名称就会用 T_类别_名称_版本_后缀 这套命名。'),
            h('label', { key: 'pk', className: 'pbrx_row', style: { fontSize: '11.5px' } }, [
              h('input', {
                key: 'c',
                type: 'checkbox',
                checked: packEnabled,
                disabled: !namingPlan,
                onChange: function (e) { setPackEnabled(e.target.checked) },
              }),
              h('span', { key: 't' }, '输出合图 _CA（固有色+AO）/ _CH（固有色+高度）/ _NRM（法线RG+粗糙度B+金属度A），8-bit'),
            ]),
            h('div', { key: 'a', className: 'pbrx_adv' }, [
              h('button', { key: 'd', className: 'pbrx_disclosure', onClick: function () { setAdvOpen(!advOpen) } },
                (advOpen ? '▾ ' : '▸ ') + '高级参数'),
              advOpen ? h('div', { key: 'g', className: 'pbrx_params' }, [
                h('label', { key: 'size', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '尺寸 (px)'),
                  h('input', { className: 'pbrx_input', type: 'number', step: 64, min: 256, max: 2048, value: size, onChange: function (e) { setSize(e.target.value) } }),
                ]),
                h('label', { key: 'steps', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '步数'),
                  h('input', { className: 'pbrx_input', type: 'number', min: 4, max: 60, value: steps, onChange: function (e) { setSteps(e.target.value) } }),
                ]),
                h('label', { key: 'cfg', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, 'CFG'),
                  h('input', { className: 'pbrx_input', type: 'number', step: 0.5, min: 1, max: 12, value: cfgScale, onChange: function (e) { setCfgScale(e.target.value) } }),
                ]),
                h('label', { key: 'seed', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '种子 (0=随机)'),
                  h('input', { className: 'pbrx_input', type: 'number', min: 0, value: seed, onChange: function (e) { setSeed(e.target.value) } }),
                ]),
                h('label', { key: 'cm', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '调色方式'),
                  h('select', { className: 'pbrx_select', value: cmMode, onChange: function (e) { setCmMode(e.target.value) } }, [
                    h('option', { key: 'hue', value: 'hue' }, 'hue 色相选择性（推荐）'),
                    h('option', { key: 'reinhard', value: 'reinhard' }, 'reinhard 逐通道（会染中性色）'),
                    h('option', { key: 'off', value: 'off' }, 'off 不调色'),
                  ]),
                ]),
                h('label', { key: 'cms', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '调色强度'),
                  h('input', { className: 'pbrx_input', type: 'number', step: 0.1, min: 0, max: 1, value: cmStrength, onChange: function (e) { setCmStrength(e.target.value) } }),
                ]),
                h('label', { key: 'met', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '金属度'),
                  h('input', { className: 'pbrx_input', type: 'number', step: 0.1, min: 0, max: 1, value: metallic, onChange: function (e) { setMetallic(e.target.value) } }),
                ]),
                h('label', { key: 'rough', className: 'pbrx_field' }, [
                  h('span', { className: 'pbrx_label' }, '基准粗糙度'),
                  h('input', { className: 'pbrx_input', type: 'number', step: 0.05, min: 0, max: 1, value: baseRoughness, onChange: function (e) { setBaseRoughness(e.target.value) } }),
                ]),
              ]) : null,
              h('div', { key: 'kh', className: 'pbrx_hint' }, '金属度无法从单张 2D 图推断，只能由你给；粗糙度是由细节能量派生的近似。'),
              advOpen ? h('label', { key: 'keep', className: 'pbrx_row', style: { fontSize: '11.5px' } }, [
                h('input', { key: 'c', type: 'checkbox', checked: keepInstance, onChange: function (e) { setKeepInstance(e.target.checked) } }),
                h('span', { key: 't' }, '跑完保留自起的 ComfyUI 实例（省下次加载时间，但一直占约 5 GB 显存）'),
              ]) : null,
            ]),
            h('div', { key: 'go', className: 'pbrx_row' }, [
              h('button', {
                className: 'pbrx_btn pbrx_btnPrimary',
                disabled: busy === 'generate' || running || drafting,
                onClick: generate,
              }, busy === 'generate' ? '提交中…'
                : running ? '生成中…'
                  : mode === 'direct' ? '直接推导 PBR 贴图集（约 3 秒）' : '生成 PBR 贴图集'),
              image ? h('button', { key: 'c', className: 'pbrx_btn', onClick: function () { setImage(null) } }, '换一张') : null,
            ]),
            h('div', { key: 'hint', className: 'pbrx_hint' },
              mode === 'direct'
                ? '直通模式：照片原样当作 albedo，只做平铺和推导。不需要描述，也不会有一个字被编造进贴图。'
                : material.trim()
                  ? '③ 里已经有描述，生成会直接用它。'
                  : '③ 空着也没关系：点生成会先让模型看图写描述，再跑管线。'),
          ])

          /* ---------- progress ---------- */
          var progress = null
          if (job) {
            var phaseText = { queued: '排队', starting: '准备', edit: '① 指令编辑（GPU）', color: '② 调色', pbr: '③ 平铺 + 推导 PBR', done: '完成', error: '失败' }[job.phase] || job.phase
            progress = h('div', { className: 'pbrx_card' }, [
              h('div', { key: 't', className: 'pbrx_cardTitle' }, [
                h('span', { key: 'l' }, '进度 · ' + phaseText),
                h('span', { key: 'd', className: 'pbrx_sub pbrx_mono' }, fmtDuration(job.elapsedMs)),
              ]),
              job.error ? h('div', { key: 'e', className: 'pbrx_toast pbrx_toastErr' }, job.error) : null,
              h('pre', { key: 'l', className: 'pbrx_log' }, (job.log || []).join('\n') || '（等待日志…）'),
            ])
          }

          /* ---------- results ---------- */
          var results = null
          if (result) {
            var tiles = MAP_ORDER.filter(function (k) { return result.maps[k] }).map(function (k) {
              var m = metricsByKey[k]
              var v = m ? verdictOf(m) : null
              return h('div', { key: k, className: 'pbrx_tile' }, [
                h('img', {
                  key: 'i',
                  className: 'pbrx_tileImg',
                  src: fileUrl(result.maps[k]),
                  alt: k,
                  onClick: function () { setZoom(fileUrl(result.maps[k])) },
                }),
                h('div', { key: 'n', className: 'pbrx_tileName' }, [
                  h('span', { key: 'a' }, k),
                  m ? h('span', {
                    key: 'b',
                    className: v === 'pass' ? 'pbrx_pass' : v === 'veto' ? 'pbrx_veto' : 'pbrx_fail',
                    title: v === 'veto' ? '主判据通过，只有单像素否决线触发' : '',
                  }, v === 'pass' ? 'PASS' : v === 'veto' ? 'veto' : 'FAIL') : null,
                ]),
                m ? h('div', { key: 'm', className: 'pbrx_tileMeta' },
                  m.file_bits + 'bit · ratio ' + m.wrap_ratio + (m.hard_seam ? ' · max ' + m.wrap_max : '')) : null,
              ])
            })
            var vetoes = (result.metrics && result.metrics.maps ? result.metrics.maps : []).filter(function (m) { return verdictOf(m) === 'veto' })
            var unstable = (result.metrics && result.metrics.maps ? result.metrics.maps : []).filter(function (m) { return m.wrap_max > 0.32 && m.wrap_max <= 0.5 })
            results = h('div', { className: 'pbrx_card' }, [
              h('div', { key: 't', className: 'pbrx_cardTitle' }, [
                h('span', { key: 'l' }, '⑤ 结果 · ' + Object.keys(result.maps).length + ' 张贴图'),
                h('span', { key: 'd', className: 'pbrx_sub pbrx_mono' },
                  '编辑 ' + fmtDuration(result.timings.editMs) + ' · PBR ' + fmtDuration(result.timings.pbrMs) + ' · 合计 ' + fmtDuration(result.timings.totalMs)),
              ]),
              h('div', { key: 'p', className: 'pbrx_path' }, result.outDir),
              h('div', { key: 'r', className: 'pbrx_row' }, [
                h('button', { key: 'o', className: 'pbrx_btn', onClick: function () { reveal(result.outDir) } }, '打开输出文件夹'),
                h('button', {
                  key: 'c',
                  className: 'pbrx_btn',
                  onClick: function () {
                    try { window.navigator.clipboard.writeText(result.outDir) } catch (e) {}
                  },
                }, '复制路径'),
              ]),
              h('div', { key: 'g', className: 'pbrx_maps' }, tiles),
              result.packed && result.packed.length
                ? h('div', { key: 'pk' }, [
                  h('div', { key: 'l', className: 'pbrx_label', style: { marginBottom: '6px' } }, '合图（8-bit RGBA，按命名规范）'),
                  h('div', { key: 'g', className: 'pbrx_maps' }, result.packed.map(function (p) {
                    return h('div', { key: p.kind, className: 'pbrx_tile' }, [
                      h('img', {
                        key: 'i',
                        className: 'pbrx_tileImg',
                        src: fileUrl(p.path),
                        alt: p.kind,
                        onClick: function () { setZoom(fileUrl(p.path)) },
                      }),
                      h('div', { key: 'n', className: 'pbrx_tileName' }, '合图 ' + p.kind),
                    ])
                  })),
                ])
                : null,
              vetoes.length
                ? h('div', { key: 'v', className: 'pbrx_hint' },
                  vetoes.map(function (m) { return m.key }).join('、') +
                  ' 是「否决线打空枪」：主判据（wrap ≤ 0.02）通过，只有单像素极值 wrap_max 越过了 0.5。wrap_max 是全图极值，pbrlab 自己也说它只做粗暴否决。以 3×3 预览为准。')
                : null,
              unstable.length
                ? h('div', { key: 'u', className: 'pbrx_hint' },
                  unstable.map(function (m) { return m.key }).join('、') +
                  ' 的 wrap_max 贴着否决线：同一份输入同一个 seed 重跑，GPU 的非确定性会让它两侧跳（实测 0.50 / 0.34）。这一档不是稳定判据，以 3×3 预览为准。')
                : null,
              result.metrics && result.metrics.previews && result.metrics.previews.length
                ? h('div', { key: 'pv' }, [
                  h('div', { key: 'l', className: 'pbrx_label', style: { marginBottom: '6px' } }, '3×3 平铺预览（接缝与镜像花纹只能这样看）'),
                  h('div', { key: 'r', className: 'pbrx_row' }, result.metrics.previews.map(function (p) {
                    return h('img', {
                      key: p,
                      className: 'pbrx_preview',
                      src: fileUrl(p),
                      alt: 'tiled preview',
                      onClick: function () { setZoom(fileUrl(p)) },
                    })
                  })),
                ])
                : null,
              result.metrics && result.metrics.normal
                ? h('div', { key: 'nm', className: 'pbrx_hint' },
                  '法线：|n| 均值 ' + result.metrics.normal.mean_length + '，unit_frac ' + result.metrics.normal.unit_frac + '，min Z ' + result.metrics.normal.min_z + ' → ' + (result.metrics.normal.pass ? 'PASS' : 'FAIL'))
                : null,
              h('div', { key: 'w', className: 'pbrx_hint' }, '数字好看不等于图好看：wrap_ratio 通过只说明边界与内部统计上无差别，MakeSeamless 的镜像花纹它是看不见的——请看一眼上面的预览。'),
            ])
          }

          var history = jobs.length
            ? h('div', { className: 'pbrx_card' }, [
              h('div', { key: 't', className: 'pbrx_cardTitle' }, '本次会话的生成记录'),
              h('div', { key: 'l', className: 'pbrx_jobsList' }, jobs.map(function (j) {
                return h('div', {
                  key: j.id,
                  className: 'pbrx_jobRow' + (job && job.id === j.id ? ' pbrx_jobRowActive' : ''),
                  onClick: function () {
                    fetch(API + '/job?id=' + encodeURIComponent(j.id), { cache: 'no-store' })
                      .then(function (r) { return r.json() })
                      .then(setJob)
                      .catch(function () {})
                  },
                }, [
                  h('span', {
                    key: 's',
                    className: 'pbrx_badge ' + (j.state === 'done' ? 'pbrx_badge_ok' : j.state === 'error' ? 'pbrx_badge_bad' : 'pbrx_badge_plain'),
                  }, j.state === 'done' ? '完成' : j.state === 'error' ? '失败' : '进行中'),
                  h('span', { key: 'm', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.material),
                  h('span', { key: 'd', className: 'pbrx_sub pbrx_mono' }, fmtDuration(j.elapsedMs)),
                ])
              })),
            ])
            : null

          return h('div', { className: 'pbrx_root' }, [
            h('div', { key: 'h', className: 'pbrx_head' }, [
              h('span', { key: 't', className: 'pbrx_title' }, 'PBR 材质工作台'),
              h('span', { key: 's', className: 'pbrx_sub' }, '参考图 → 可平铺贴图集（FLUX.2 Klein 指令编辑 + 确定性 PBR 推导，全本地）'),
            ]),
            h('div', { key: 'b' }, bar),
            banner,
            h('div', { key: 'c', className: 'pbrx_cols' }, [
              imageCol,
              h('div', { key: 'r', style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } }, [
                formCol,
                intentCol,
                setupCol,
              ]),
            ]),
            progress,
            results,
            history,
            zoom ? h('div', { key: 'z', className: 'pbrx_lightbox', onClick: function () { setZoom(null) } },
              h('img', { className: 'pbrx_lightboxImg', src: zoom, alt: 'preview' })) : null,
          ])
        }

        /* ------------------------------------------------------------------ */
        /* sidebar icon                                                        */
        /* ------------------------------------------------------------------ */

        function PanelIcon(props) {
          var s = (props && props.size) || 18
          var active = !!(props && props.active)
          return h('svg', {
            className: 'pbrx_icon',
            width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 2 : 1.7,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }, [
            h('path', { key: 'a', d: 'M4 7.5 12 4l8 3.5-8 3.5-8-3.5Z' }),
            h('path', { key: 'b', d: 'M4 12.5 12 16l8-3.5' }),
            h('path', { key: 'c', d: 'M4 17 12 20.5 20 17' }),
          ])
        }

        /* ------------------------------------------------------------------ */
        /* plugin                                                              */
        /* ------------------------------------------------------------------ */

        var inject = ['slots']

        function apply(ctx) {
          hostCtx = ctx
          // sidebar.panellist ids address the matching `main` key, so the two
          // registrations below are one feature: icon + panel.
          var registered = []
          ctx.slots.inject('sidebar.panellist', function () {
            var dispose = ctx.slots.register(
              { name: 'sidebar.panellist', id: 'pbr-material', order: 20, label: 'PBR 材质' },
              PanelIcon,
            )
            registered.push('sidebar.panellist')
            beacon('registered', { slot: 'sidebar.panellist' })
            return function () { dispose() }
          })
          ctx.slots.inject('main', function () {
            var dispose = ctx.slots.register({ name: 'main', key: 'pbr-material' }, Workbench)
            registered.push('main')
            beacon('registered', { slot: 'main' })
            return function () { dispose() }
          })
          beacon('applied', { inject: inject })
          void registered
        }

        exports.apply = apply
        exports.inject = inject
        beacon('factory', { ok: true, api: API, origin: pageOrigin })
        return module.exports
        },
      })
    } catch (error) {
      beacon('boot-error', String((error && error.message) || error))
    }
  }
  boot()
})()
