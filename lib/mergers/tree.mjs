// lib/mergers/tree.mjs — 目录树三方合并（纯函数，零依赖）。
//
// 用于 skills/ 这类"目录整体"分区。输入是三张表 Map<rel, {data:Buffer, mtimeMs:number}>。
// 规则（research/文件同步算法选型预研.md §3.5）：
//   并集遍历；仅一侧有 → 取之（远端新增/本地新增都算增量）；
//   双侧有且相等 → 取 ours；
//   双侧不等且无 base → LWW 兜底（mtime 大者胜；相等时设备 ID 小者胜 = Syncthing tiebreak）；
//   双侧不等且有 base → 先试文本行级三方；失败再 LWW。
// 删除语义：本地删 + 远端未改 → 跟随删除；本地删 + 远端改 → 保远端（保守，
// 不因本地一次误删就丢远端内容）；远端删 + 本地改 → 保本地 + 记冲突。

import { CONFLICT_NAME_RE } from '../constants.mjs'
import { toBuffer } from './keepboth.mjs'

/** 14 位 UTC 戳（与 fork 命名同口径）。 */
function stamp14(now) {
  return new Date(now).toISOString().replaceAll(/[-:T.]/gu, '').slice(0, 14)
}

/**
 * 冲突副本名：`<base>.conflict-<14位UTC>-<device8>`。
 * @param {string} rel - 原相对路径。
 * @param {string} deviceId - 设备 ID。
 * @param {number} [now] - epoch ms。
 * @returns {string}
 */
export function conflictName(rel, deviceId, now = Date.now()) {
  return `${rel}.conflict-${stamp14(now)}-${String(deviceId).slice(0, 8)}`
}

/**
 * LWW 裁决（last-writer-wins 的确定性版本）。
 * mtime 大者胜；mtime 相等 → 设备 ID 字典序小者胜（避免两端各自裁决出相反结果）。
 * @param {{data: Buffer, mtimeMs: number}} o - 本地条目。
 * @param {{data: Buffer, mtimeMs: number}} t - 远端条目。
 * @param {string} devO - 本地设备 ID。
 * @param {string} devT - 远端设备 ID。
 * @returns {'ours'|'theirs'}
 */
export function lwwPick(o, t, devO, devT) {
  const mo = Number(o?.mtimeMs ?? 0)
  const mt = Number(t?.mtimeMs ?? 0)
  if (mo !== mt) return mo > mt ? 'ours' : 'theirs'
  return String(devO) <= String(devT) ? 'ours' : 'theirs'
}

/**
 * 简单行级三方合并（仅用于文本；二进制直接判失败走 LWW）。
 * 策略：以 base 为基准，取"双方新增行"的并集（按各自顺序拼接）。
 * 这是保守近似 —— 真正的行级 diff3 复杂度不值（载荷 122KB），失败即 LWW。
 * @param {Buffer|undefined} base
 * @param {Buffer} ours
 * @param {Buffer} theirs
 * @returns {Buffer|null} 合并结果 或 null（无法自动合并）。
 */
export function tryLineMerge(base, ours, theirs) {
  // 二进制闸：含 NUL 字节即视为二进制，绝不按行处理。
  const hasNul = (b) => b !== undefined && b.includes(0)
  if (hasNul(base) || hasNul(ours) || hasNul(theirs)) return null

  // 拆行并去掉尾部单个空元素（'a\n'.split('\n') = ['a',''] —— 那个空元素
  // 只表示"文件以换行结尾"，不是一行内容；留着会破坏前缀判据）。
  const split = (b) => {
    const s = b === undefined ? '' : b.toString('utf8')
    const arr = s.split('\n')
    if (arr[arr.length - 1] === '') arr.pop()
    return { arr, endsWithNewline: b !== undefined && s.endsWith('\n') }
  }
  const b0 = split(base)
  const o0 = split(ours)
  const t0 = split(theirs)

  // 仅支持"纯追加"形态（base 是两侧前缀）—— 与 keepboth 的 append-both 同判据。
  // 行元素来自 split('\n') ⇒ 自身不含 '\n' ⇒ join 比较与逐元素比较等价。
  const startsWith = (whole, prefix) => whole.slice(0, prefix.length).join('\n') === prefix.join('\n')
  if (startsWith(o0.arr, b0.arr) && startsWith(t0.arr, b0.arr)) {
    const oTail = o0.arr.slice(b0.arr.length)
    const tTail = t0.arr.slice(b0.arr.length)
    // 两侧尾部相同 → 不重复拼接。
    if (oTail.join('\n') === tTail.join('\n')) return Buffer.from(ours === undefined ? '' : ours)
    const joined = [...b0.arr, ...oTail, ...tTail].join('\n')
    const trailing = o0.endsWithNewline || t0.endsWithNewline || b0.endsWithNewline ? '\n' : ''
    return Buffer.from(joined + trailing, 'utf8')
  }
  return null
}

