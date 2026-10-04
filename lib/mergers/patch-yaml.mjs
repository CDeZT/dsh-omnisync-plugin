// lib/mergers/patch-yaml.mjs — cordis.patch.yml 条目级三方合并（纯函数）。
//
// 为什么不能按行合并（实证）：行级合并会产出**重复的 id** —— cordis 加载器
// 对重复 id 的行为未定义；且用户在两台机器上各自新增一个 mcp server 时，
// 行级合并几乎必然错位。
//
// 正确粒度 = **条目 id**：
//   仅一侧新增条目      → 取之（并集 —— 这是"云电脑"最常用的路径）
//   双侧都有同 id 且等   → 取之
//   双侧都有同 id 不等   → 字段级三方（ancestor 为基准），字段冲突才上报
//   一侧删除、一侧未改   → 跟随删除
//   一侧删除、一侧修改   → 保留修改方 + 上报（绝不静默删配置）
//
// 实例字段（端口/坐标/Tailscale 地址等）不硬编码：由调用方经 opts.instanceKeys
// 传入 glob 列表，命中的键在"双侧不等且无 base"时**保本地**（每台机器的实例
// 参数天然不同，不该互相覆盖）。

import { deepEqual } from './equal.mjs'

/** 去行尾注释（不处理引号内的 #，patch 文件不值得为此引依赖）。 */
function stripComment(line) {
  const i = line.indexOf('#')
  if (i < 0 || /["'][^"']*$/u.test(line.slice(0, i))) return line // 引号未闭合 → 视为字符串内的 #
  return line.slice(0, i)
}

/** 预处理：去空行/注释，保留缩进。 */
function tokenize(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const noComment = stripComment(line)
    if (noComment.trim() === '') continue
    out.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim() })
  }
  return out
}

/** 解析一个节点（序列或映射），返回 [value, nextIndex]。 */
function parseNode(lines, i, indent) {
  if (i >= lines.length) return [null, i]
  if (lines[i].indent === indent && lines[i].text.startsWith('-')) return parseSeq(lines, i, indent)
  return parseMap(lines, i, indent)
}

function parseSeq(lines, i, indent) {
  const arr = []
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('-')) {
    const rest = lines[i].text.slice(1).trim()
    if (rest === '') {
      const childIndent = i + 1 < lines.length ? lines[i + 1].indent : indent + 2
      const [child, next] = parseNode(lines, i + 1, childIndent)
      arr.push(child); i = next
    } else if (/^[^:]+:(\s|$)/u.test(rest)) {
      // `- key: value`：把这一行改写为缩进 +2 的映射首行，按映射解析。
      const work = lines.slice()
      work[i] = { indent: indent + 2, text: rest }
      const [child, next] = parseMap(work, i, indent + 2)
      arr.push(child); i = next
    } else {
      arr.push(scalar(rest)); i += 1
    }
  }
  return [arr, i]
}

function parseMap(lines, i, indent) {
  const obj = {}
  while (i < lines.length && lines[i].indent === indent) {
    const t = lines[i].text
    const ci = t.indexOf(':')
    if (ci < 0) { i += 1; continue }
    const key = t.slice(0, ci).trim()
    const valText = t.slice(ci + 1).trim()
    if (valText === '') {
      const hasChild = i + 1 < lines.length && lines[i + 1].indent > indent
      if (!hasChild) { obj[key] = null; i += 1; continue }
      const [child, next] = parseNode(lines, i + 1, lines[i + 1].indent)
      obj[key] = child
      i = next
      continue
    }
    obj[key] = scalar(valText)
    i += 1
  }
  return [obj, i]
}

/**
 * 解析 patch 文件 → 条目列表（只取 `insert` 指令里的条目；`remove` 原样保留）。
 * @param {string} text - YAML 文本。
 * @returns {{entries: Array<object>, removes: string[]}}
 */
