// lib/sessions.mjs — 会话镜像的双向流转（独立分支，Engine 的第二个实例）。
//
// 会话是只追加的大文件（zstd JSONL），冲突一律 keep-both + fork，绝不因为"远端更新"丢掉
// 本机字节。★ 该承诺要成立**必须接线 ctx.base**（三方基点 = git merge-base 的 blob）：引擎
// 一轮里先 pull 后 push，本轮新增的对话还没进树，没有基点就只能退化成"树优先"，拿上一轮的树
// 覆盖本机新字节（pull-only 尤其危险）。未接线不静默 —— 真发生盲覆盖会 logger.warn。
// 接线：`base: (rel) => mirrorFs.base(rel)`（index.mjs 的 sessionEngine）。

import { HOST_ARTIFACT_NAME_RE, isNeverSynced } from './constants.mjs'
import { assertRelPath } from './paths.mjs'
import { pathUnsafe } from './errors.mjs'
import { forkName } from './mergers/keepboth.mjs'

/** 会话类路径（会话本体 + 投影缓存）。 */
export const SESSION_RE = /^sessions\/|^storages\/session_projcache\//u

export function isSessionPath(rel) {
  return SESSION_RE.test(rel)
}

/** 宿主私有产物只看最后一段（`session.lock` 是文件，不是目录）。 */
const skip = (rel) => HOST_ARTIFACT_NAME_RE.test(rel.split('/').pop())

/**
 * 会话写前备份的单文件字节上限（1 MiB），超过就不备份、只留痕。
 * 为什么大文件不备份：会话只追加（新版含旧版全部轮次），且镜像 git 分支本身就是备份（每次
 * 写入都 commit）。而备份目录的代价是实打实的：本机实测 72 个会话 32.4 MB，>1 MiB 的仅 6 个
 * 却占 42% 字节，且最大的那个恰恰改得最勤。阈值取 1 MiB 而非 4 MB：实测 4 MB 只跳过 1 个文件
 * 几乎没用，1 MiB 用 8% 的跳过率换掉 42% 的备份字节。被跳过的会话仍**完整落盘**。
 */
export const SESSION_BACKUP_MAX_BYTES = 1024 * 1024

/** 落本机/进镜像前的单点裁决。会话路径**来自远端 git 树**（远端可构造任意字符串）：fs 层会
 *  再挡一次，但那是另一层的保证，本模块不能把"写哪里"交给下层去猜；判据必须先于任何 I/O。
 *  返回 reason 而非布尔，调用方才能区分"不是会话"（静默跳过）与"越界"（响亮拒绝）。
 *  @returns {{ok: boolean, reason: 'ok'|'not-session'|'never-synced'|'unsafe'|'host-artifact'}} */
export function sessionTargetVerdict(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'not-session' }
  // NEVER_SYNC 优先于一切（含 isSessionPath）：边界被未来的常量表扩展时必须自动跟上。
  // 放在最前也让这条分支可被直接断言，否则永远被 not-session 吞掉。
  if (isNeverSynced(rel)) return { ok: false, reason: 'never-synced' }
  if (!isSessionPath(rel)) return { ok: false, reason: 'not-session' }
  try {
    assertRelPath(rel)
  } catch {
    return { ok: false, reason: 'unsafe' } // 空串/绝对路径/`..`/NUL/盘符
  }
  if (skip(rel)) return { ok: false, reason: 'host-artifact' }
  return { ok: true, reason: 'ok' }
}

/** 本机 → 镜像工作树（只追加，不删除本机任何东西）。★ 先用正则筛掉非会话文件：walkAll 在生产
 *  里是全量本机清单（实测 ~29k 文件），对它们跑完整裁决是白烧 CPU；筛完只剩 ~144 个条目。 */
export async function mirrorSessions(ctx) {
  const files = (await ctx.walkAll())
    .filter((f) => isSessionPath(f.rel) && sessionTargetVerdict(f.rel).ok)
  let changed = 0
  for (const f of files) {
    const data = await ctx.readLocal(f.rel)
    if (data === null) continue
    if (await ctx.writeTree(f.rel, data)) changed += 1 // 内容未变时返回 false（不产生空提交）
  }
  return changed
}

/** 三方裁决（纯函数，零 I/O）。本模块最贵的一个 bug 就在这：引擎一轮里先 pull 后 push
 *  （engine.mjs:56/87），本轮新追加的对话还没进树 —— 只要远端有新提交，applyToLocal 就会拿
 *  上一轮的树覆盖本机新对话（`pull` 模式、以及 sync 模式下"远端领先"的任何一轮），实测症状是
 *  刚聊的几轮消失且没有 fork、没有报错。判据只用三方比较，不猜谁更新。
 *  @param {unknown} base - 三方基点（git merge-base 的 blob）；非 Buffer 视为不可用。 */
