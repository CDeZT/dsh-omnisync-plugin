// lib/conflicts.mjs — 冲突裁决：git 索引三阶段 → 分区策略 → 写回工作树。
//
// 时机：git merge 报冲突后，逐路径读 stage 1/2/3（base/ours/theirs），按该
// 路径所属分区的合并器裁决，再把结果落回工作树并 add（让 git 完成合并提交）。
//
// 语义要点：**只有 git 报冲突的路径才走这里** —— 无冲突路径由 git 自己合并。
// 这正是"用 git 当合并引擎"的收益：我们把复杂度压到只剩分歧处理。

import { parsePatchYaml, renderPatchYaml, mergePatchEntries, mergeRemoves } from './mergers/patch-yaml.mjs'
import { mergeCredentials, snapshotOf } from './mergers/credentials.mjs'
import { mergerFor } from './mergers/index.mjs'
import { parseCredYaml, renderCredYaml } from './credyaml.mjs'
import { SECTION_BY_ID } from './sections.mjs'

/** patch 文件里的实例字段（每台机器天然不同，冲突时保本地）。 */
const INSTANCE_KEYS = [/^(?:port|wsPort|listen)$/u]

/**
 * 按分区裁决一个冲突路径。分区 → 合并器的映射由 sections.mjs 注册表决定
 * （新增分区只需改注册表，不动本文件）。
 * @param {object} input - { sectionId, base, ours, theirs, path, deviceId }。
 * @returns {{kind: string, data?: Buffer, forkPath?: string, note?: string}}
 */
export function resolveOne(input) {
  const { base, ours, theirs, sectionId } = input
  const merger = SECTION_BY_ID.get(sectionId)?.merger
  if (merger === 'credentials') return creds(base, ours, theirs, input.tombstones, input.now)
  if (merger === 'patch-yaml') return patch(base, ours, theirs)
  return mergerFor(merger ?? 'keepboth').merge({ base, ours, theirs, path: input.path, deviceId: input.deviceId })
}

/**
 * 凭据：记录级三方合并（生态空白能力）。
 * 顺带算出**本轮消失的键** —— 调用方据此记墓碑（合并基点丢失时防删除复活）。
 * @param {Buffer|undefined} base
 * @param {Buffer|undefined} ours
 * @param {Buffer|undefined} theirs
 * @param {object} [tombstones] - 现有墓碑（键 → {at}）。
 * @param {number} [now] - epoch ms（墓碑判定用）。
 */
function creds(base, ours, theirs, tombstones, now) {
  // snapshotOf 三种形态都认 ⇒ 解析结果（[k,v] 数组）可直传，省掉 fromEntries/entries 往返。
  const parse = (buf) => snapshotOf(buf === undefined ? undefined : parseCredYaml(buf.toString('utf8')))
  const baseSnap = parse(base)
  // 墓碑键格式由合并器约定：`ref:<key>` / `rec:<key>`（见 credentials.mjs）。
  const { merged, report } = mergeCredentials(baseSnap, parse(ours), parse(theirs), {
    tombstones: new Map(Object.entries(tombstones ?? {})),
    now,
  })
  // base 里有、结果里没有 = 被删掉了 → 记墓碑（防基点丢失时复活）。
  const gone = (snap, out, prefix) => [...snap.keys()].filter((k) => !out.has(k)).map((k) => `${prefix}${k}`)
  const deleted = [...gone(baseSnap.refs, merged.refs, 'ref:'), ...gone(baseSnap.records, merged.records, 'rec:')]
  return {
    kind: report.conflicts.length > 0 ? 'conflict' : 'merged',
    data: Buffer.from(renderCredYaml(merged), 'utf8'),
    deleted,
    note: `${report.adopted.length} adopted / ${report.kept.length} kept / ${report.conflicts.length} conflict`,
  }
}

/** patch：条目 id 级合并 + 实例字段保本地 + remove 指令并集保留。 */
function patch(base, ours, theirs) {
  const parse = (buf) => (buf === undefined
    ? { entries: [], removes: [] }
    : parsePatchYaml(buf.toString('utf8')))
  const b = parse(base)
  const o = parse(ours)
  const t = parse(theirs)
  const r = mergePatchEntries(b.entries, o.entries, t.entries, { instanceKeys: INSTANCE_KEYS })
  // remove 是指令：漏掉它 = 被删的配置在冲突合并后复活。
  const rem = mergeRemoves(b.removes, o.removes, t.removes, r.merged.map((e) => e.id))
  const conflicts = [...r.conflicts, ...rem.conflicts]
  return {
    kind: conflicts.length > 0 ? 'conflict' : 'merged',
    data: Buffer.from(renderPatchYaml(r.merged, rem.removes), 'utf8'),
    note: `${r.adopted.length} adopted / ${conflicts.length} conflict`,
  }
}