/**
 * 目录树三方合并。
 * @param {object} input
 * @param {Map<string, {data: Buffer, mtimeMs: number}>} [input.base]
 * @param {Map<string, {data: Buffer, mtimeMs: number}>} input.ours
 * @param {Map<string, {data: Buffer, mtimeMs: number}>} input.theirs
 * @param {string} [input.deviceId] - 本地设备 ID。
 * @param {string} [input.remoteDeviceId] - 远端设备 ID。
 * @param {number} [input.now] - epoch ms（注入可测性）。
 * @returns {{files: Map<string, {data: Buffer, mtimeMs: number}>, forks: Array<{rel, data}>, conflicts: Array<{rel, reason}>, adopted: string[], kept: string[]}}
 */
export function mergeTree(input) {
  const base = input.base ?? new Map()
  const ours = input.ours ?? new Map()
  const theirs = input.theirs ?? new Map()
  const devO = input.deviceId ?? 'localdev'
  const devT = input.remoteDeviceId ?? 'remotedev'
  const now = input.now ?? Date.now()

  const files = new Map()
  const forks = []
  const conflicts = []
  const adopted = []
  const kept = []

  const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])
  for (const rel of keys) {
    // 绝不把上一次的冲突副本再当输入合并（否则冲突副本会无限衍生）。
    if (CONFLICT_NAME_RE.test(rel)) { files.set(rel, ours.get(rel) ?? theirs.get(rel)); continue }

    const b = base.get(rel)
    const o = ours.get(rel)
    const t = theirs.get(rel)

    // 单侧有内容（另一侧删除/无）。两侧语义对称，只差"谁的内容被保留"：
    //   与 base 相等 → 跟随删除（删除优先）
    //   与 base 不等 → 保留 + 记冲突（绝不因对端一次删除就丢内容）
    //   base 缺失     → 纯新增，保留且不算冲突
    if (o === undefined || t === undefined) {
      if (o === undefined && t === undefined) continue
      const local = o !== undefined
      const survivor = local ? o : t
      if (b !== undefined && survivor.data.equals(b.data)) continue
      files.set(rel, survivor)
      if (local) kept.push(rel)
      else adopted.push(rel)
      if (b !== undefined) conflicts.push({ rel, reason: local ? 'remote-deleted-local-modified' : 'local-deleted-remote-modified' })
      continue
    }

    if (o.data.equals(t.data)) { files.set(rel, o); continue }
    if (b !== undefined && o.data.equals(b.data)) { files.set(rel, t); adopted.push(rel); continue }
    if (b !== undefined && t.data.equals(b.data)) { files.set(rel, o); kept.push(rel); continue }

    // 双侧都改且不等：先试行级三方（仅纯追加），失败走 LWW + 冲突副本。
    const merged = b === undefined ? null : tryLineMerge(b.data, o.data, t.data)
    if (merged !== null) {
      // mtime 缺失按 0 处理（与 lwwPick 同口径）—— 否则 Math.max(undefined,…) = NaN，
      // 会随合并结果写进索引/状态并在后续比较里扩散。
      files.set(rel, { data: merged, mtimeMs: Math.max(Number(o.mtimeMs ?? 0), Number(t.mtimeMs ?? 0)) })
      kept.push(rel)
      continue
    }
    const winner = lwwPick(o, t, devO, devT)
    const loser = winner === 'ours' ? t : o
    files.set(rel, winner === 'ours' ? o : t)
    // fork 名必须标**输家**（= 副本字节的主人）的设备：标成远端设备会让
    // "本地落败"的副本被冠上远端 ID，同一分歧在两台机器上落到不同路径、
    // 各自写各自的内容，永远不收敛。
    forks.push({ rel: conflictName(rel, winner === 'ours' ? devT : devO, now), data: loser.data })
    conflicts.push({ rel, reason: `lww-${winner}` })
    if (winner === 'ours') kept.push(rel)
    else adopted.push(rel)
  }

  return { files, forks, conflicts, adopted, kept }
}

/**
 * Merger 接口实现（SECTION_MERGER.tree）。
 * 单路径视角：tree 合并天然是批量的，单路径调用走同一套规则。
 * @param {object} input - { base?, ours?, theirs?, path, deviceId?, remoteDeviceId?, now? }。
 */
export function merge(input) {
  const { base, ours, theirs, path } = input
  const one = (buf, mtime) => {
    const e = buf === undefined || buf === null ? undefined : { data: toBuffer(buf), mtimeMs: mtime ?? 0 }
    return new Map(e === undefined ? [] : [[path, e]])
  }
  const result = mergeTree({
    base: one(base, 0), ours: one(ours, input.oursMtimeMs ?? 0), theirs: one(theirs, input.theirsMtimeMs ?? 0),
    deviceId: input.deviceId, remoteDeviceId: input.remoteDeviceId, now: input.now,
  })
  const file = result.files.get(path)
  if (file === undefined) return { kind: 'keep-ours', delete: true }
  if (result.forks.length > 0) {
    return { kind: 'conflict', keepOurs: true, data: file.data, forks: result.forks, note: result.conflicts[0]?.reason }
  }
  return { kind: ours !== undefined && file.data.equals(toBuffer(ours)) ? 'keep-ours' : 'take-theirs', data: file.data }
}
