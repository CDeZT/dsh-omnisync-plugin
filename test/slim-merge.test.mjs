// test/slim-merge.test.mjs — 合并内核精简的**行为护栏**（task-11）。
//
// 精简会大范围改写函数内部结构，所以先把"当前行为"钉死：这些用例在精简前后
// 必须给出完全相同的结果。覆盖三不变量（绝不丢失 / 确定性 / 幂等）+ 每个被
// 改写函数的可观察契约。自包含（不依赖 test/helpers.mjs，那份在别人 scope 里）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deepEqual, toMap } from '../lib/mergers/equal.mjs'
import { mergeJson, unionKeys, merge as jsonMerge } from '../lib/mergers/json.mjs'
import { classifyPath, planMerge, forkName, toBuffer } from '../lib/mergers/keepboth.mjs'
import { mergeTree, lwwPick, tryLineMerge, merge as treeMerge } from '../lib/mergers/tree.mjs'
import {
  parsePatchYaml, renderPatchYaml, mergePatchEntries, mergeRemoves, merge as patchMerge, scalar, serializeScalar,
} from '../lib/mergers/patch-yaml.mjs'
import {
  expiryCandidates, newerThan, degraded, decide, eqCell, snapshotOf, mergeCredentials,
  merge as credMerge,
} from '../lib/mergers/credentials.mjs'
import { parseCredYaml, renderCredYaml } from '../lib/credyaml.mjs'
import { resolveOne } from '../lib/conflicts.mjs'
import { MERGE_KINDS } from '../lib/constants.mjs'

const B = (s) => Buffer.from(s, 'utf8')
const entry = (s, mtimeMs) => ({ data: B(s), mtimeMs })

/* ───────────────── equal / toMap ───────────────── */

test('slim: deepEqual 逐形态（键序无关 / 数组序敏感 / 类型敏感 / null≠undefined）', () => {
  assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
  assert.ok(!deepEqual([1, 2], [2, 1]))
  assert.ok(!deepEqual({ a: 1 }, { a: '1' }))
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }))
  assert.ok(deepEqual({ a: [{ b: [1, null] }] }, { a: [{ b: [1, null] }] }))
  assert.ok(deepEqual(null, null))
  assert.ok(!deepEqual(null, {}))
  assert.ok(deepEqual(undefined, undefined))
  assert.ok(!deepEqual(undefined, null))
  assert.ok(!deepEqual(0, false), '0 ≠ false（类型敏感）')
  assert.ok(!deepEqual([], {}), '数组 ≠ 对象')
  assert.ok(deepEqual([1, [2]], [1, [2]]))
  assert.ok(!deepEqual([1, [2]], [1, [3]]))
})

test('slim: toMap 归一（Map / 键值对数组 / 普通对象 / null / 字符串 / 数字）', () => {
  assert.deepEqual([...toMap(new Map([['a', 1]]))], [['a', 1]])
  assert.deepEqual([...toMap([['a', 1], ['b', 2]])], [['a', 1], ['b', 2]])
  assert.deepEqual([...toMap({ a: 1 })], [['a', 1]])
  assert.deepEqual([...toMap(null)], [])
  assert.deepEqual([...toMap(undefined)], [])
  assert.deepEqual([...toMap('ab')], [], '字符串不是表')
  assert.deepEqual([...toMap(7)], [], '数字不是表')
  assert.deepEqual([...toMap({})], [])
})

/* ───────────────── json ───────────────── */

test('slim: unionKeys 保序去重（ours 序在前）', () => {
  assert.deepEqual(unionKeys({ a: 1, b: 2 }, { b: 9, c: 3 }), ['a', 'b', 'c'])
  assert.deepEqual(unionKeys({}, { x: 1 }), ['x'])
  assert.deepEqual(unionKeys(null, { x: 1 }), ['x'])
  assert.deepEqual(unionKeys(undefined, undefined), [])
  assert.deepEqual(unionKeys('ab', { x: 1 }), ['x'], '非对象源被跳过')
})

test('slim: mergeJson 三类裁决 + 数组整体裁决（绝不 union）', () => {
  assert.deepEqual(mergeJson({ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 9, b: 2 }).merged, { a: 9, b: 3 })
  const arr = mergeJson({ arr: [1, 2] }, { arr: [1, 2, 3] }, { arr: [9] })
  assert.equal(arr.conflicts.length, 1)
  assert.equal(arr.conflicts[0].kind, 'value')
  assert.deepEqual(arr.merged.arr, [1, 2, 3], '冲突保本地，绝不 union')
  const del = mergeJson({ b: 'orig' }, { b: 'mine' }, {})
  assert.equal(del.conflicts[0].kind, 'delete-vs-modify')
  assert.equal(del.merged.b, 'mine')
  assert.equal(Object.hasOwn(mergeJson({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 }).merged, 'b'), false, '跟随删除')
})

