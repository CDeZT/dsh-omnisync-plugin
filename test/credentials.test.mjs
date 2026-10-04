// test/credentials.test.mjs — 凭据记录级合并行为锁定。
//
// 依据 research/credentials-record-merge-design.md 的实测结论（R1-R22）与
// 主判决函数 §4.5。重点锁定三个高危语义：墓碑闸门位置、哨兵值过滤、
// 假冲突短路。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decide, mergeCredentials, expiryCandidates, newerThan, degraded, snapshotOf, eqCell,
} from '../lib/mergers/credentials.mjs'

const snap = (refs = {}, records = {}) => snapshotOf({ refs, records })
const C = (present, value) => (present ? { present: true, value } : { present: false })
const MS = (iso) => Date.parse(iso)

/* ───────────────── 过期时间挖掘（T1） ───────────────── */

test('T1: 从 refs 的 JSON 串里挖 expires_at（ms 字符串）', () => {
  const v = JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: '1792245217674' })
  assert.equal(expiryCandidates(v).p, 1792245217674)
})

test('T1: 挖 expire_time（QODER 的字段名，number）', () => {
  const v = JSON.stringify({ access_token: 'a', refresh_token: 'r', expire_time: 1792245217674, refresh_token_expire_time: 1800000000000 })
  const r = expiryCandidates(v)
  assert.equal(r.p, 1792245217674)
  assert.equal(r.s, 1800000000000)
})

test('T1: 官方 record 的 payload 里没有时间戳 → 诚实返回 null（不猜）', () => {
  assert.equal(expiryCandidates({ kind: 'grant', payload: { version: 1, secret: 'abc' } }).p, null)
  assert.equal(expiryCandidates({ kind: 'grant', payload: { id: 'uuid-here' } }).p, null)
})

test('T1: pi-ai 的 {type:oauth, access, refresh, expires} 命中 expires（epoch ms）', () => {
  const r = expiryCandidates({ kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 1792245217674 } })
  assert.equal(r.p, 1792245217674)
})

test('T1: 哨兵值 MAX_SAFE_INTEGER 必须被过滤（否则静态 token 永远压过刷新 token）', () => {
  assert.equal(expiryCandidates({ expires: Number.MAX_SAFE_INTEGER }).p, null)
  assert.equal(expiryCandidates({ expires: Date.now() + 20 * 365 * 24 * 3600 * 1000 }).p, null, '>10 年视为哨兵')
})

test('T1: JWT 的 exp claim（base64url 段）', () => {
  const exp = 1792245217
  const payload = Buffer.from(JSON.stringify({ exp, sub: 'x' })).toString('base64url')
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
  assert.equal(expiryCandidates(jwt).p, exp * 1000)
})