function planSessionWrite(base, current, raw) {
  if (!Buffer.isBuffer(base)) return { blind: true, writeTree: true, fork: false }
  if (base.equals(raw)) return { blind: false, writeTree: false, fork: false } // 远端没动 → 本机领先，下一轮 mirror 会推上去
  if (base.equals(current)) return { blind: false, writeTree: true, fork: false } // 本机没动 → 远端领先
  return { blind: false, writeTree: false, fork: true } // 双方都动过 → keep-both
}

/** 双方都改过 → 把**远端版本**转成 fork 留在本机（本机版本留在主路径），命名复用 keepboth.forkName，
 *  与树侧裁决同构 → 下一轮 mirrorSessions 会把它推上云。已存在同名 fork **绝不覆盖**（先到者优先）。
 *  ★ 派生路径也要过闸：fork 名带 deviceId（来自本地状态文件，可被篡改）；越界就整体放弃
 *  （远端字节仍在镜像树里，下一轮冲突裁决会再 fork）。 */
async function landTheirsFork(ctx, rel, data) {
  const deviceId = typeof ctx.deviceId === 'function' ? ctx.deviceId() : (ctx.deviceId ?? 'unknown0')
  const now = typeof ctx.now === 'function' ? ctx.now() : Date.now()
  const forkRel = forkName(rel, deviceId, now)
  try {
    assertRelPath(forkRel)
  } catch {
    ctx.logger?.warn?.(`fork refused (derived path unsafe): ${forkRel}`)
    return false
  }
  if ((await ctx.readLocal(forkRel)) !== null) return false
  await ctx.writeLocal(forkRel, data)
  return true
}

/** 写前备份一个会话文件（策略见 SESSION_BACKUP_MAX_BYTES）。与 apply.mjs 的 makeBackupGate 同构：
 *  懒创建、只备份真会被改的（调用点已在幂等检查之后）、失败不阻断；差别只有按大小分流。
 *  目录带 `sessions-` 前缀，与配置流的 `pull-<ts>` 分开便于用户清理。
 *  @returns {Promise<'backed-up'|'no-old-bytes'|'too-large'|'unavailable'|'failed'>} */
async function backupBeforeWrite(ctx, rel, current, state) {
  if (current === null) return 'no-old-bytes'
  if (typeof ctx.backupFile !== 'function' || typeof ctx.backupDir !== 'function') return 'unavailable'
  if (current.length > SESSION_BACKUP_MAX_BYTES) return 'too-large'
  try {
    state.dir ??= await ctx.backupDir('sessions')
    await ctx.backupFile(rel, state.dir)
    return 'backed-up'
  } catch {
    return 'failed' // 后悔药写不出来不该卡住数据落地（与 apply.mjs 同口径）
  }
}

/** 镜像工作树 → 本机（幂等：内容一致则跳过，避免每轮重写大文件）。写盘前逐条裁决：越界路径
 *  **抛**而非跳过 —— 这是攻击/损坏信号，静默跳过等于把事故藏起来（Engine 会收敛成 report.error）。
 *  @param {object} ctx - { listTree, readTree, readLocal, writeLocal, base?, backupDir?, backupFile?, logger? }
 *  @throws {SyncError} code=PATH_UNSAFE */
export async function applySessionsToLocal(ctx) {
  let written = 0
  let blindClobber = 0
  const backupState = {}
  for (const rel of await ctx.listTree()) {
    const verdict = sessionTargetVerdict(rel)
    if (!verdict.ok) {
      if (verdict.reason === 'unsafe') throw pathUnsafe('sessions-apply', rel)
      continue // not-session / never-synced / host-artifact：都不进本机
    }
    const raw = await ctx.readTree(rel)
    if (raw === null) continue
    const current = await ctx.readLocal(rel)
    if (current !== null && current.equals(raw)) continue
    // 新文件没有"本机独有字节"可丢；已存在的文件才需要三方裁决。
    const plan = current === null
      ? { blind: false, writeTree: true, fork: false }
      : planSessionWrite(typeof ctx.base === 'function' ? await ctx.base(rel) : null, current, raw)
    if (plan.blind) blindClobber += 1
    if (!plan.writeTree) {
      if (plan.fork && await landTheirsFork(ctx, rel, raw)) written += 1
      continue
    }
    if (await backupBeforeWrite(ctx, rel, current, backupState) === 'too-large') {
      ctx.logger?.warn?.(`session backup skipped (> ${SESSION_BACKUP_MAX_BYTES} bytes): ${rel} — mirror/sessions 分支仍是唯一备份`)
    }
    await ctx.writeLocal(rel, raw)
    written += 1
  }
  // 无基点时的盲覆盖是本模块唯一会丢字节的路径 —— 必须说出来（每轮一条，不刷屏）。
  if (blindClobber > 0) {
    ctx.logger?.warn?.(`${blindClobber} session file(s) overwritten without a three-way base (ctx.base unwired) — local-only turns may be lost`)
  }
  return written
}
