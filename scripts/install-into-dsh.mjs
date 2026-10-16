#!/usr/bin/env node
/**
 * Install dsh-pbr-material into a DeepSeek Harness profile.
 *
 * Node, not PowerShell, on purpose: on this machine Group Policy forces
 * RemoteSigned and **overrides even `-ExecutionPolicy Bypass`**, so an unsigned
 * .ps1 simply will not run (the original research hit the same wall and noted it
 * in download_recommended.py). Node is guaranteed to be present — DSH is a Node
 * application — and is not subject to execution policy.
 *
 *   node scripts/install-into-dsh.mjs [--profile desktop] [--profile-dir PATH] [--dry-run] [--force]
 *
 * It does exactly two things, because both are required:
 *   1. link this folder into <profile>/node_modules/dsh-pbr-material
 *   2. register it in <profile>/package.json (dsh.profile.bundles + dependencies)
 *
 * A path-based `insert` entry is NOT enough: only a bundle is picked up by the
 * client-module scan, so without this the sidebar panel never appears.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, copyFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = 'dsh-pbr-material'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}

const dryRun = flag('dry-run')
const force = flag('force')

const C = { ok: '\u001b[32m', plan: '\u001b[33m', err: '\u001b[31m', dim: '\u001b[90m', head: '\u001b[36m', off: '\u001b[0m' }
const say = (m) => console.log(`       ${m}`)
const dim = (m) => console.log(`${C.dim}       ${m}${C.off}`)
const ok = (m) => console.log(`${C.ok}  ok   ${m}${C.off}`)
const plan = (m) => console.log(`${C.plan}  plan ${m}${C.off}`)
const die = (m) => {
  console.log(`${C.err}ERROR  ${m}${C.off}`)
  process.exit(1)
}

console.log(`\n${C.head}dsh-pbr-material installer${C.off}`)
say(`source : ${repo}`)

if (!existsSync(join(repo, 'index.js'))) {
  die('index.js is not next to scripts/ — run this from the unzipped plugin folder')
}

// --- locate the profile ------------------------------------------------------
function profileDirFromArgs() {
  const explicit = value('profile-dir')
  if (explicit) return resolve(explicit)
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const root = join(dshHome, 'profiles')
  if (!existsSync(root)) die(`no profiles directory at ${root} — install DSH and start it once first`)
  const all = readdirSync(root).filter((n) => existsSync(join(root, n, 'package.json')))
  if (all.length === 0) die(`no profile with a package.json under ${root}`)
  const wanted = value('profile') || process.env.DSH_PROFILE
  if (wanted) {
    if (!all.includes(wanted)) {
      say(`profile '${wanted}' not found; candidates: ${all.join(', ')}`)
    } else {
      return join(root, wanted)
    }
  }
  if (all.length > 1) say(`multiple profiles found, using '${all[0]}' — pass --profile to choose`)
  return join(root, all[0])
}

const profileDir = profileDirFromArgs()
if (!existsSync(profileDir)) die(`profile directory not found: ${profileDir}`)
say(`profile: ${profileDir}`)

const pkgPath = join(profileDir, 'package.json')
if (!existsSync(pkgPath)) die(`no package.json in ${profileDir} — that is not a DSH profile`)

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (error) {
  die(`${pkgPath} is not valid JSON — ${error.message}`)
}

// --- 1. the link -------------------------------------------------------------
const nodeModules = join(profileDir, 'node_modules')
const link = join(nodeModules, BUNDLE)
const changes = []

if (!existsSync(nodeModules)) {
  if (dryRun) plan(`create ${nodeModules}`)
  else {
    mkdirSync(nodeModules, { recursive: true })
    ok(`created ${nodeModules}`)
  }
}

/**
 * What is at `path`, and where does it point?
 *
 * Windows junctions need care: `readlinkSync` is the right call but returns a
 * `\\?\D:\...` path, while `readFileSync` (the trick people use for junctions)
 * throws EPERM on a *directory* link. Getting this wrong does not fail loudly —
 * it silently reports "nothing there", and the next step then dies with EEXIST.
 */
function linkTarget(path) {
  try {
    const st = lstatSync(path)
    if (!st.isSymbolicLink()) return { kind: 'real', path: null }
    let raw = ''
    try {
      raw = readlinkSync(path)
    } catch {
      raw = readFileSync(path, 'utf8') // junction fallback
    }
    const cleaned = String(raw).replace(/\0+$/, '').replace(/^\\\\\?\\/, '').trim()
    const resolved = resolve(dirname(path), cleaned)
    const same = process.platform === 'win32'
      ? resolved.toLowerCase() === resolve(repo).toLowerCase()
      : resolved === resolve(repo)
    return { kind: 'link', path: resolved, same }
  } catch {
    return null
  }
}

const existing = linkTarget(link)
if (existing && existing.kind === 'link' && existing.same) {
  ok(`already linked: ${link} -> ${repo}`)
} else if (existing && !force) {
  say(`existing entry at ${link} (${existing.kind}${existing.path ? ` -> ${existing.path}` : ''})`)
  die(`refusing to replace it. Re-run with --force if that is what you want.`)
} else {
  if (dryRun) {
    plan(`${existing ? 'replace' : 'link'} ${link} -> ${repo}`)
  } else {
    if (existing) rmSync(link, { recursive: true, force: true })
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir')
    ok(`${existing ? 're-linked' : 'linked'} ${link} -> ${repo}`)
  }
}

// --- 2. register the bundle --------------------------------------------------
const profile = (pkg.dsh ??= {})
profile.profile ??= {}
const bundles = (profile.profile.bundles ??= [])
if (bundles.includes(BUNDLE)) {
  ok('already in dsh.profile.bundles')
} else {
  changes.push('dsh.profile.bundles')
}
const deps = (pkg.dependencies ??= {})
if (deps[BUNDLE]) {
  ok('already in dependencies')
} else {
  changes.push('dependencies')
}

if (changes.length === 0) {
  console.log('')
  ok('nothing to change.')
} else if (dryRun) {
  for (const c of changes) plan(`add ${BUNDLE} to ${c}`)
  console.log('')
  dim(`would back up ${pkgPath} first`)
} else {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const backup = `${pkgPath}.bak-${stamp}`
  copyFileSync(pkgPath, backup)
  ok(`backed up package.json -> ${backup.split(sep).pop()}`)

  if (!bundles.includes(BUNDLE)) bundles.push(BUNDLE)
  deps[BUNDLE] = `link:${repo}`
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  ok('registered in dsh.profile.bundles and dependencies')
}

console.log(`\n${C.head}Next:${C.off}`)
console.log('  1. restart DeepSeek Harness (host plugin code is loaded once per process)')
console.log('  2. in a chat, say:  看看 PBR 插件的环境')
console.log('     the agent calls pbr_setup_status, then pbr_setup_install to fetch the weights')
console.log('')
if (dryRun) dim('this was a dry run — nothing was written.')
