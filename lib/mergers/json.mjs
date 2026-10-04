// lib/mergers/json.mjs — JSON 文档 key 级三方合并（纯函数，零依赖）。
//
// 语义来源：research/文件同步算法选型预研.md §3.2（dsh-config-manager
// src/sync/merge.ts:111 mergeJsonSectionGranular 的算法骨架）+ §4 决策。
//
// 核心规则（每个 key 独立裁决，先粗后细）：
//   ours == theirs            → 取之（双方独立改成同值不算冲突）
//   ours == base              → 取 theirs（本地未动）
//   theirs == base            → 取 ours（远端未动）
//   双侧都动且不等            → conflict（上报，绝不猜）
//   present 翻转（增/删）     → 一侧增 → 取之；一侧删一侧改 → conflict
//
// 数组是有序数据：**绝不 union**（union 会产出双方都不认的顺序）。数组整体
// 当标量比较。对象递归下钻，但递归深度有上限（防御恶意深嵌套）。

import { deepEqual } from './equal.mjs'

// 深比较（键序无关，数组序敏感，类型敏感）—— 实现已抽到 equal.mjs 与
// patch-yaml / credentials 共用；此处保留同名导出（既有调用方/test 依赖它）。
export { deepEqual }

/** 键并集（保持 ours 的插入序在前，新增键按 theirs 顺序追加）。 */
export function unionKeys(ours, theirs) {
  const keys = [ours, theirs].filter((s) => s !== null && typeof s === 'object').flatMap((s) => Object.keys(s))
  return [...new Set(keys)]
}

/** 是否纯对象（非 null、非数组）—— 递归下钻的判据。 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 缺失哨兵（区分"键不存在"与"键值为 undefined"）。 */
const MISSING = Symbol('missing')

/** 安全取值：不存在返回 MISSING。 */
function at(obj, key) {
  if (obj === null || typeof obj !== 'object') return MISSING
  return Object.hasOwn(obj, key) ? obj[key] : MISSING
}

/**
 * 递归三方合并。
 * @param {*} base - 共同祖先（可为 undefined：无基线 → 退化为两方，冲突面更大）。
 * @param {*} ours - 本地值。
 * @param {*} theirs - 远端值。
 * @param {object} [opts] - { path?: string, depth?: number, maxDepth?: number }。
 * @returns {{merged: *, conflicts: Array<{path, kind, local, remote, ancestor}>}}
 */
export function mergeJson(base, ours, theirs, opts = {}) {
  const path = opts.path ?? ''
  const depth = opts.depth ?? 0
  const maxDepth = opts.maxDepth ?? 32
  const conflicts = []

  // 深度闸：超限不猜，整体当冲突（防御恶意深嵌套导致栈溢出）。
  if (depth > maxDepth) {
    if (!deepEqual(ours, theirs)) conflicts.push({ path, kind: 'depth-exceeded', local: ours, remote: theirs, ancestor: base })
    return { merged: ours, conflicts }
  }

  // ① 双侧相等 → 取之（无论 base 是什么）。
  if (deepEqual(ours, theirs)) return { merged: ours, conflicts }

  // ② 单侧未动（相对 base）→ 取动的那侧。
  if (deepEqual(ours, base)) return { merged: theirs, conflicts }
  if (deepEqual(theirs, base)) return { merged: ours, conflicts }

  // ③ 双侧都动且不等：纯对象才递归，其余（标量/数组/类型不一致）→ 冲突。
  if (!isPlainObject(ours) || !isPlainObject(theirs)) {
    conflicts.push({ path, kind: 'value', local: ours, remote: theirs, ancestor: base })
    return { merged: ours, conflicts } // 保本地；远端进隔离区（调用方处置）
  }
  const bObj = isPlainObject(base) ? base : {}

  const merged = {}
  for (const key of unionKeys(ours, theirs)) {
    const childPath = path === '' ? key : `${path}.${key}`
    const bv = at(bObj, key)
    const ov = at(ours, key)
    const tv = at(theirs, key)

    const oHas = ov !== MISSING
    const tHas = tv !== MISSING

    // 双侧都在 → 递归（base 缺失传 undefined = "新增"，冲突面更大）。
    if (oHas && tHas) {
      const child = mergeJson(bv === MISSING ? undefined : bv, ov, tv, { path: childPath, depth: depth + 1, maxDepth })
      merged[key] = child.merged
      conflicts.push(...child.conflicts)
      continue
    }
    // 仅本地有：远端删了它。本地 == 祖先 → 跟随删除；否则保本地（真冲突，不静默删）。
    if (oHas && !tHas) {
      if (bv !== MISSING && deepEqual(ov, bv)) continue
      conflicts.push({ path: childPath, kind: 'delete-vs-modify', local: ov, remote: undefined, ancestor: bv === MISSING ? undefined : bv })
      merged[key] = ov
      continue
    }
    // 仅远端有：本地没它。祖先有 = 本地删了它 → 远端未改则跟随删除，改了则报冲突（保删除）。
    if (!oHas && tHas) {
      if (bv === MISSING) { merged[key] = tv; continue } // 纯新增 → 取之
      if (deepEqual(tv, bv)) continue
      conflicts.push({ path: childPath, kind: 'modify-vs-delete', local: undefined, remote: tv, ancestor: bv })
    }
  }
  return { merged, conflicts }
}

/**
 * Merger 接口实现（SECTION_MERGER.json）—— Buffer 进出的包装。
 * 解析失败（任一侧非法 JSON）→ 退化为 keep-both 语义的上报，绝不猜内容。
 * @param {object} input - { base?, ours?, theirs?, path }。
 * @returns {{kind: string, keepOurs?: boolean, merged?: Buffer, data?: Buffer, conflicts?: Array, note?: string}}
 */
export function merge(input) {
  const { base, ours, theirs, path } = input
  const parse = (buf) => {
    if (buf === undefined || buf === null) return { ok: true, value: undefined }
    try { return { ok: true, value: JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)) } } catch { return { ok: false } }
  }
  const b = parse(base)
  const o = parse(ours)
  const t = parse(theirs)
  if (!b.ok || !o.ok || !t.ok) {
    return { kind: 'conflict', keepOurs: true, note: `invalid JSON in ${path} (kept local, remote quarantined)` }
  }
  const { merged, conflicts } = mergeJson(b.value, o.value, t.value, { path })
  // 顶层结果为 undefined = 该文档合并后不存在（本地删除优先 / 两侧都删）。
  // 必须显式表达成"删除"：JSON.stringify(undefined) 返回的是 undefined 本身，
  // 拼上 '\n' 会写出字面量 "undefined"，把一份合法 JSON 变成无法解析的文件。
  if (merged === undefined) return { kind: 'merged', delete: true, conflicts, note: `deleted ${path}` }
  const data = Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return conflicts.length > 0
    ? { kind: 'conflict', merged: data, data, conflicts, note: `${conflicts.length} key conflict(s) in ${path}` }
    : { kind: 'merged', merged: data, data, conflicts: [] }
}
