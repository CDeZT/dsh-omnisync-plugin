// test/mergers.test.mjs — 合并内核行为锁定（node --test，零依赖）。
//
// 覆盖三大不变量：① 绝不丢失（ours/theirs 字节必存续）② 确定性（同输入同输出）
// ③ 幂等（对已合并结果再合并不产生新 fork）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergerFor, SECTION_MERGER } from '../lib/mergers/index.mjs'
import { classifyPath, planMerge, forkName } from '../lib/mergers/keepboth.mjs'
import { mergeJson, deepEqual, unionKeys } from '../lib/mergers/json.mjs'
import { mergeTree, lwwPick, tryLineMerge, conflictName } from '../lib/mergers/tree.mjs'
import { MERGE_KINDS } from '../lib/constants.mjs'

const B = (s) => Buffer.from(s, 'utf8')
const entry = (s, mtimeMs) => ({ data: B(s), mtimeMs })

/* ───────────────────────── keepboth ───────────────────────── */

test('keepboth: 五分类逐项', () => {
  assert.equal(classifyPath(B('a'), B('a'), B('a')).kind, MERGE_KINDS.IDENTICAL)
  assert.equal(classifyPath(B('a'), B('ab'), B('a')).kind, MERGE_KINDS.OURS_ONLY)
  assert.equal(classifyPath(B('a'), B('a'), B('ab')).kind, MERGE_KINDS.THEIRS_ONLY)
  assert.equal(classifyPath(B('a'), B('ab'), B('ac')).kind, MERGE_KINDS.APPEND_BOTH)
  assert.equal(classifyPath(B('a'), B('zz'), B('yy')).kind, MERGE_KINDS.DIVERGED)
})

test('keepboth: 单侧缺失的语义', () => {
  // 双侧都无 → identical（无内容可争）
  assert.equal(classifyPath(undefined, undefined, undefined).kind, MERGE_KINDS.IDENTICAL)
  // 远端有本地无，base 也是无 → 远端新增 → 采纳
  assert.equal(classifyPath(undefined, undefined, B('new')).kind, MERGE_KINDS.THEIRS_ONLY)
  // 本地有远端无，base 无 → 本地新增 → 保留
  assert.equal(classifyPath(undefined, B('new'), undefined).kind, MERGE_KINDS.OURS_ONLY)
})

test('keepboth: 绝不丢失字节（双分支都存续）', () => {
  const ours = B('line1\nline2\n')
  const theirs = B('line1\nline2\nline3-remote\n')
  const base = B('line1\n')
  const v = classifyPath(base, ours, theirs)
  assert.equal(v.kind, MERGE_KINDS.APPEND_BOTH)
  assert.equal(v.keepOurs, true)
  assert.equal(v.forkTheirs, true, 'thence 必须转 fork，不能丢')
})

test('keepboth: 二进制（zstd 形态）按同一套规则', () => {
  const base = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const ours = Buffer.concat([base, Buffer.from([1, 2, 3])])
  const theirs = Buffer.concat([base, Buffer.from([4, 5, 6])])
  assert.equal(classifyPath(base, ours, theirs).kind, MERGE_KINDS.APPEND_BOTH)
})

test('keepboth: 幂等（对已合并结果再合并不产生新 fork）', () => {
  const merged = B('line1\nline2\nline3-remote\n')
  const v = classifyPath(merged, merged, merged)
  assert.equal(v.kind, MERGE_KINDS.IDENTICAL)
  assert.equal(v.forkTheirs, false)
})

test('keepboth: fork 命名是 14 位戳 + 8 位设备，且能被正则识别', async () => {
  const name = forkName('sessions/p/session.v4.jsonl.zstd', 'a1b2c3d4', Date.UTC(2026, 0, 2, 3, 4, 5))
  assert.equal(name, 'sessions/p/session.v4.jsonl.zstd.remote-fork-20260102030405-a1b2c3d4')
  const { FORK_NAME_RE } = await import('../lib/constants.mjs')
  assert.ok(FORK_NAME_RE.test(name), 'fork 名必须命中 FORK_NAME_RE（防重复 fork 的判据）')
})

