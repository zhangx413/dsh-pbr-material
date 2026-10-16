/**
 * Asset naming for a game pipeline.
 *
 * Follows the studio convention in the project's naming sheet:
 *
 *   texture asset   T_<资源类别>_<资源名称>_<NN>_<贴图属性>
 *   example         T_Military_SandBag_01_C / _N / _R / _AO / _M / _H
 *   packed          _CA (base rgb + ao a) · _CH (base rgb + height a)
 *                   _NRM (normal rg + roughness b + metallic a)
 *
 * The suffixes live in config so a convention that differs from this reading can
 * be fixed without touching code, and the panel renders an exact preview of the
 * plan the host will execute.
 */

/** Keep it filesystem-safe without destroying non-ASCII names. */
export function sanitizeToken(value, fallback = '') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 32)
  return cleaned || fallback
}

export const DEFAULT_SUFFIXES = {
  albedo: '_C',
  normal: '_N',
  roughness: '_R',
  ao: '_AO',
  metallic: '_M',
  height: '_H',
  curvature: '_CURV',
}

export const SUFFIX_DESCRIPTIONS = {
  albedo: '固有色 BaseColor',
  normal: '法线 Normal',
  roughness: '粗糙度 Roughness',
  ao: '环境光遮蔽 AO',
  metallic: '金属度 Metallic',
  height: '高度图 Height',
  curvature: '曲率 Curvature（规范里没有，可改）',
}

export const PACKED_KINDS = ['CA', 'CH', 'NRM']

export const PACKED_DESCRIPTIONS = {
  CA: '固有色 RGB + AO Alpha',
  CH: '固有色 RGB + Height Alpha',
  NRM: '法线 RG + 粗糙度 B + 金属度 A',
}

/** `T_Military_SandBag_01`, or null while the user has not filled it in. */
export function buildAssetName(naming = {}) {
  const prefix = naming.prefix === undefined || naming.prefix === null ? 'T_' : String(naming.prefix)
  const category = sanitizeToken(naming.category)
  const name = sanitizeToken(naming.name)
  const version = sanitizeToken(naming.version, '01')
  if (!category || !name) return null
  return `${prefix}${category}_${name}_${version}`
}

/**
 * The complete, exact plan: folder plus every file name.
 * @returns {{assetName:string, folder:string, files:Array<{key:string,suffix:string,name:string,description:string}>, packed:Array<{kind:string,name:string,description:string}>}|null}
 */
export function planNames(naming = {}, suffixes = DEFAULT_SUFFIXES) {
  const assetName = buildAssetName(naming)
  if (!assetName) return null
  const resolved = { ...DEFAULT_SUFFIXES, ...(suffixes ?? {}) }
  const files = Object.keys(DEFAULT_SUFFIXES).map((key) => ({
    key,
    suffix: resolved[key],
    name: `${assetName}${resolved[key]}.png`,
    description: SUFFIX_DESCRIPTIONS[key] ?? key,
  }))
  const packed = PACKED_KINDS.map((kind) => ({
    kind,
    name: `${assetName}_${kind}.png`,
    description: PACKED_DESCRIPTIONS[kind],
  }))
  return { assetName, folder: assetName, files, packed }
}

/** File name for one map, given the plan. */
export function mapFileFor(plan, key) {
  const hit = plan?.files?.find((f) => f.key === key)
  return hit ? hit.name : `${key}.png`
}