test('slim: mergeJson 深度闸（超限报冲突不炸栈）', () => {
  let o = { v: 1 }
  let t = { v: 2 }
  for (let i = 0; i < 40; i++) { o = { n: o }; t = { n: t } }
  const r = mergeJson({}, o, t, { maxDepth: 5 })
  assert.ok(r.conflicts.length > 0)
  assert.equal(r.conflicts[0].kind, 'depth-exceeded')
})

test('slim: json.merge 非法 JSON → keepOurs 无 data；顶层删除 → delete:true 无 data', () => {
  const bad = jsonMerge({ base: B('{}'), ours: B('{broken'), theirs: B('{}'), path: 'x.json' })
  assert.equal(bad.kind, 'conflict')
  assert.equal(bad.keepOurs, true)
  assert.equal(bad.data, undefined)
  const del = jsonMerge({ base: B('{"a":1}'), ours: undefined, theirs: B('{"a":2}'), path: 'x.json' })
  assert.equal(del.delete, true)
  assert.equal(del.data, undefined, '绝不写出字面量 undefined')
})

/* ───────────────── keepboth ───────────────── */

test('slim: keepboth 五分类 + 单侧缺失语义', () => {
  assert.equal(classifyPath(B('a'), B('a'), B('a')).kind, MERGE_KINDS.IDENTICAL)
  assert.equal(classifyPath(undefined, undefined, undefined).kind, MERGE_KINDS.IDENTICAL)
  assert.equal(classifyPath(B('a'), B('ab'), B('a')).kind, MERGE_KINDS.OURS_ONLY)
  assert.equal(classifyPath(B('a'), B('a'), B('ab')).kind, MERGE_KINDS.THEIRS_ONLY)
  assert.equal(classifyPath(undefined, undefined, B('new')).kind, MERGE_KINDS.THEIRS_ONLY)
  assert.equal(classifyPath(undefined, B('new'), undefined).kind, MERGE_KINDS.OURS_ONLY)
  assert.equal(classifyPath(B('a'), B('ab'), B('ac')).kind, MERGE_KINDS.APPEND_BOTH)
  assert.equal(classifyPath(B('a'), B('zz'), B('yy')).kind, MERGE_KINDS.DIVERGED)
  assert.equal(classifyPath(B('a'), B('ab'), B('ac')).forkTheirs, true, '分歧必须转 fork')
})

test('slim: keepboth planMerge 汇总 + fork 路径一致', () => {
  const { resolutions, summary } = planMerge([
    { path: 'a', base: B('x'), ours: B('x'), theirs: B('y') },
    { path: 'b', base: B('x'), ours: B('xy'), theirs: B('x') },
    { path: 'c', base: B('x'), ours: B('xy'), theirs: B('xz') },
    { path: 'd', base: B('x'), ours: B('mm'), theirs: B('nn') },
  ], { deviceId: 'dev12345', now: Date.UTC(2026, 0, 2) })
  assert.equal(summary.adopted, 1)
  assert.equal(summary.appended, 1)
  assert.equal(summary.diverged, 1)
  assert.deepEqual(summary.forkPaths, resolutions.filter((r) => r.forkPath !== undefined).map((r) => r.forkPath))
  assert.equal(resolutions[0].adoptTheirs, true)
})

test('slim: toBuffer / forkName 命名口径', () => {
  assert.equal(toBuffer(undefined), undefined)
  assert.equal(toBuffer(null), undefined)
  assert.equal(toBuffer('x').toString(), 'x')
  const same = B('x')
  assert.equal(toBuffer(same), same, 'Buffer 原样返回（不复制）')
  assert.equal(forkName('p/a.jsonl', 'a1b2c3d4', Date.UTC(2026, 0, 2, 3, 4, 5)), 'p/a.jsonl.remote-fork-20260102030405-a1b2c3d4')
})

/* ───────────────── tree ───────────────── */

test('slim: tree 单侧缺失语义（跟随删除 / 保留改动 + 记冲突）', () => {
  const del = mergeTree({ base: new Map([['a', entry('base', 1)]]), ours: new Map(), theirs: new Map([['a', entry('base', 5)]]) })
  assert.equal(del.files.size, 0, '本地删 + 远端未改 → 跟随删除')
  const mod = mergeTree({ base: new Map([['a', entry('base', 1)]]), ours: new Map(), theirs: new Map([['a', entry('changed', 5)]]) })
  assert.equal(mod.files.get('a').data.toString(), 'changed')
  assert.equal(mod.conflicts[0].reason, 'local-deleted-remote-modified')
  const rmod = mergeTree({ base: new Map([['a', entry('base', 1)]]), ours: new Map([['a', entry('mine', 5)]]), theirs: new Map() })
  assert.equal(rmod.files.get('a').data.toString(), 'mine')
  assert.equal(rmod.conflicts[0].reason, 'remote-deleted-local-modified')
  const fresh = mergeTree({ ours: new Map([['a', entry('new', 5)]]), theirs: new Map() })
  assert.equal(fresh.files.get('a').data.toString(), 'new')
  assert.equal(fresh.conflicts.length, 0, 'base 缺失 = 纯新增，不算冲突')
})

