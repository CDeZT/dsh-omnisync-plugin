// lib/mergers/blob.mjs — 内容寻址对象（attachments/v1/objects）的合并语义。
//
// 关键性质：**路径即内容哈希**（`objects/<ab>/<cd...>`）。因此：
//   同路径 ⇒ 内容必然相同（不存在"两边改同一对象"的正常情形）；
//   内容不同 ⇒ 是损坏或哈希碰撞 —— 必须**硬失败**，绝不能静默 keep-both
//   把损坏对象扩散到所有机器。
//
// 引用完整性（"缺引用硬失败"）由 apply 层负责：本模块只管"同名对象内容必须一致"。

import { toBuffer } from './keepboth.mjs'

/** Merger 接口实现（入参 { base?, ours?, theirs?, path }）。 */
export function merge(input) {
  const { path } = input
  // 入参归一：契约不保证是 Buffer，直接 .equals 会 TypeError（与 keepboth 同口径）。
  const ours = toBuffer(input.ours)
  const theirs = toBuffer(input.theirs)
  // 单边存在 → 直接采用存在的一方（新增/删除对象都合法）。
  if (ours === undefined) return { kind: 'take-theirs', note: 'blob-remote-only' }
  if (theirs === undefined) return { kind: 'keep-ours', data: ours, note: 'blob-local-only' }
  if (ours.equals(theirs)) return { kind: 'keep-ours', data: ours, note: 'blob-identical' }
  // 同路径不同内容 = 内容寻址被破坏 → 硬失败（不猜、不 fork、不静默丢）。
  const error = new Error(`content-addressed object '${path}' differs between local and remote (hash collision or corruption)`)
  error.code = 'SNAPSHOT_CORRUPT'
  throw error
}