export function parsePatchYaml(text) {
  const lines = tokenize(text)
  if (lines.length === 0) return { entries: [], removes: [] }
  const [doc] = parseNode(lines, 0, lines[0].indent)
  const entries = []
  const removes = []
  for (const d of Array.isArray(doc) ? doc : [doc]) {
    if (d === null || typeof d !== 'object') continue
    for (const e of Array.isArray(d.insert) ? d.insert : []) {
      if (e !== null && typeof e === 'object') entries.push({ id: e.id ?? null, name: e.name ?? null, config: e.config ?? {} })
    }
    for (const r of Array.isArray(d.remove) ? d.remove : []) removes.push(typeof r === 'string' ? r : String(r?.id ?? ''))
  }
  return { entries, removes }
}

/** 标量解析（YAML 的一个安全子集；含内联数组）。 */
export function scalar(v) {
  const s = String(v).trim()
  if (s === '') return ''
  // 内联数组（`[a, b]`）——渲染器会产出这种形态，必须能读回。
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map((x) => scalar(x.trim()))
  }
  // 空映射：与 `[]` 同口径 —— 渲染器会产出 `{}`，必须能读回对象而不是字符串。
  if (s === '{}') return {}
  if (s === 'true' || s === 'false') return s === 'true'
  if (s === 'null' || s === '~') return null
  if (/^-?\d+$/u.test(s)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s }
  if (/^-?\d+\.\d+$/u.test(s)) return Number(s)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

/** 标量序列化（保持人类可读；会歧义的字符串必须加引号，保证往返类型保真）。 */
export function serializeScalar(v) {
  if (v === null) return 'null'
  // 防御网：容器不该走到这里（渲染器会递归下钻）。真走到了也必须保真 ——
  // 直接 String(v) 会产出 "[object Object]" 这种静默损坏。
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  const s = String(v)
  if (s === '') return '""'
  // 会被 scalar() 解析成非字符串的形态：数字/布尔/null/空 → 必须引号。
  // （MCP 的 env 值常常是数字形态的字符串，掉了引号就变成 number 了。）
  if (/^-?\d+(?:\.\d+)?$/u.test(s) || /^(?:true|false|null|~)$/u.test(s)) return JSON.stringify(s)
  if (/[:#{}[\],&*?|>!%@`]/u.test(s) || /^\s|\s$/u.test(s)) return JSON.stringify(s)
  return s
}

/** 条目索引：id → 条目（缺失 id 的条目按 name 兜底，再兜底记为 orphan —— 无 id 无法合并）。 */
function indexById(entries) {
  const map = new Map()
  const orphan = []
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e === null || typeof e !== 'object') continue
    const key = e.id ?? e.name
    if (key === null || key === undefined) { orphan.push(e); continue }
    map.set(String(key), e)
  }
  return { map, orphan }
}

/**
 * 条目级三方合并。
 * @param {Array<object>} base - 祖先条目。
 * @param {Array<object>} ours - 本地条目。
 * @param {Array<object>} theirs - 远端条目。
 * @param {object} [opts] - { instanceKeys?: RegExp[] }。
 * @returns {{merged: Array<object>, conflicts: Array, adopted: string[], kept: string[], deleted: string[]}}
 */