test('keepboth: planMerge 汇总计数', () => {
  const { resolutions, summary } = planMerge([
    { path: 'a', base: B('x'), ours: B('x'), theirs: B('y') },   // theirs-only → adopted
    { path: 'b', base: B('x'), ours: B('xy'), theirs: B('x') },  // ours-only → kept
    { path: 'c', base: B('x'), ours: B('xy'), theirs: B('xz') }, // append-both → fork
    { path: 'd', base: B('x'), ours: B('mm'), theirs: B('nn') }, // diverged → fork
  ], { deviceId: 'dev12345', now: Date.UTC(2026, 0, 2) })
  assert.equal(summary.adopted, 1)
  assert.equal(summary.appended, 1)
  assert.equal(summary.diverged, 1)
  assert.equal(summary.forkPaths.length, 2)
  assert.equal(resolutions.length, 4)
})

test('keepboth: 未知策略回落 keepboth（默认安全）', () => {
  assert.equal(mergerFor('does-not-exist'), SECTION_MERGER.get('keepboth'))
})

/* ───────────────────────── json ───────────────────────── */

test('json: 双侧改不同 key → 干净合并无冲突', () => {
  const { merged, conflicts } = mergeJson({ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 9, b: 2 })
  assert.deepEqual(merged, { a: 9, b: 3 })
  assert.equal(conflicts.length, 0)
})

test('json: 双侧独立改成同值 → 不算冲突', () => {
  const { merged, conflicts } = mergeJson({ a: 1 }, { a: 5 }, { a: 5 })
  assert.deepEqual(merged, { a: 5 })
  assert.equal(conflicts.length, 0)
})

test('json: 数组是标量（绝不 union）', () => {
  const { merged, conflicts } = mergeJson({ arr: [1, 2] }, { arr: [1, 2, 3] }, { arr: [9] })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].kind, 'value')
  assert.deepEqual(merged.arr, [1, 2, 3], '冲突时保本地')
})

test('json: 嵌套对象递归下钻', () => {
  const { merged, conflicts } = mergeJson(
    { llm: { deepseek: { key: 'a', base: 'u' }, xiaomi: { base: 'u' } } },
    { llm: { deepseek: { key: 'a', base: 'u' }, xiaomi: { base: 'local' } } },
    { llm: { deepseek: { key: 'b', base: 'u' }, xiaomi: { base: 'u' } } },
  )
  assert.equal(conflicts.length, 0)
  assert.equal(merged.llm.deepseek.key, 'b')
  assert.equal(merged.llm.xiaomi.base, 'local')
})

test('json: 删除语义（远端删 + 本地未改 → 跟随删除）', () => {
  const { merged } = mergeJson({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 })
  assert.equal(Object.hasOwn(merged, 'b'), false)
})

test('json: 删除 vs 修改 → 冲突且保本地', () => {
  const { merged, conflicts } = mergeJson({ b: 'orig' }, { b: 'mine' }, {})
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].kind, 'delete-vs-modify')
  assert.equal(merged.b, 'mine')
})

test('json: 深度闸（恶意深嵌套不炸栈）', () => {
  let ours = { v: 1 }
  let theirs = { v: 2 }
  for (let i = 0; i < 40; i++) { ours = { n: ours }; theirs = { n: theirs } }
  const { conflicts } = mergeJson({}, ours, theirs, { maxDepth: 5 })
  assert.ok(conflicts.length > 0)
})

test('json: deepEqual 键序无关、数组序敏感', () => {
  assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
  assert.ok(!deepEqual([1, 2], [2, 1]))
  assert.ok(!deepEqual({ a: 1 }, { a: '1' }), '类型敏感')
})

test('json: unionKeys 保序去重', () => {
  assert.deepEqual(unionKeys({ a: 1, b: 2 }, { b: 9, c: 3 }), ['a', 'b', 'c'])
})

test('json: Merger 接口（Buffer 进出）', async () => {
  const { merge } = await import('../lib/mergers/json.mjs')
  const out = merge({
    base: B('{"a":1,"b":2}'),
    ours: B('{"a":1,"b":3}'),
    theirs: B('{"a":9,"b":2}'),
    path: 'x.json',
  })
  assert.equal(out.kind, 'merged')
  assert.deepEqual(JSON.parse(out.data.toString('utf8')), { a: 9, b: 3 })
})