/**
 * 处理 git 报出的全部冲突。
 * @param {object} deps - { git, readTree, writeTree, sectionOf, deviceId, logger }。
 *   git 需提供 conflictedPaths/readStageBlob/checkoutStage/addAll。
 * @returns {Promise<{conflicts: Array, forks: string[]}>}
 */
export async function resolveAll(deps) {
  const paths = await deps.git.schedule(() => deps.git.conflictedPaths())
  const conflicts = []
  const forks = []
  const deleted = []
  const deviceId = await deps.deviceId()
  const tombstones = deps.tombstones ?? {}
  const now = deps.now?.() ?? Date.now()

  for (const c of paths) {
    const [base, ours, theirs] = await Promise.all([
      deps.git.schedule(() => deps.git.readStageBlob('1', c.path)),
      deps.git.schedule(() => deps.git.readStageBlob('2', c.path)),
      deps.git.schedule(() => deps.git.readStageBlob('3', c.path)),
    ])
    const outcome = resolveOne({
      sectionId: deps.sectionOf(c.path) ?? '', base, ours, theirs,
      path: c.path, deviceId, tombstones, now,
    })
    if (Array.isArray(outcome.deleted)) deleted.push(...outcome.deleted)

    // 落盘策略。判定顺序即优先级，四档必须覆盖全部形态：
    //   ① delete:true                    → 该路径合并后不存在 → 真移除
    //   ② 有结果字节                     → 以 ours 为底再覆盖写入
    //   ③ take-theirs 且无自有字节       → checkout --theirs（git 自己检出）
    //   ④ 其余（keepOurs / 无数据的 conflict / 两侧都无）→ 保本地；本地也没有则移除
    // ★ ② 必须排在 kind 之前：tree 的行级合并会归一到 take-theirs 并带上合并结果，
    //   若按 kind 先判就会 checkout --theirs，把本地新增的字节静默丢掉。
    // ★ ④ 兜住 `{kind:'conflict', keepOurs:true}` 且不带 data 的裁决（如非法 JSON）
    //   —— 那是"保本地 + 远端进隔离区"，绝不能退化成采纳远端。
    const data = outcome.data ?? outcome.merged
    if (outcome.delete === true) {
      await dropPath(deps, c.path, conflicts)
    } else if (data !== undefined) {
      if (ours !== undefined) await deps.git.schedule(() => deps.git.checkoutStage('ours', c.path))
      await deps.writeTree(c.path, data)
    } else if (outcome.kind === 'take-theirs' && theirs !== undefined) {
      await deps.git.schedule(() => deps.git.checkoutStage('theirs', c.path))
    } else if (ours !== undefined) {
      await deps.git.schedule(() => deps.git.checkoutStage('ours', c.path))
    } else {
      await dropPath(deps, c.path, conflicts)
    }
    // 冲突副本落盘：keepboth 走 forkPath（配 theirs 字节），tree 这类批量合并器走
    // forks[]（数组自带字节）。不认后者 = LWW 落败方的字节从不落盘 = 静默消失。
    const forkWrites = []
    if (outcome.forkPath !== undefined && theirs !== undefined) forkWrites.push([outcome.forkPath, theirs])
    for (const f of Array.isArray(outcome.forks) ? outcome.forks : []) if (f?.rel !== undefined && f?.data !== undefined) forkWrites.push([f.rel, f.data])
    for (const [rel, data] of forkWrites) { await deps.writeTree(rel, data); forks.push(rel) }
    if (outcome.note !== undefined) conflicts.push({ rel: c.path, note: outcome.note })
  }
  await deps.git.schedule(() => deps.git.addAll())
  return { conflicts, forks, deleted }
}

/**
 * 把"裁决为删除"的路径真的从工作树移除。
 * 优先用与 writeTree 对称的 deps.removeTree；退而认 git.removePath。
 * 两者都没有时**绝不静默**（静默 = 文件复活且无人知道）—— 记进 conflicts 上报。
 * @param {object} deps - resolveAll 的依赖袋。
 * @param {string} rel - 相对路径。
 * @param {Array} conflicts - 上报通道。
 */
async function dropPath(deps, rel, conflicts) {
  if (typeof deps.removeTree === 'function') { await deps.removeTree(rel); return }
  if (typeof deps.git.removePath === 'function') {
    await deps.git.schedule(() => deps.git.removePath(rel))
    return
  }
  conflicts.push({ rel, note: 'delete-not-applied: 缺少 deps.removeTree，该路径会被 add -A 复活' })
  deps.logger?.warn?.(`conflicts: ${rel} 裁决为删除，但未注入 removeTree → 未移除（会被 add -A 复活）`)
}