test('T1: 无 exp claim 的 JWT → null（实测 ZCODE 就是这种）', () => {
  const payload = Buffer.from(JSON.stringify({ iat: 1700000000 })).toString('base64url')
  assert.equal(expiryCandidates(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`).p, null)
})

test('T1: 纯 API key（非 JSON/非 JWT）→ null', () => {
  assert.equal(expiryCandidates('sk-abcdef123456').p, null)
  assert.equal(expiryCandidates('tvly-dev-xxxxx').p, null)
})

test('T1: 两级裁决（主时间戳优先，主相等比 refresh）', () => {
  assert.equal(newerThan({ p: 200, s: 100 }, { p: 100, s: 999 }), 1, '主时间戳优先')
  assert.equal(newerThan({ p: 100, s: 999 }, { p: 100, s: 100 }), 1, '主相等时比次')
  assert.equal(newerThan({ p: 100, s: 100 }, { p: 100, s: 100 }), 0)
  assert.equal(newerThan({ p: null, s: null }, { p: 100, s: null }), -1, '无信息方判负')
})

test('degraded: 无 refresh 的 oauth / 空 access 判退化', () => {
  assert.equal(degraded('rec', { kind: 'grant', payload: { type: 'oauth', access: 'a' } }), true)
  assert.equal(degraded('rec', { kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r' } }), false)
  assert.equal(degraded('rec', { kind: 'grant', payload: { access: '' } }), true)
  assert.equal(degraded('ref', 'anything'), false, 'refs 不判退化')
})

/* ───────────────── 单键裁决 ───────────────── */

test('decide: 单边改动', () => {
  assert.equal(decide('ref', C(false), C(true, 'x'), C(false)).side, 'local')
  assert.equal(decide('ref', C(false), C(false), C(true, 'x')).side, 'remote')
})

test('decide: 双侧独立改成同值 → 不算冲突', () => {
  const d = decide('ref', C(true, 'old'), C(true, 'new'), C(true, 'new'))
  assert.equal(d.reason, 'both-changed-identically')
  assert.equal(d.side, 'local')
})

test('decide: 双侧改不同值 → 按过期时间取新', () => {
  const older = JSON.stringify({ access_token: 'a', expires_at: '1792000000000' })
  const newer = JSON.stringify({ access_token: 'b', expires_at: '1792245217674' })
  assert.equal(decide('ref', C(false), C(true, older), C(true, newer)).side, 'remote')
  assert.equal(decide('ref', C(false), C(true, newer), C(true, older)).side, 'local')
})

test('decide: 双侧都无时间信息 → 保本地 + 远端进隔离区（绝不静默覆盖）', () => {
  const d = decide('ref', C(false), C(true, 'local-secret'), C(true, 'remote-secret'))
  assert.equal(d.side, 'local')
  assert.equal(d.reason.startsWith('ambiguous'), true)
  assert.equal(d.quarantine.value, 'remote-secret', '远端值必须进隔离区而非丢弃')
})

test('decide: 哨兵值被过滤 → 带真实过期时间的一侧胜出（静态 token 不得永久压制）', () => {
  const sentinel = JSON.stringify({ access: 'a', refresh: 'r', expires: Number.MAX_SAFE_INTEGER })
  const real = JSON.stringify({ access: 'b', refresh: 'r2', expires: 1792245217674 })
  const d = decide('ref', C(false), C(true, sentinel), C(true, real))
  assert.equal(d.side, 'remote', '哨兵被过滤后，有真实时间戳的远端胜出')
  assert.equal(d.reason, 'expiry: remote newer')
})

/* ───────────────── 墓碑语义（最高危） ───────────────── */

test('墓碑: 本地删除已提交 + 远端仍持旧值 → 保持删除（不复活）', () => {
  const tomb = { at: MS('2026-01-01T00:00:00Z') }
  const oldValue = JSON.stringify({ access_token: 'a', expires_at: String(MS('2025-12-01T00:00:00Z')) })
  const d = decide('ref', C(true, oldValue), C(false), C(true, oldValue), tomb)
  assert.equal(d.present, false, '删除必须赢 —— 这是墓碑闸门存在的唯一理由')
  assert.equal(d.reason.startsWith('tombstone'), true)
})

test('墓碑: 远端在删除之后明显重建过 → 允许复活', () => {
  const tomb = { at: MS('2026-01-01T00:00:00Z') }
  const fresh = JSON.stringify({ access_token: 'new', expires_at: String(MS('2026-01-02T00:00:00Z')) })
  const d = decide('ref', C(true, 'old'), C(false), C(true, fresh), tomb)
  assert.equal(d.present, true)
  assert.equal(d.reason.startsWith('resurrect'), true)
})

test('墓碑: 无墓碑时删除优先（避免登出被对端刷新撤销）', () => {
  const d = decide('ref', C(true, 'base-value'), C(false), C(true, 'base-value'))
  assert.equal(d.present, false)
})

/* ───────────────── 整份文档合并 ───────────────── */

test('mergeCredentials: refs 并集 + records 并集', () => {
  const base = snap()
  const local = snap({ A: '1' }, { 's/x': { kind: 'grant', payload: { v: 1 } } })
  const remote = snap({ B: '2' }, { 's/y': { kind: 'grant', payload: { v: 2 } } })
  const { merged } = mergeCredentials(base, local, remote)
  assert.deepEqual([...merged.refs.keys()].sort(), ['A', 'B'])
  assert.deepEqual([...merged.records.keys()].sort(), ['s/x', 's/y'])
})

test('mergeCredentials: 两台机器各自登录不同账号 → 都保留（云电脑语义）', () => {
  const base = snap()
  const local = snap({ TRAE_ACCOUNT_A: '{"access_token":"t1","expires_at":"1792000000000"}' })
  const remote = snap({ QODER_ACCOUNT_B: '{"access_token":"q1","expire_time":1792245217674}' })
  const { merged, report } = mergeCredentials(base, local, remote)
  assert.equal(merged.refs.size, 2)
  assert.equal(report.adopted.length, 1)
  assert.equal(report.kept.length, 1)
})

test('mergeCredentials: 同账号两台机器各自刷新 → 取过期时间新的', () => {
  const key = 'TRAE_ACCOUNT_X'
  const base = snap({ [key]: JSON.stringify({ access_token: 'old', expires_at: '1792000000000' }) })
  const local = snap({ [key]: JSON.stringify({ access_token: 'L', expires_at: '1792100000000' }) })
  const remote = snap({ [key]: JSON.stringify({ access_token: 'R', expires_at: '1792245217674' }) })
  const { merged } = mergeCredentials(base, local, remote)
  assert.equal(JSON.parse(merged.refs.get(key)).access_token, 'R')
})

test('mergeCredentials: 墓碑随合并结果一并返回（供 sidecar 持久化）', () => {
  const base = snap({ GONE: 'x' })
  const local = snap()
  const remote = snap({ GONE: 'x' })
  const { merged, tombstones } = mergeCredentials(base, local, remote)
  assert.equal(merged.refs.has('GONE'), false)
  assert.ok(tombstones.get('ref:GONE'), '删除必须留墓碑')
})

test('mergeCredentials: 两侧都删 → 墓碑退休', () => {
  const base = snap({ GONE: 'x' })
  const local = snap()
  const remote = snap()
  const { tombstones } = mergeCredentials(base, local, remote)
  assert.equal(tombstones.has('ref:GONE'), false)
})

test('墓碑 TTL 过期 + 远端确实刷新过 → 允许重建；墓碑新鲜 → 仍阻止', () => {
  const key = 'ref:K'
  const T0 = MS('2025-12-01T00:00:00Z')
  const T1 = MS('2026-05-31T00:00:00Z') // 远端在删除之后刷新过
  const base = snap({ K: JSON.stringify({ access_token: 'old', expires_at: String(T0) }) })
  const local = snap() // 本地删除
  const remote = snap({ K: JSON.stringify({ access_token: 'fresh', expires_at: String(T1) }) })
  const ttl = 90 * 24 * 3600 * 1000

  // 陈旧墓碑（2025-01-01，距 now 已超 TTL）→ 重建放行
  const stale = new Map([[key, { at: MS('2025-01-01T00:00:00Z') }]])
  const r1 = mergeCredentials(base, local, remote, { now: MS('2026-06-01T00:00:00Z'), tombstones: stale, tombstoneTtlMs: ttl })
  assert.equal(r1.merged.refs.has('K'), true, 'TTL 过期后允许重建')

  // 新鲜墓碑（2026-05-31T12:00，晚于远端刷新时刻）→ 仍阻止
  const fresh = new Map([[key, { at: MS('2026-05-31T12:00:00Z') }]])
  const r2 = mergeCredentials(base, local, remote, { now: MS('2026-06-01T00:00:00Z'), tombstones: fresh, tombstoneTtlMs: ttl })
  assert.equal(r2.merged.refs.has('K'), false, '新鲜墓碑必须阻止复活（登出不被对端刷新撤销）')
})

test('mergeCredentials: skipKeys 名单（如 issuer 不匹配会被自动删的键）', () => {
  const base = snap({ 'deepseek-account-platform/default': 'x' })
  const local = snap({ 'deepseek-account-platform/default': 'local' })
  const remote = snap({ 'deepseek-account-platform/default': 'remote' })
  const { merged, report } = mergeCredentials(base, local, remote, {
    skipKeys: new Set(['deepseek-account-platform/default']),
  })
  assert.equal(merged.refs.has('deepseek-account-platform/default'), false)
  assert.equal(report.skipped.length, 1)
})

test('mergeCredentials: records 与 refs 命名空间不撞键', () => {
  const base = snap()
  const local = snap({ 's/x': 'ref-value' }, { 's/x': { kind: 'grant', payload: { a: 1 } } })
  const remote = snap()
  const { merged } = mergeCredentials(base, local, remote)
  assert.equal(merged.refs.get('s/x'), 'ref-value')
  assert.deepEqual(merged.records.get('s/x'), { kind: 'grant', payload: { a: 1 } })
})

test('mergeCredentials: 幂等（对合并结果再合并不产生变化）', () => {
  const base = snap({ A: '1' })
  const local = snap({ A: '2', B: 'b' })
  const remote = snap({ A: '1', C: 'c' })
  const r1 = mergeCredentials(base, local, remote)
  const again = snapshotOf({ refs: Object.fromEntries(r1.merged.refs), records: Object.fromEntries(r1.merged.records) })
  const r2 = mergeCredentials(again, again, again)
  assert.deepEqual([...r2.merged.refs.keys()].sort(), [...r1.merged.refs.keys()].sort())
})

test('eqCell: records 值比较键序无关', () => {
  assert.equal(eqCell('rec', C(true, { a: 1, b: 2 }), C(true, { b: 2, a: 1 })), true)
  assert.equal(eqCell('rec', C(true, { a: 1 }), C(true, { a: 2 })), false)
})