test('slim: tree LWW 确定性 + 行级合并 + 冲突副本不衍生', () => {
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 100 }, { data: B('t'), mtimeMs: 200 }, 'a', 'b'), 'theirs')
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 200 }, { data: B('t'), mtimeMs: 100 }, 'a', 'b'), 'ours')
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 100 }, { data: B('t'), mtimeMs: 100 }, 'aaaa', 'bbbb'), 'ours')
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 100 }, { data: B('t'), mtimeMs: 100 }, 'zzzz', 'bbbb'), 'theirs')
  const merged = tryLineMerge(B('l1\n'), B('l1\nl2\n'), B('l1\nl3\n'))
  assert.ok(merged.toString().includes('l2') && merged.toString().includes('l3'))
  assert.equal(tryLineMerge(B('\u0000'), B('\u0000'), B('\u0000')), null, '二进制不走行合并')
  const forkRel = 'a.conflict-20260102000000-deadbeef'
  const r = mergeTree({ ours: new Map([[forkRel, entry('fork', 1)]]), theirs: new Map() })
  assert.equal(r.forks.length, 0, '冲突副本不再产 fork')
})

test('slim: tree 合并结果的 mtimeMs 不得为 NaN', () => {
  const r = mergeTree({
    base: new Map([['a', { data: B('l1\n') }]]),
    ours: new Map([['a', { data: B('l1\nl2\n') }]]),
    theirs: new Map([['a', { data: B('l1\nl3\n') }]]),
  })
  assert.equal(r.files.get('a').mtimeMs, 0)
})

/* ───────────────── patch-yaml ───────────────── */

test('slim: patch scalar/serializeScalar 类型保真边界', () => {
  assert.equal(scalar('~'), null)
  assert.equal(scalar('null'), null)
  assert.deepEqual(scalar('[]'), [])
  assert.deepEqual(scalar('[a, b]'), ['a', 'b'])
  assert.deepEqual(scalar('{}'), {})
  assert.equal(scalar('"q"'), 'q')
  assert.equal(scalar('123'), 123)
  assert.equal(scalar('abc'), 'abc')
  assert.equal(scalar('99999999999999999999'), '99999999999999999999', '超安全整数保字符串')
  assert.equal(serializeScalar('123'), '"123"')
  assert.equal(serializeScalar(123), '123')
  assert.equal(serializeScalar(''), '""')
  assert.equal(serializeScalar('true'), '"true"')
  assert.equal(serializeScalar(true), 'true')
  assert.equal(serializeScalar(null), 'null')
})

test('slim: patch 条目合并五个分支（并集 / 单侧改 / 删改对峙 / 字段级 / orphan）', () => {
  const P = (t) => parsePatchYaml(t).entries
  const base = P('- insert:\n    - id: shared\n')
  const union = mergePatchEntries(base, P('- insert:\n    - id: shared\n    - id: lo\n'), P('- insert:\n    - id: shared\n    - id: ro\n'))
  assert.deepEqual(union.merged.map((e) => e.id).sort(), ['lo', 'ro', 'shared'])
  assert.deepEqual(union.adopted, ['ro'])
  assert.deepEqual(union.kept, ['shared', 'lo'])

  // 删 vs 改（两个方向都要保住改动方 + 上报）—— base 必须含 gone 才算"删除"。
  const baseGone = P('- insert:\n    - id: shared\n    - id: gone\n')
  const delMod = mergePatchEntries(baseGone, P('- insert:\n    - id: shared\n'), P('- insert:\n    - id: shared\n    - id: gone\n      config:\n        v: 1\n'))
  assert.equal(delMod.conflicts[0].kind, 'delete-vs-modify')
  assert.equal(delMod.merged.find((e) => e.id === 'gone').config.v, 1, '远端改动不得丢')
  const modDel = mergePatchEntries(baseGone, P('- insert:\n    - id: shared\n    - id: gone\n      config:\n        v: 2\n'), P('- insert:\n    - id: shared\n'))
  assert.equal(modDel.conflicts[0].kind, 'modify-vs-delete')
  assert.equal(modDel.merged.find((e) => e.id === 'gone').config.v, 2, '本地改动不得丢')

  // 跟随删除（一侧删、另一侧未改）。
  const followed = mergePatchEntries(baseGone, P('- insert:\n    - id: shared\n'), P('- insert:\n    - id: shared\n    - id: gone\n'))
  assert.deepEqual(followed.deleted, ['gone'])

  // 字段级三方 + 实例字段保本地。
  const field = mergePatchEntries(
    P('- insert:\n    - id: a\n      config:\n        x: 1\n        y: 1\n'),
    P('- insert:\n    - id: a\n      config:\n        x: 2\n        y: 1\n        port: 19387\n'),
    P('- insert:\n    - id: a\n      config:\n        x: 1\n        y: 2\n        port: 8080\n'),
    { instanceKeys: [/^port$/u] },
  )
  assert.equal(field.conflicts.length, 0, '端口是实例字段 → 保本地不算冲突')
  assert.deepEqual(field.merged[0].config, { x: 2, y: 2, port: 19387 })

  // orphan（无 id）必须留下 + 上报。
  const orphan = mergePatchEntries([], P('- insert:\n    - config:\n        keep: 1\n'), [])
  assert.equal(orphan.merged.length, 1)
  assert.equal(orphan.conflicts[0].kind, 'orphan-entry')
})

