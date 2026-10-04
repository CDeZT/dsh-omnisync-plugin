// lib/mergers/keepboth.mjs — 字节级 keep-both 三方合并（纯函数，零依赖）。
//
// 语义逐字移植 reference-plugins/dsh-session-sync/lib/merge.mjs（96 行）：
// 会话日志是 append-only，三方（base/ours/theirs）逐文件按字节比较。
// 铁律：**绝不静默覆盖** —— ours 与 theirs 的任何字节都必须存续。
//
// 五分类：
//   identical    两侧相等 → 保留 ours
//   ours-only    仅本地变 → 保留 ours
//   theirs-only  仅远端变 → 采纳 theirs（本地无增量，不是覆盖）
//   append-both  双边纯追加（base 是两侧共同前缀）→ ours 原位 + theirs 转 fork
//   diverged     其余（重写/压缩/删除）→ 同样两边保留 + 响亮报告
//
// 内容按 Buffer 语义比较：zstd 二进制与 UTF-8 文本同一套规则。

import { MERGE_KINDS } from '../constants.mjs'

/**
 * 任意内容形态 → Buffer|undefined。
 * Merger 契约只声明 `{base?, ours?, theirs?}`，不保证调用方一定给 Buffer
 * （git 索引阶段给的是 Buffer，但测试与未来的调用方可能给字符串）。
 * 这是**全部 merger 共用**的归一：blob / tree 也 import 它，别再抄一份。
 */
export function toBuffer(value) {
  if (value === undefined || value === null) return undefined
  if (Buffer.isBuffer(value)) return value
  return Buffer.from(String(value))
}

/** a 是否为 b 的字节前缀（等长即相等；prefix 更长时 subarray 会截短 → equals 自然为假）。 */
function isPrefix(prefix, whole) {
  return prefix !== undefined && whole !== undefined && whole.subarray(0, prefix.length).equals(prefix)
}

/** 两侧同时缺失或字节相等。 */
function equalsOrBothMissing(left, right) {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return left.equals(right)
}

/**
 * 单路径三方分类（纯函数，无副作用）。
 * @returns {{kind: string, keepOurs: boolean, forkTheirs: boolean}}
 */
export function classifyPath(base, ours, theirs) {
  const b = toBuffer(base)
  const o = toBuffer(ours)
  const t = toBuffer(theirs)
  // 两侧相同或都缺 → 无分歧可裁。
  if (equalsOrBothMissing(o, t)) return { kind: MERGE_KINDS.IDENTICAL, keepOurs: true, forkTheirs: false }
  // 仅本地变：远端仍是基点内容。
  if (equalsOrBothMissing(t, b)) {
    return { kind: MERGE_KINDS.OURS_ONLY, keepOurs: true, forkTheirs: false }
  }
  // 仅远端变：本地仍是基点内容 → 采纳远端。
  if (equalsOrBothMissing(o, b)) {
    return { kind: MERGE_KINDS.THEIRS_ONLY, keepOurs: false, forkTheirs: false }
  }
  // 双边纯追加：共同基点前缀 + 各自后缀 → 两边保留，远端转 fork。
  if (isPrefix(b, o) && isPrefix(b, t)) {
    return { kind: MERGE_KINDS.APPEND_BOTH, keepOurs: true, forkTheirs: true }
  }
  // 真实分歧：同样两边保留 + 响亮报告。
  return { kind: MERGE_KINDS.DIVERGED, keepOurs: true, forkTheirs: true }
}

/**
 * fork 文件名：`<basename>.remote-fork-<14位UTC>-<device8>`。
 * 14 位戳 = ISO 串去掉 `-`、`:`、`T`、`.` 后截前 14 位（只去 `-`/`:` 会留 `T` 导致失配）。
 * @param {string} path - 原相对路径。
 * @param {string} deviceId - 8 位设备 ID。
 * @param {number} [now] - epoch ms（注入可测性）。
 * @returns {string} fork 路径。
 */
export function forkName(path, deviceId, now = Date.now()) {
  const stamp = new Date(now).toISOString().replaceAll(/[-:T.]/gu, '').slice(0, 14)
  return `${path}.remote-fork-${stamp}-${String(deviceId).slice(0, 8)}`
}

/**
 * Merger 接口实现（供 SECTION_MERGER 表登记）。
 * ★ 必须把内部五分类归一成**统一 MergeOutcome 词汇**（take-theirs / keep-ours /
 *   conflict）—— 否则调用方按 kind 分派时会漏判「仅远端改」，静默丢掉远端改动。
 * @param {object} input - { base?, ours?, theirs?, path, deviceId?, now? }。
 * @returns {MergeOutcome}
 */
export function merge(input) {
  const { kind, forkTheirs } = classifyPath(input.base, input.ours, input.theirs)
  if (kind === MERGE_KINDS.THEIRS_ONLY) return { kind: 'take-theirs', note: kind }
  if (!forkTheirs) return { kind: 'keep-ours', data: input.ours, note: kind }
  // forkTheirs 恰好等价于"双边都改"（append-both / diverged）→ 冲突 + 远端转 fork。
  return {
    kind: 'conflict', keepOurs: true, data: input.ours, note: kind,
    forkPath: forkName(input.path, input.deviceId ?? 'unknown0', input.now),
  }
}

/**
 * 整批冲突路径的合并计划（pull 阶段对冲突路径逐一调用）。
 * @param {Array<{path, base?, ours?, theirs?}>} conflicts
 * @param {object} [opts] - { deviceId, now }。
 * @returns {{resolutions: Array, summary: {kept, adopted, appended, diverged, forkPaths}}}
 */
export function planMerge(conflicts, opts = {}) {
  const resolutions = []
  const summary = { kept: 0, adopted: 0, appended: 0, diverged: 0, forkPaths: [] }
  for (const entry of conflicts) {
    // 批量分类直接走 classifyPath（保持 MERGE_KINDS 词汇与统计语义）。
    const verdict = classifyPath(entry.base, entry.ours, entry.theirs)
    // classifyPath 只给分类，不产路径 —— fork 路径必须在这里算一次并复用，
    // 否则汇总里报的是原路径（调用方照它去找 fork 文件会找不到）。
    const forkPath = verdict.forkTheirs ? forkName(entry.path, opts.deviceId ?? 'unknown0', opts.now) : undefined
    resolutions.push({ path: entry.path, kind: verdict.kind, adoptTheirs: !verdict.keepOurs, forkTheirs: verdict.forkTheirs, forkPath })
    summary[verdict.kind === MERGE_KINDS.THEIRS_ONLY ? 'adopted' : 'kept'] += 1
    if (verdict.kind === MERGE_KINDS.APPEND_BOTH) summary.appended += 1
    else if (verdict.kind === MERGE_KINDS.DIVERGED) summary.diverged += 1
    if (forkPath !== undefined) summary.forkPaths.push(forkPath)
  }
  return { resolutions, summary }
}