export function mergePatchEntries(base, ours, theirs, opts = {}) {
  const B = indexById(base ?? [])
  const O = indexById(ours ?? [])
  const T = indexById(theirs ?? [])
  const instanceKeys = opts.instanceKeys ?? []
  const isInstance = (k) => instanceKeys.some((re) => re.test(k))

  const merged = []
  const conflicts = []
  const adopted = []
  const kept = []
  const deleted = []
  const keys = new Set([...B.map.keys(), ...O.map.keys(), ...T.map.keys()])

  for (const key of keys) {
    const b = B.map.get(key)
    const o = O.map.get(key)
    const t = T.map.get(key)

    // 至少一侧缺失。两侧语义对称，只差"谁的改动被保留"（bucket/kind/note 由 local 决定）。
    if (o === undefined || t === undefined) {
      if (o === undefined && t === undefined) { deleted.push(key); continue }
      const local = o !== undefined
      const survivor = local ? o : t
      const bucket = local ? kept : adopted
      if (b === undefined) { merged.push(survivor); bucket.push(key); continue } // 纯新增 → 取之
      if (deepEqual(b, survivor)) { deleted.push(key); continue } // 一侧删、另一侧未改 → 跟随删除
      // 删了又改 → 保改动方 + 上报（绝不静默删配置）。
      merged.push(survivor)
      bucket.push(key)
      conflicts.push({ id: key, kind: local ? 'modify-vs-delete' : 'delete-vs-modify', note: local ? 'local kept (remote deleted a modified entry)' : 'remote kept (local deleted a modified entry)' })
      continue
    }

    // 双侧都有。
    if (deepEqual(o, t)) { merged.push(o); kept.push(key); continue }
    if (b !== undefined && deepEqual(o, b)) { merged.push(t); adopted.push(key); continue }
    if (b !== undefined && deepEqual(t, b)) { merged.push(o); kept.push(key); continue }

    // 双侧都改：字段级合并。
    const entry = { id: o.id ?? t.id, name: o.name ?? t.name, config: {} }
    const baseCfg = b?.config ?? {}
    const put = (k, v) => { if (v !== undefined) entry.config[k] = v }
    for (const ck of new Set([...Object.keys(o.config ?? {}), ...Object.keys(t.config ?? {})])) {
      const bv = baseCfg[ck], ov = o.config?.[ck], tv = t.config?.[ck]
      if (deepEqual(ov, tv)) put(ck, ov)
      else if (b !== undefined && deepEqual(ov, bv)) put(ck, tv)
      else if (b !== undefined && deepEqual(tv, bv)) put(ck, ov)
      // 实例字段（端口/坐标等）：每台机器天然不同 → 保本地，不算冲突。
      else if (isInstance(ck)) put(ck, ov)
      // 真字段冲突：保本地 + 上报（远端值由宿主进隔离区）。
      else { conflicts.push({ id: key, kind: 'field', path: ck, local: ov, remote: tv, ancestor: bv }); put(ck, ov) }
    }
    merged.push(entry)
    kept.push(key)
  }

  // 无 id 的条目（orphan）：没有可三方裁决的键，但**绝不能丢**。
  // indexById 专门把它们收进 orphan 桶就是为了这一步 —— 早先没人消费这个桶，
  // 于是无 id 的条目在合并结果里静默消失，等于从用户的 patch 文件里删掉。
  // 处置：ours+theirs 原样并集保留 + 逐条上报（让用户去补 id）。
  // 去重 = "前面没有等值项"（orphan 没有可比的键，只能按值比）。
  const orphans = [...O.orphan, ...T.orphan].filter((e, i, all) => !all.slice(0, i).some((x) => deepEqual(x, e)))
  for (const e of orphans) {
    merged.push(e)
    conflicts.push({ id: null, kind: 'orphan-entry', note: '条目缺少 id（无法按 id 合并）→ 原样保留，请补 id' })
  }

  return { merged, conflicts, adopted, kept, deleted }
}

/* ── 渲染：递归下钻，产出必须能被本文件的解析器**逐类型读回** ──
 * 标量判据（内联 vs 另起一块）见 inlineOf。
 * 历史实现只支持"两层 + 内联数组"，三层嵌套（config.mcpServers.<name>.command
 * 这种真实形态）会被 String(v) 渲染成 "[object Object]"，嵌套数组更会把内层
 * 逗号暴露给内联数组切分 —— 配置静默损坏，且损坏结果还会被推到所有机器。 */

/** 标量判据（非 null 且非对象）。 */
const isScalar = (v) => v === null || typeof v !== 'object'

/**
 * 单行内联形态；返回 null 表示"必须另起缩进块"。
 * 判据集中在这里，是因为"标量内联 / 容器下钻"在映射与序列里各要判一次 ——
 * 抄两份就会出现"某处漏判 → 产出 [object Object]"。
 */
function inlineOf(v) {
  if (Array.isArray(v)) return v.every(isScalar) ? `[${v.map(serializeScalar).join(', ')}]` : null
  if (isScalar(v)) return serializeScalar(v)
  return Object.keys(v).length === 0 ? '{}' : null
}

/** 渲染映射的键值对（缩进 indent）。 */
function emitMap(out, pairs, indent) {
  const pad = ' '.repeat(indent)
  for (const [k, v] of pairs) {
    const inline = inlineOf(v)
    if (inline !== null) out.push(`${pad}${k}: ${inline}`)
    else { out.push(`${pad}${k}:`); emitBlock(out, v, indent + 2) }
  }
}