test('slim: patch remove 指令并集 + 矛盾上报', () => {
  const r = mergeRemoves(['b'], ['c'], ['b', 'd'], ['d'])
  assert.deepEqual(r.removes, ['b', 'c', 'd'], '稳定去重（base→ours→theirs）')
  assert.deepEqual(r.conflicts.map((c) => c.id), ['d'])
  assert.equal(r.conflicts[0].kind, 'insert-vs-remove')
  assert.deepEqual(mergeRemoves(undefined, undefined, undefined, []), { removes: [], conflicts: [] })
  assert.deepEqual(mergeRemoves([''], [], [], []).removes, [], '空 id 丢弃')
})

test('slim: patch 渲染是解析的不动点（含三层嵌套 / 嵌套数组 / 空容器）', () => {
  const one = {
    id: 'mcp-x',
    name: '@x/y',
    config: {
      command: 'npx',
      args: ['-y', 'pkg', '--flag'],
      port: '19387',
      env: { TOKEN: 'sk-a', N: '3' },
      mcpServers: { x: { command: 'npx', args: ['a'], deep: { deeper: { d: 'v' } } } },
      empty: {},
      empties: [],
      nested: [[1, 2], [3]],
    },
  }
  const text = renderPatchYaml([one])
  const parsed = parsePatchYaml(text).entries
  assert.deepEqual(parsed[0].config, one.config)
  assert.equal(renderPatchYaml(parsed), text, 'render∘parse∘render 是不动点')
  assert.equal(renderPatchYaml([], ['b']), '- insert:\n- remove:\n    - id: b\n')
})

test('slim: patch.merge 干净合并 / 冲突形状 / 确定性', () => {
  const args = () => ({
    base: B('- insert:\n    - id: a\n'),
    ours: B('- insert:\n    - id: a\n    - id: b\n'),
    theirs: B('- insert:\n    - id: a\n    - id: c\n'),
    path: 'cordis.patch.yml',
  })
  const out = patchMerge(args())
  assert.equal(out.kind, 'merged')
  assert.deepEqual(parsePatchYaml(out.data.toString()).entries.map((e) => e.id), ['a', 'b', 'c'])
  assert.equal(patchMerge(args()).data.toString(), out.data.toString(), '确定性')
  const conflict = patchMerge({
    base: B('- insert:\n    - id: a\n      config:\n        v: 1\n'),
    ours: B('- insert:\n    - id: a\n      config:\n        v: 2\n'),
    theirs: B('- insert:\n    - id: a\n      config:\n        v: 3\n'),
    path: 'p.yml',
  })
  assert.equal(conflict.kind, 'conflict')
  assert.ok(conflict.conflicts.length > 0)
  assert.equal(conflict.kept, undefined, '冲突形状里不带 kept')
})

/* ───────────────── credentials ───────────────── */

