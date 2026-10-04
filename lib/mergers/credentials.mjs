// lib/mergers/credentials.mjs — .credentials.yaml 记录级三方合并（纯函数）。
//
// 这是本插件相对全部 11 个生态插件的差异化能力：生态里没有一家做 records
// 的合并（dsh-config-manager 甚至把 records 整体注释为"会话记录"并忽略）。
//
// 权威依据：research/credentials-record-merge-design.md（875 行，含 22 项
// 真机实测 R1-R22）。三条硬事实决定了本文件的形状：
//   ① record 的 schema 字段白名单是封闭的（kind/key/env/payload 四选），
//      写 expires_at 会被**整体拒收** —— 所以过期时间只能从 payload/refs
//      的**不透明值里挖**，不是读官方时间戳字段；
//   ② DSH 的 record 没有任何版本号/时间戳 → "谁更新"必须靠三方 base；
//   ③ 删除必须靠墓碑，且墓碑闸门要在单边分支**之前**（否则"删了又复活"）。

import { badInput } from '../errors.mjs'
import { deepEqual, toMap } from './equal.mjs'

/** 移动/秒级时间戳的合理性上界（10 年后视为哨兵值 —— pi-ai 用 MAX_SAFE_INTEGER 表示永不过期）。 */
const ABSURD_MS = 10 * 365 * 24 * 3600 * 1000

/** 墓碑宽限：远端必须比删除时刻晚这么多才算"删除后重建"。 */
const RESURRECT_GRACE_MS = 60_000

/**
 * 从不透明值里挖过期时间（T1）。
 * 支持：ISO 串、epoch ms 数字、epoch ms 字符串、JWT 的 exp claim。
 * 拒绝：>10 年的哨兵值（pi-ai openrouter 用 MAX_SAFE_INTEGER 表示永不过期
 * —— 当成"最晚过期"会让静态 token 永远压过正在刷新的 token）。
 * @param {*} value - ref 字符串 或 record 值。
 * @returns {{p: number|null, s: number|null}} p=主时间戳（access 侧），s=次（refresh 侧）。
 */
export function expiryCandidates(value) {
  const out = { p: null, s: null }
  // 一次调用内用同一个 now：哨兵上界必须一致，否则同一份数据在不同字段上判定不同。
  const now = Date.now()
  /** 取更晚者；`cap` 是哨兵上界（ISO 日期走 Infinity —— 历史行为对它不设上界）。 */
  const bump = (k, ms, cap = ABSURD_MS) => {
    if (ms === null || Number.isNaN(ms) || ms >= now + cap) return
    out[k] = out[k] === null ? ms : Math.max(out[k], ms)
  }

  const fromString = (v) => {
    const t = v.trim()
    // ★ 第一步必须试 JSON：refs 的值对 DSH 而言是纯字符串，但第三方账号插件写进去的
    // 是 **JSON 文本**（实测 9 个 ref 里 6 个是 JSON 串）—— 不先 parse 就挖不到字段。
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return visit(JSON.parse(t)) } catch { /* 不是合法 JSON → 继续按标量判 */ }
    }
    const n = Number(t)
    if (Number.isFinite(n) && String(n) === t && n > 1e12) return bump('p', n)
    const iso = /^\d{4}-\d{2}-\d{2}/u.test(t) ? Date.parse(t) : NaN
    if (!Number.isNaN(iso)) return bump('p', iso, Infinity)
    // JWT：取 payload 段的 exp claim（没有 exp 就诚实返回 null —— 不猜）。
    const parts = t.split('.')
    if (parts.length === 3 && parts[0].startsWith('eyJ')) {
      try {
        const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).exp
        if (typeof exp === 'number') bump('p', exp * 1000)
      } catch { /* 不猜 */ }
    }
  }

  const visit = (v) => {
    if (typeof v === 'string') return fromString(v)
    if (v === null || typeof v !== 'object') return
    for (const [k, child] of Object.entries(v)) {
      // 字段名启发：含 `expir` 即时间字段（expires / expiry / expiration / expires_at /
      // refresh_token_expire_time / access_token_expires_at …）；含 refresh 的归次时间戳。
      if (/expir/iu.test(k)) {
        const ms = typeof child === 'number' && child > 1e12 ? child
          : typeof child === 'string' ? (/^\d{10,}$/u.test(child) ? Number(child) : Date.parse(child)) : NaN
        bump(/refresh/iu.test(k) ? 's' : 'p', ms)
      } else visit(child)
    }
  }
  visit(typeof value === 'object' && value !== null && 'payload' in value ? value.payload : value)
  return out
}