/** 渲染一个容器（缩进 indent）：数组走序列，对象走映射。 */
function emitBlock(out, v, indent) {
  if (Array.isArray(v)) { emitSeq(out, v, indent); return }
  emitMap(out, Object.entries(v), indent)
}

/** 渲染序列（缩进 indent）。解析器认三种元素形态：标量、`- k: v` 起头的映射、`-` 后另起一块。 */
function emitSeq(out, arr, indent) {
  const pad = ' '.repeat(indent)
  for (const item of arr) {
    // 嵌套序列保持"`-` 后另起一块"的历史形态（`- [1, 2]` 虽也能读回，但会改 diff）。
    if (Array.isArray(item)) { out.push(`${pad}-`); emitSeq(out, item, indent + 2); continue }
    const inline = inlineOf(item)
    if (inline !== null) { out.push(`${pad}- ${inline}`); continue }
    const [[k0, v0], ...rest] = Object.entries(item)
    // 首键写在 `- ` 之后（解析器会把这一行改写成 indent+2 的映射首行），其余键与它同列。
    const first = inlineOf(v0)
    if (first !== null) out.push(`${pad}- ${k0}: ${first}`)
    else { out.push(`${pad}- ${k0}:`); emitBlock(out, v0, indent + 4) }
    emitMap(out, rest, indent + 2)
  }
}

/**
 * 渲染回 YAML（顶层 `- insert:` / `- remove:` 指令形态，与 DSH 的 patch 文件一致）。
 * @param {Array<object>} entries - insert 条目。
 * @param {string[]} [removes] - remove 指令的条目 id。**必须传**，否则被删的配置会复活。
 */
export function renderPatchYaml(entries, removes = []) {
  const out = ['- insert:']
  emitSeq(out, Array.isArray(entries) ? entries : [], 4)
  const rem = (Array.isArray(removes) ? removes : []).map((id) => `    - id: ${serializeScalar(id)}`)
  if (rem.length > 0) out.push('- remove:', ...rem)
  return out.join('\n') + '\n'
}

/**
 * `remove:` 指令的三方并集（base → ours → theirs 稳定去重）。
 * 为什么单独一个函数：remove 是**指令**不是条目，没有可三方裁决的字段 ——
 * 任何一侧要求移除都必须保留，否则"已删的配置"会在冲突合并后静默复活。
 * @param {string[]} base
 * @param {string[]} ours
 * @param {string[]} theirs
 * @param {string[]} [entryIds] - 合并后 insert 条目的 id（检出互相矛盾的情况）。
 * @returns {{removes: string[], conflicts: Array}}
 */
export function mergeRemoves(base, ours, theirs, entryIds = []) {
  // base → ours → theirs 顺序展开去重（Set 保留首次出现的位置）。
  const removes = [...new Set([base, ours, theirs].filter(Array.isArray).flat().map(String).filter((id) => id !== ''))]
  const insertIds = new Set((Array.isArray(entryIds) ? entryIds : []).map(String))
  const conflicts = removes
    .filter((id) => insertIds.has(id))
    .map((id) => ({ id, kind: 'insert-vs-remove', note: '同一 id 既 insert 又 remove：两条指令都保留，应用顺序由宿主决定' }))
  return { removes, conflicts }
}

/** Merger 接口实现（SECTION_MERGER['patch-yaml']）。 */
export function merge(input, opts = {}) {
  const parse = (buf) => (buf === undefined || buf === null
    ? { entries: [], removes: [] }
    : parsePatchYaml(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)))
  const [b, o, t] = [input.base, input.ours, input.theirs].map(parse)
  const r = mergePatchEntries(b.entries, o.entries, t.entries, opts)
  const rem = mergeRemoves(b.removes, o.removes, t.removes, r.merged.map((e) => e.id))
  const conflicts = [...r.conflicts, ...rem.conflicts]
  const data = Buffer.from(renderPatchYaml(r.merged, rem.removes), 'utf8')
  return conflicts.length > 0
    ? { kind: 'conflict', merged: data, data, conflicts, note: `${conflicts.length} patch conflict(s)` }
    : { kind: 'merged', merged: data, data, conflicts: [] }
}