test('slim: expiryCandidates 挖时间的五条路径 + 哨兵拒绝', () => {
  const soon = Date.now() + 3600_000
  assert.deepEqual(expiryCandidates(null), { p: null, s: null })
  assert.deepEqual(expiryCandidates(undefined), { p: null, s: null })
  assert.deepEqual(expiryCandidates('not-a-time'), { p: null, s: null })
  assert.deepEqual(expiryCandidates({ payload: {} }), { p: null, s: null })
  assert.equal(expiryCandidates(String(soon)).p, soon, 'epoch ms 字符串')
  // ★ 现状契约：**裸数字不是时间源**（只有字符串与对象会被下钻）。
  assert.deepEqual(expiryCandidates(soon), { p: null, s: null })
  assert.equal(expiryCandidates({ expires_at: soon }).p, soon, '具名时间字段的数字才认')
  assert.equal(expiryCandidates('2030-01-02T03:04:05Z').p, Date.parse('2030-01-02T03:04:05Z'), 'ISO 串')
  assert.equal(expiryCandidates(JSON.stringify({ access_token: 't', expires_at: soon })).p, soon, 'JSON 文本里的字段')
  assert.equal(expiryCandidates({ payload: { expires_at: soon } }).p, soon, 'record 只看 payload')
  assert.equal(expiryCandidates({ payload: { expires_at: soon, refresh_token_expire_time: soon + 1000 } }).s, soon + 1000, 'refresh 归次时间戳')
  assert.equal(expiryCandidates({ expires_at: Number.MAX_SAFE_INTEGER }).p, null, '哨兵值（永不过期）必须拒绝')
  const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: Math.floor(soon / 1000) })).toString('base64url')}.sig`
  assert.equal(expiryCandidates(jwt).p, Math.floor(soon / 1000) * 1000, 'JWT exp')
  assert.equal(expiryCandidates('a.b.c').p, null, '不是 JWT 就不猜')
})

test('slim: newerThan 两级比较（主相等比次）', () => {
  assert.equal(newerThan({ p: 2, s: null }, { p: 1, s: 9 }), 1, '主时间戳优先')
  assert.equal(newerThan({ p: 1, s: 9 }, { p: 1, s: 2 }), 1, '主相等比次')
  assert.equal(newerThan({ p: null, s: 1 }, { p: null, s: null }), 1)
  assert.equal(newerThan({ p: 1, s: null }, { p: null, s: 9 }), 1)
  assert.equal(newerThan({ p: null, s: null }, { p: 1, s: null }), -1)
  assert.equal(newerThan({ p: 5, s: 5 }, { p: 5, s: 5 }), 0)
})

test('slim: degraded 只对 rec 生效', () => {
  assert.equal(degraded('ref', { payload: { access: '' } }), false)
  assert.equal(degraded('rec', { payload: { access: '' } }), true)
  // ★ 现状：`??` 链会跳过 null，于是 access_token:null 被当成"没有该字段"→ 判未退化。
  //   （存疑行为，已记入报告；精简不得改变它。）
  assert.equal(degraded('rec', { payload: { access_token: null } }), false)
  assert.equal(degraded('rec', { payload: { type: 'oauth', access: 'x' } }), true, 'oauth 无 refresh')
  assert.equal(degraded('rec', { payload: { type: 'oauth', access: 'x', refresh: 'r' } }), false)
  assert.equal(degraded('rec', { payload: { access: 'x' } }), false)
  assert.equal(degraded('rec', {}), false)
})

test('slim: decide 主判决 + 墓碑闸门（顺序：墓碑先于单边分支）', () => {
  const c = (present, value) => (present ? { present: true, value } : { present: false })
  assert.equal(decide('ref', c(true, 'b'), c(true, 'b'), c(true, 'b')).reason, 'no-change')
  assert.equal(decide('ref', c(true, 'b'), c(true, 'l'), c(true, 'b')).side, 'local')
  assert.equal(decide('ref', c(true, 'b'), c(true, 'b'), c(true, 'r')).side, 'remote')
  assert.equal(decide('ref', c(true, 'b'), c(false), c(false)).reason, 'both-deleted')
  assert.equal(decide('ref', c(true, 'b'), c(true, 'x'), c(true, 'x')).reason, 'both-changed-identically')
  // 墓碑：本地已删、远端拿旧值来 → 保持删除（dL=false,dR=true 的 remote-only 陷阱）。
  const tomb = { at: Date.now() }
  const kept = decide('ref', c(false), c(false), c(true, 'stale'), tomb)
  assert.equal(kept.present, false)
  assert.match(kept.reason, /^tombstone/u)
  // 删除后真的重建（晚于墓碑 + 宽限）→ 放行。
  const revived = decide('ref', c(false), c(false), c(true, String(Date.now() + 600_000)), tomb)
  assert.equal(revived.present, true)
  assert.match(revived.reason, /^resurrect/u)
  // 无墓碑、存活方（本地）比 base 新 → 采纳为"刷新"（远端已删、本地改新）。
  assert.match(decide('ref', c(true, 'old'), c(true, String(Date.now() + 600_000)), c(false)).reason, /^revive/u)
  // 无墓碑、无法证明更新 → 保住改动方 + 隔离（绝不静默删）。
  const amb = decide('ref', c(true, 'base'), c(true, 'mine'), c(false))
  assert.equal(amb.present, true)
  assert.equal(amb.side, 'local')
  assert.match(amb.reason, /^ambiguous/u)
  assert.deepEqual(amb.quarantine, { side: 'delete', deletedOn: 'remote' })
})

test('slim: eqCell / snapshotOf 归一', () => {
  const c = (present, value) => (present ? { present: true, value } : { present: false })
  assert.equal(eqCell('ref', c(false), c(false)), true)
  assert.equal(eqCell('ref', c(true, 'a'), c(true, 'a')), true)
  assert.equal(eqCell('ref', c(true, 'a'), c(true, 'b')), false)
  assert.equal(eqCell('rec', c(true, { a: 1, b: 2 }), c(true, { b: 2, a: 1 })), true, 'rec 比结构，键序无关')
  assert.equal(eqCell('rec', c(true, { a: 1 }), c(true, { a: '1' })), false)
  assert.equal(eqCell('ref', c(true), c(false)), false, 'present 翻转')
  const s = snapshotOf({ refs: { A: 'x' }, records: { 'p/n': { kind: 'grant' } } })
  assert.deepEqual([...s.refs], [['A', 'x']])
  assert.deepEqual([...s.records], [['p/n', { kind: 'grant' }]])
  assert.deepEqual([...snapshotOf(undefined).refs], [])
  assert.deepEqual([...snapshotOf({ refs: 'str' }).refs], [], '非对象源 → 空表')
})

test('slim: mergeCredentials 报告分桶 + 墓碑维护 + skipKeys', () => {
  const snap = (refs, records) => ({ refs: new Map(Object.entries(refs)), records: new Map(Object.entries(records)) })
  const r = mergeCredentials(
    snap({ A: 'b' }, { 'p/n': { kind: 'grant', payload: { v: 1 } } }),
    snap({ A: 'b', L: 'l' }, { 'p/n': { kind: 'grant', payload: { v: 1 } } }),
    snap({ A: 'r' }, { 'p/n': { kind: 'grant', payload: { v: 2 } } }),
  )
  assert.deepEqual([...r.merged.refs].sort(), [['A', 'r'], ['L', 'l']])
  assert.ok(r.report.adopted.some(([ns, k]) => ns === 'ref' && k === 'A'))
  assert.ok(r.report.kept.some(([ns, k]) => ns === 'ref' && k === 'L'))
  assert.ok(r.report.adopted.some(([ns, k]) => ns === 'ref' && k === 'L') === false)
  // 本地删除 + 结果仍是删除 ⇒ 记墓碑，且 at 保留最早值。
  const now = 1_700_000_000_000
  const del = mergeCredentials(snap({ K: 'v' }, {}), snap({}, {}), snap({ K: 'v' }, {}), { now })
  assert.equal(del.tombstones.get('ref:K').at, now)
  const again = mergeCredentials(snap({ K: 'v' }, {}), snap({}, {}), snap({ K: 'v' }, {}), { now: now + 5000, tombstones: del.tombstones })
  assert.equal(again.tombstones.get('ref:K').at, now, 'at 不得被刷新（否则 TTL 永不过期）')
  // TTL 之外墓碑退休。
  const expired = mergeCredentials(snap({ K: 'v' }, {}), snap({}, {}), snap({}, {}), { now: now + 100 * 24 * 3600_000, tombstones: new Map([['ref:K', { at: now }]]) })
  assert.equal(expired.tombstones.has('ref:K'), false, 'TTL 之外墓碑退休')
  // ★ 现状：墓碑清理只覆盖"出现在 base/ours/theirs 里的键"；孤零零的墓碑留给
  //   state.mjs 的 updateTombstones 兜底（合并器不负责全表清扫）。
  const lonely = mergeCredentials(snap({}, {}), snap({}, {}), snap({}, {}), { now: now + 100 * 24 * 3600_000, tombstones: new Map([['ref:GONE', { at: now }]]) })
  assert.equal(lonely.tombstones.has('ref:GONE'), true)
  // skipKeys。
  const skipped = mergeCredentials(snap({}, {}), snap({}, {}), snap({ S: 'x' }, {}), { skipKeys: new Set(['S']) })
  assert.equal(skipped.merged.refs.size, 0)
  assert.deepEqual(skipped.report.skipped, [['ref', 'S', 'skip-listed']])
})

test('slim: credentials.merge 的 cell 契约（Buffer 必须响亮拒绝）', () => {
  const c = (present, value) => (present ? { present: true, value } : { present: false })
  assert.equal(credMerge({ ns: 'ref', base: c(true, 'b'), ours: c(true, 'b'), theirs: c(true, 't') }).kind, 'take-theirs')
  assert.equal(credMerge({ ns: 'ref', base: c(true, 'b'), ours: c(true, 'b'), theirs: c(true, 'b') }).kind, 'keep-ours')
  assert.equal(credMerge({ ns: 'ref', base: c(true, 'b'), ours: c(false), theirs: c(false) }).delete, true)
  assert.throws(() => credMerge({ ours: B('x'), theirs: B('y'), path: '.credentials.yaml' }), (e) => e.code === 'BAD_INPUT')
})

/* ───────────────── credyaml 往返 ───────────────── */

const CRED_DOC = [
  'version: 1',
  'records:',
  '  acme/grant:',
  '    kind: grant',
  "    key: 'acme'",
  '    env:',
  "      ACME_ID: 'id-1'",
  "      ACME_SECRET: 'sec-1'",
  '    payload:',
  '      version: 1',
  "      scope: 'all'",
  'refs:',
  "  PLAIN: 'v'",
  "  FOLDED: '{\"a\":\"xxxx",
  '    yyyy"}\'',
  '',
].join('\n')

test('slim: credyaml parse 逐字段（env 块 / 折行 ref / 嵌套 payload）', () => {
  const p = parseCredYaml(CRED_DOC)
  assert.deepEqual(p.records.map(([k]) => k), ['acme/grant'])
  const rec = p.records[0][1]
  assert.deepEqual(rec.env, { ACME_ID: 'id-1', ACME_SECRET: 'sec-1' })
  assert.deepEqual(rec.payload, { version: 1, scope: 'all' }, 'payload 是 YAML 映射，不是 JSON 串')
  assert.equal(rec.kind, 'grant')
  assert.equal(rec.key, 'acme')
  assert.deepEqual(p.refs.map(([k]) => k), ['PLAIN', 'FOLDED'])
  assert.equal(p.refs[1][1], '{"a":"xxxx yyyy"}', '折行按 YAML 语义折成一个空格')
})

test('slim: credyaml 往返逐字节相等（值未变就原样吐回）', () => {
  assert.equal(renderCredYaml(parseCredYaml(CRED_DOC)), CRED_DOC)
  assert.equal(renderCredYaml(parseCredYaml(renderCredYaml(parseCredYaml(CRED_DOC)))), CRED_DOC, '幂等')
})

test('slim: credyaml CRLF 逐字节保真 + 段序保持', () => {
  const crlf = CRED_DOC.replaceAll('\n', '\r\n')
  const parsed = parseCredYaml(crlf)
  assert.equal(parsed.refs.length, 2, 'CRLF 下也必须解析出条目（正则 . 不匹配 \\r）')
  assert.equal(renderCredYaml(parsed), crlf, 'CRLF 原样吐回')
})

test('slim: credyaml 删除键 → 整块移除；新增键 → 退回规范形态', () => {
  const parsed = parseCredYaml(CRED_DOC)
  const dropRef = { ...parsed, refs: parsed.refs.filter(([k]) => k !== 'FOLDED') }
  const out = renderCredYaml(dropRef)
  assert.deepEqual(parseCredYaml(out).refs.map(([k]) => k), ['PLAIN'])
  assert.ok(!out.includes('FOLDED'), '被删的条目整块消失')
  // 新增键不在原始形态里 → 无法定位插入点 → 整份规范渲染（段序 records→refs）。
  const added = { ...parsed, refs: [...parsed.refs, ['NEW', 'n']] }
  const canon = renderCredYaml(added)
  assert.deepEqual(parseCredYaml(canon).refs.map(([k]) => k), ['PLAIN', 'FOLDED', 'NEW'])
  assert.ok(canon.startsWith('version: 1'), 'DSH 全拒式解析要求 version: 1 打头')
})

test('slim: credyaml 无 chunks 时走规范渲染（conflicts 的生产路径）', () => {
  const out = renderCredYaml({ refs: new Map([['A', 'x']]), records: new Map([['p/n', { kind: 'grant', payload: { v: 1 }, extra: 'e' }]]) })
  assert.ok(out.startsWith('version: 1'))
  assert.ok(out.includes('records:'))
  assert.ok(out.includes('refs:'))
  assert.ok(out.indexOf('records:') < out.indexOf('refs:'), '段序 records → refs')
  const back = parseCredYaml(out)
  assert.deepEqual(back.refs, [['A', 'x']])
  assert.equal(back.records[0][1].payload.v, 1)
  assert.equal(back.records[0][1].extra, 'e', '白名单之外的字段也要留住')
})

test('slim: credyaml 空段写成 refs: {}（裸 refs: 在 YAML 里是 null）', () => {
  const src = 'version: 1\nrefs:\n  A: \'x\'\nrecords:\n  p/n:\n    kind: grant\n'
  const parsed = parseCredYaml(src)
  const emptied = { ...parsed, refs: [] }
  const out = renderCredYaml(emptied)
  assert.ok(out.includes('refs: {}'), '空段必须是空映射而非 null')
})

/* ───────────────── conflicts 端到端 ───────────────── */

test('slim: resolveOne 分区分派（凭据 / patch / tree / json）', () => {
  const creds = resolveOne({
    sectionId: 'credentials', base: undefined,
    ours: B("version: 1\nrefs:\n  A: 'l'\n"), theirs: B("version: 1\nrefs:\n  B: 'r'\n"), path: '.credentials.yaml',
  })
  assert.equal(creds.kind, 'merged')
  assert.deepEqual(parseCredYaml(creds.data.toString()).refs.map(([k]) => k).sort(), ['A', 'B'])

  const patch = resolveOne({
    sectionId: 'home-patch', base: B('- insert:\n    - id: a\n'),
    ours: B('- insert:\n    - id: a\n- remove:\n    - id: gone\n'), theirs: B('- insert:\n    - id: a\n'), path: 'cordis.patch.yml',
  })
  assert.deepEqual(parsePatchYaml(patch.data.toString()).removes, ['gone'], 'remove 不得丢')

  const tree = resolveOne({ sectionId: 'skills-dsh', base: B('l1\n'), ours: B('l1\nl2\n'), theirs: B('l1\nl3\n'), path: 'skills/a/S.md' })
  assert.equal(tree.kind, 'take-theirs')
  assert.ok(tree.data.toString().includes('l2') && tree.data.toString().includes('l3'))

  const json = resolveOne({ sectionId: 'workspace', base: B('{"a":1,"b":2}'), ours: B('{"a":1,"b":3}'), theirs: B('{"a":9,"b":2}'), path: 'storages/workspace.json' })
  assert.equal(json.kind, 'merged')
  assert.deepEqual(JSON.parse(json.data.toString()), { a: 9, b: 3 })
})

/* ───────────────── 三不变量总扫 ───────────────── */

test('不变量: 每个合并入口都是确定性的（同输入 → 同输出）', () => {
  const args = () => ({
    base: B('- insert:\n    - id: a\n      config:\n        v: 1\n'),
    ours: B('- insert:\n    - id: a\n      config:\n        v: 2\n'),
    theirs: B('- insert:\n    - id: a\n      config:\n        v: 3\n'),
    path: 'p.yml',
  })
  assert.equal(patchMerge(args()).data.toString(), patchMerge(args()).data.toString())
  const j = () => ({ base: B('{"a":{"x":1}}'), ours: B('{"a":{"x":2}}'), theirs: B('{"a":{"y":3}}'), path: 'w.json' })
  assert.equal(jsonMerge(j()).data.toString(), jsonMerge(j()).data.toString())
  const t = () => ({ base: B('base'), ours: B('zzz'), theirs: B('yyy'), path: 'a', deviceId: 'devAAAAA', now: 1 })
  assert.equal(treeMerge(t()).data.toString(), treeMerge(t()).data.toString())
  const tm = () => ({
    base: new Map([['a', entry('base', 1)]]),
    ours: new Map([['a', entry('zzz', 2)]]),
    theirs: new Map([['a', entry('yyy', 3)]]),
    deviceId: 'devAAAAA', remoteDeviceId: 'devBBBBB', now: Date.UTC(2026, 0, 2),
  })
  assert.deepEqual(mergeTree(tm()).forks.map((f) => f.rel), mergeTree(tm()).forks.map((f) => f.rel))
  assert.equal(classifyPath(B('b'), B('o'), B('t')).kind, classifyPath(B('b'), B('o'), B('t')).kind)
})

test('不变量: 二次合并（幂等）—— 对已合并结果再合并不得产生新分歧', () => {
  const merged = B('- insert:\n    - id: a\n      config:\n        v: 2\n    - id: b\n')
  const r = mergePatchEntries(parsePatchYaml(merged.toString()).entries, parsePatchYaml(merged.toString()).entries, parsePatchYaml(merged.toString()).entries)
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.merged.map((e) => e.id), ['a', 'b'])
  const json = mergeJson({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1, b: 2 })
  assert.equal(json.conflicts.length, 0)
  assert.deepEqual(json.merged, { a: 1, b: 2 })
  assert.equal(classifyPath(B('m'), B('m'), B('m')).forkTheirs, false)
  const tree = mergeTree({ base: new Map([['a', entry('m', 1)]]), ours: new Map([['a', entry('m', 1)]]), theirs: new Map([['a', entry('m', 1)]]) })
  assert.equal(tree.forks.length, 0)
})

test('不变量: 任何分歧都不静默丢字节（keepboth/tree/patch/json 各扫一遍）', () => {
  const o = B('ours-bytes')
  const t = B('theirs-bytes')
  const kb = classifyPath(B('base'), o, t)
  assert.equal(kb.keepOurs, true)
  assert.equal(kb.forkTheirs, true, 'keepboth：分歧 → 远端字节必须转 fork')
  const tree = mergeTree({ base: new Map([['a', entry('base', 1)]]), ours: new Map([['a', entry('zzz', 2)]]), theirs: new Map([['a', entry('yyy', 3)]]), now: 1 })
  assert.equal(tree.forks.length, 1, 'tree：LWW 落败方必须转冲突副本')
  assert.ok(['zzz', 'yyy'].includes(tree.forks[0].data.toString()))
  const patch = mergePatchEntries(
    parsePatchYaml('- insert:\n    - id: a\n      config:\n        v: 1\n').entries,
    parsePatchYaml('- insert:\n    - id: a\n      config:\n        v: 2\n').entries,
    parsePatchYaml('- insert:\n    - id: a\n      config:\n        v: 3\n').entries,
  )
  assert.equal(patch.conflicts.length, 1, 'patch：字段冲突必须上报')
  assert.equal(patch.merged[0].config.v, 2, 'patch：冲突保本地（远端值由宿主隔离）')
})