/** 单级比较：null 视为"最小"；都 null（或相等）→ 0，交给下一级。 */
const cmpLevel = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a > b ? 1 : -1)

/** 两级裁决：先比主时间戳，主相等再比次（refresh）—— 与设计书 §4.3 一致。 */
export function newerThan(a, b) {
  const p = cmpLevel(a.p, b.p)
  return p !== 0 ? p : cmpLevel(a.s, b.s)
}

/** 值是否"退化"（空 access / 无 refresh）—— 决不出胜负时的第二把刀。 */
export function degraded(ns, value) {
  if (ns !== 'rec') return false
  const payload = value?.payload
  if (payload === null || typeof payload !== 'object') return false
  const access = payload.access ?? payload.access_token ?? payload.token ?? payload.zcode_jwt
  const refresh = payload.refresh ?? payload.refresh_token
  // 空 access / oauth 无 refresh 都算退化 —— 决不出胜负时的第二把刀。
  return (access !== undefined && (access === '' || access === null)) || (refresh === undefined && payload.type === 'oauth')
}

/** 单元（cell）：present + value。 */
const cell = (present, value) => (present ? { present: true, value } : { present: false })

/** 入参是否 cell 形态（或空缺）。Buffer 是 object 但没有 present ⇒ 必须挡住。 */
const isCell = (v) => v === undefined || v === null
  || (typeof v === 'object' && !Buffer.isBuffer(v) && typeof v.present === 'boolean')

/** 快照 → Map（三种形态都认；归一逻辑复用 equal.mjs 的 toMap）。 */
export function snapshotOf(section) {
  return { refs: toMap(section?.refs), records: toMap(section?.records) }
}

/** 单元相等（refs 比字符串，records 比 JSON 值）。 */
export function eqCell(ns, a, b) {
  if (a.present !== b.present) return false
  if (!a.present) return true
  // refs 比字符串，records 比 JSON 值（键序无关）。
  return ns === 'ref' ? a.value === b.value : deepEqual(a.value, b.value)
}

/**
 * 单键裁决（设计书 §4.5 的主判决函数，可直接实现）。
 * @param {'ref'|'rec'} ns - 命名空间。
 * @param {object} B - base 单元。
 * @param {object} L - local 单元。
 * @param {object} R - remote 单元。
 * @param {{at: number}|undefined} tomb - 该键的删除墓碑。
 * @returns {{present: boolean, side: string, value?: *, reason: string, quarantine?: object}}
 */