test('json: 非法 JSON → 冲突不猜内容', async () => {
  const { merge } = await import('../lib/mergers/json.mjs')
  const out = merge({ base: B('{}'), ours: B('{broken'), theirs: B('{}'), path: 'x.json' })
  assert.equal(out.kind, 'conflict')
  assert.equal(out.keepOurs, true)
})

/* ───────────────────────── tree ───────────────────────── */

test('tree: 并集（新增条目都进结果）', () => {
  const r = mergeTree({
    ours: new Map([['a', entry('x', 1)]]),
    theirs: new Map([['a', entry('x', 1)], ['b', entry('y', 2)]]),
  })
  assert.deepEqual([...r.files.keys()].sort(), ['a', 'b'])
})

test('tree: 本地删 + 远端未改 → 跟随删除', () => {
  const r = mergeTree({
    base: new Map([['a', entry('base', 1)]]),
    ours: new Map(),
    theirs: new Map([['a', entry('base', 5)]]),
  })
  assert.equal(r.files.size, 0)
})

test('tree: 本地删 + 远端改 → 保留远端并记冲突', () => {
  const r = mergeTree({
    base: new Map([['a', entry('base', 1)]]),
    ours: new Map(),
    theirs: new Map([['a', entry('changed', 5)]]),
  })
  assert.equal(r.files.get('a').data.toString(), 'changed')
  assert.equal(r.conflicts[0].reason, 'local-deleted-remote-modified')
})

test('tree: 远端删 + 本地改 → 保留本地并记冲突（不丢本地改动）', () => {
  const r = mergeTree({
    base: new Map([['a', entry('base', 1)]]),
    ours: new Map([['a', entry('mine', 5)]]),
    theirs: new Map(),
  })
  assert.equal(r.files.get('a').data.toString(), 'mine')
  assert.equal(r.conflicts[0].reason, 'remote-deleted-local-modified')
})

test('tree: LWW 兜底是确定性的（mtime 等则设备 ID 小者胜）', () => {
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 100 }, { data: B('t'), mtimeMs: 200 }, 'aaaa', 'bbbb'), 'theirs')
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 200 }, { data: B('t'), mtimeMs: 100 }, 'aaaa', 'bbbb'), 'ours')
  // mtime 相等 → 设备 ID 字典序小者胜（两端各自裁决结果一致）
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 100 }, { data: B('t'), mtimeMs: 100 }, 'aaaa', 'bbbb'), 'ours')
  assert.equal(lwwPick({ data: B('o'), mtimeMs: 100 }, { data: B('t'), mtimeMs: 100 }, 'zzzz', 'bbbb'), 'theirs')
})

test('tree: 冲突副本不会被再次合并（防无限衍生）', () => {
  const forkRel = conflictName('skills/a/SKILL.md', 'deadbeef', Date.UTC(2026, 0, 2))
  const r = mergeTree({
    ours: new Map([[forkRel, entry('fork-content', 1)]]),
    theirs: new Map(),
  })
  assert.equal(r.files.get(forkRel).data.toString(), 'fork-content')
  assert.equal(r.forks.length, 0, '不得对冲突副本再产 fork')
})

test('tree: 二进制不走行合并', () => {
  const bin = Buffer.from([0x00, 0x01, 0x02])
  assert.equal(tryLineMerge(bin, bin, bin), null)
})

test('tree: 纯追加的文本可行级合并', () => {
  const merged = tryLineMerge(B('l1\n'), B('l1\nl2\n'), B('l1\nl3\n'))
  assert.ok(merged !== null)
  const text = merged.toString()
  assert.ok(text.includes('l2') && text.includes('l3'), '两侧新增行都要在')
})

test('tree: 幂等（同输入两次结果一致）', () => {
  const args = () => ({
    base: new Map([['a', entry('b', 1)]]),
    ours: new Map([['a', entry('mine', 5)]]),
    theirs: new Map([['a', entry('theirs', 9)]]),
    now: Date.UTC(2026, 0, 2),
  })
  const r1 = mergeTree(args())
  const r2 = mergeTree(args())
  assert.deepEqual([...r1.files.keys()], [...r2.files.keys()])
  assert.deepEqual(r1.forks.map((f) => f.rel), r2.forks.map((f) => f.rel))
})

test('tree: 空输入不炸', () => {
  const r = mergeTree({})
  assert.equal(r.files.size, 0)
  assert.equal(r.forks.length, 0)
})