export function decide(ns, B, L, R, tomb) {
  const dL = !eqCell(ns, L, B)
  const dR = !eqCell(ns, R, B)

  // ⓪ 墓碑闸门必须放在所有单边分支【之前】。
  // 为什么：本地删除一旦提交，base 就变成"键不存在"，下次同步时远端往往
  // 还持有删除前的旧值 ⇒ dL=false, dR=true ⇒ 命中 remote-only ⇒ 键被复活。
  // 这就是"删了又回来"的经典 bug。
  if (tomb !== undefined && !L.present && R.present) {
    const rr = expiryCandidates(R.value)
    if (rr.p !== null && rr.p > tomb.at + RESURRECT_GRACE_MS) {
      return { present: true, side: 'remote', value: R.value, reason: `resurrect: remote re-created ${rr.p - tomb.at}ms after delete` }
    }
    return { present: false, side: 'none', reason: 'tombstone: keep deleted (remote holds pre-delete value)' }
  }

  // ① 单边改动。
  if (!dL && !dR) return P('base', B, 'no-change')
  if (dL && !dR) return P('local', L, 'local-only')
  if (!dL && dR) return P('remote', R, 'remote-only')

  // ② 双边改动。
  if (!L.present && !R.present) return { present: false, side: 'none', reason: 'both-deleted' }

  // (a) 删除 vs 修改。
  if (L.present !== R.present) {
    const local = L.present
    const survivor = local ? L : R
    const side = local ? 'local' : 'remote'
    /** 保住存活方的值（三个"放行"分支形状相同，只有 reason/隔离区不同）。 */
    const keep = (reason, extra) => ({ present: true, side, value: survivor.value, reason, ...extra })
    const sr = expiryCandidates(survivor.value)
    const br = B.present ? expiryCandidates(B.value) : { p: null, s: null }
    const newer = newerThan(sr, br) === 1

    if (tomb !== undefined) {
      if (newer && sr.p !== null && sr.p > tomb.at + RESURRECT_GRACE_MS) return keep(`revive: refreshed ${sr.p - tomb.at}ms after delete`)
      return { present: false, side: 'none', reason: 'delete-wins (tombstone)' }
    }
    // 无墓碑：存活方确实比 base 新 → 采纳（是刷新，不是撤销）。
    if (!B.present || newer) return keep(`revive: ${side} newer than base, no tombstone`)
    // 无墓碑、且无法证明存活方比删除新 —— **不能静默删**。
    // 走到这里必然 dL && dR，即存活方相对 base 确实变了 ⇒ 那是用户的真改动，
    // 只是恰好没带时间戳。三条理由说明"删除胜出"在此处是数据丢失：
    //   ① 改动被丢 = 用户改的东西凭空消失，且不留任何副本；
    //   ② `report.quarantined` 在生产路径上**无人消费**（conflicts.mjs 只读
    //      report.conflicts），所以"进隔离区"根本救不回值 —— 只有留在结果里才不丢；
    //   ③ 调用方会据 base 缺失反推墓碑（conflicts.mjs 的 `deleted`），把这次静默
    //      删除**钉成永久**，对端再也带不回来。
    // 故沿用本文件既有的 T2 兜底：保住存活方的值 + 报 ambiguous（上层据此报
    // conflict，用户看得见）。删除意图不会被永久无视 —— 用户在任一台机器上再删
    // 一次就是单边删除（对端未改）→ 删除胜出并记墓碑，登出语义仍然成立。
    return keep(
      `ambiguous: modified on ${side} while deleted on ${local ? 'remote' : 'local'}, kept (no tombstone)`,
      { quarantine: { side: 'delete', deletedOn: local ? 'remote' : 'local' } },
    )
  }

  // (b) 双边都改：先短路"两侧独立改成同值"（否则会产出一个假冲突）。
  if (eqCell(ns, L, R)) return P('local', L, 'both-changed-identically')

  const cmp = newerThan(expiryCandidates(R.value), expiryCandidates(L.value))
  if (cmp > 0) return P('remote', R, 'expiry: remote newer')
  if (cmp < 0) return P('local', L, 'expiry: local newer')

  const ld = degraded(ns, L.value)
  const rd = degraded(ns, R.value)
  if (rd !== ld) return rd ? P('local', L, 'degraded: remote (no refresh / empty access)') : P('remote', R, 'degraded: local')

  // T2 兜底：保本地 + 远端进隔离区 + 上报（绝不静默覆盖）。
  return { present: true, side: 'local', value: L.value, reason: 'ambiguous: kept local, remote quarantined', quarantine: { side: 'remote', value: R.value } }
}

function P(side, c, reason) {
  return c.present
    ? { present: true, side, value: c.value, reason }
    : { present: false, side, reason }
}

/**
 * 三方合并整份凭据文档的抽象视图。
 * @param {object} base - 快照 {refs, records}（Map 形态）。
 * @param {object} local
 * @param {object} remote
 * @param {object} [opts] - { tombstones: Map, tombstoneTtlMs, now, skipKeys: Set }。
 * @returns {{merged: {refs: Map, records: Map}, report: object, tombstones: Map}}
 */
export function mergeCredentials(base, local, remote, opts = {}) {
  const now = opts.now ?? Date.now()
  const ttl = opts.tombstoneTtlMs ?? 90 * 24 * 3600 * 1000
  const tombstones = new Map(opts.tombstones ?? [])
  const skipKeys = opts.skipKeys ?? new Set()

  const out = { refs: new Map(), records: new Map() }
  const report = { adopted: [], kept: [], deleted: [], conflicts: [], quarantined: [], skipped: [] }
  const cellOf = (snap, table, k) => (snap[table]?.has(k) ? cell(true, snap[table].get(k)) : cell(false, undefined))

  for (const ns of ['ref', 'rec']) {
    const table = ns === 'ref' ? 'refs' : 'records'
    const dest = out[table]
    const keys = new Set([base, local, remote].flatMap((snap) => [...(snap[table]?.keys() ?? [])]))
    for (const key of keys) {
      if (skipKeys.has(key)) { report.skipped.push([ns, key, 'skip-listed']); continue }
      const tombKey = `${ns}:${key}`
      // ① 先清过期墓碑（TTL 之外不再阻止重建）。
      const t0 = tombstones.get(tombKey)
      if (t0 !== undefined && now - t0.at > ttl) tombstones.delete(tombKey)

      const B = cellOf(base, table, key)
      const L = cellOf(local, table, key)
      const R = cellOf(remote, table, key)
      const d = decide(ns, B, L, R, tombstones.get(tombKey))
      if (d.present) dest.set(key, d.value)

      // ② 墓碑维护。
      // 本地删除（相对 base 消失）且结果仍是删除 ⇒ 记墓碑；已有则保留最早的 at，
      // 否则每次同步都把 at 刷成 now，TTL 永远不过期。
      if (!L.present && B.present && !d.present && tombstones.get(tombKey) === undefined) tombstones.set(tombKey, { at: now })
      if (!L.present && !R.present) tombstones.delete(tombKey) // 两侧都确认已删除 ⇒ 墓碑退休
      if (d.present && d.side === 'remote' && d.reason.startsWith('resurrect')) tombstones.delete(tombKey) // 放行了复活 ⇒ 撤销墓碑

      const bucket = d.present ? (d.side === 'local' ? report.kept : report.adopted) : report.deleted
      bucket.push([ns, key, `${d.side}: ${d.reason}`])
      if (d.reason.startsWith('ambiguous')) report.conflicts.push([ns, key, d.reason])
      if (d.quarantine !== undefined) report.quarantined.push([ns, key, d.quarantine])
    }
  }
  return { merged: out, report, tombstones }
}

/**
 * 快照 → MergeOutcome（供 SECTION_MERGER 表登记；宿主层负责 YAML 解析与渲染）。
 *
 * ★ 与其它 merger 的契约差异：这个入口吃的是**已解析的 cell**
 *   `{present, value}`，不是 Buffer —— YAML 解析/渲染留在宿主层（见文件头）。
 *   把 Buffer 喂进来必须响亮拒绝：Buffer 没有 `.present`，会被 eqCell 判成
 *   "两侧都没动" ⇒ 返回 delete:true ⇒ **静默删掉整份 .credentials.yaml**。
 * @param {object} input - { ns?: 'ref'|'rec', base?, ours?, theirs?: cell, tomb? }。
 * @returns {MergeOutcome}
 */
export function merge(input, opts = {}) {
  if (!isCell(input.base) || !isCell(input.ours) || !isCell(input.theirs)) {
    throw badInput('credentials merger expects cells {present, value}; use lib/conflicts.mjs creds() for the Buffer-level entry')
  }
  const d = decide(input.ns ?? 'rec', input.base ?? cell(false), input.ours ?? cell(false), input.theirs ?? cell(false), input.tomb)
  if (!d.present) return { kind: 'merged', delete: true, note: d.reason }
  // T2 兜底（无法裁决）：必须报冲突并带上隔离区。若让它落到下面的 side 分支，
  // 就会退化成普通 keep-ours —— 远端值既不进隔离区也不上报 = 静默覆盖。
  // ★ 存活方可能是**远端**（本地删了、远端改了）：那时 `keepOurs` 会把本地那份
  //   删除当成结果，等于把远端的改动丢掉 —— 必须落到 take-theirs。
  if (d.quarantine !== undefined) {
    return d.side === 'remote'
      ? { kind: 'take-theirs', quarantine: d.quarantine, note: d.reason }
      : { kind: 'conflict', keepOurs: true, quarantine: d.quarantine, note: d.reason }
  }
  if (d.side === 'local' || d.side === 'base') return { kind: 'keep-ours', note: d.reason }
  return { kind: 'take-theirs', note: d.reason }
}
