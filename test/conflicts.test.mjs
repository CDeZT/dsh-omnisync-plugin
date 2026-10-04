// test/conflicts.test.mjs — 冲突裁决（分区策略 → 工作树动作）。
//
// 用假 git 捕获调度动作，断言"裁决结果"与"对工作树的动作"正确对应。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveOne, resolveAll } from '../lib/conflicts.mjs'
import { parseCredYaml, renderCredYaml } from '../lib/credyaml.mjs'
import { updateTombstones } from '../lib/state.mjs'
import { fakeGit } from './helpers.mjs'

const B = (s) => Buffer.from(s, 'utf8')

/** 假 git：记录 checkout/add 动作，返回预设的索引阶段内容。 */
test('conflicts: keepboth 分歧 → 保本地 + 远端转 fork', async () => {
  const git = fakeGit(
    { 'a.txt': { 1: B('base'), 2: B('mine'), 3: B('theirs') } },
    [{ path: 'a.txt' }],
  )
  const written = []
  const r = await resolveAll({
    git,
    sectionOf: () => 'instructions',
    deviceId: () => 'dev12345',
    writeTree: async (rel, data) => { written.push([rel, data.toString()]); return true },
  })
  assert.ok(git.actions.includes('checkout:ours:a.txt'), '分歧时保留本地（git 检出 ours 到工作树）')
  assert.equal(written.length, 2, '本地内容 + fork 文件')
  assert.equal(written[0][1], 'mine', '本地内容保持不变（绝不覆盖）')
  const fork = written.find(([rel]) => rel.includes('remote-fork'))
  assert.ok(fork !== undefined, '必须生成 fork')
  assert.match(fork[0], /\.remote-fork-\d{14}-dev12345$/u)
  assert.equal(fork[1], 'theirs', 'fork 里必须是远端字节（绝不丢）')
  assert.equal(r.forks.length, 1)
})

test('conflicts: keepboth 仅远端改 → 采纳远端（checkout --theirs，不产生 fork）', async () => {
  // ours == base ⇒ 本地无增量 ⇒ 直接采纳远端（不是覆盖）。
  const git = fakeGit(
    { 'AGENTS.md': { 1: B('same'), 2: B('same'), 3: B('changed') } },
    [{ path: 'AGENTS.md' }],
  )
  const r = await resolveAll({
    git, sectionOf: () => 'instructions', deviceId: () => 'dev',
    writeTree: async () => { throw new Error('采纳远端时不该写工作树（git 自己检出）') },
  })
  assert.ok(git.actions.includes('checkout:theirs:AGENTS.md'))
  assert.equal(r.forks.length, 0, '本地没有增量可丢，无需 fork')
})

test('conflicts: JSON 合并结果会被写回工作树（不经 checkout）', async () => {
  const git = fakeGit(
    { 'storages/workspace.json': { 1: B('{"a":1,"b":2}'), 2: B('{"a":1,"b":3}'), 3: B('{"a":9,"b":2}') } },
    [{ path: 'storages/workspace.json' }],
  )
  const written = []
  const r = await resolveAll({
    git, sectionOf: () => 'workspace', deviceId: () => 'dev',
    writeTree: async (rel, data) => { written.push([rel, data.toString()]); return true },
  })
  assert.ok(git.actions.includes('checkout:ours:storages/workspace.json'), '先检出 ours 作为底')
  assert.equal(written.length, 1)
  assert.deepEqual(JSON.parse(written[0][1]), { a: 9, b: 3 }, '合并结果必须落盘')
  assert.equal(r.conflicts.length, 0, '干净合并不算冲突')
})

test('conflicts: JSON 双侧改不同 key → 干净合并且落盘', () => {
  const out = resolveOne({
    sectionId: 'workspace',
    base: B('{"a":1,"b":2}'),
    ours: B('{"a":1,"b":3}'),
    theirs: B('{"a":9,"b":2}'),
    path: 'workspace.json',
  })
  assert.equal(out.kind, 'merged')
  assert.deepEqual(JSON.parse(out.data.toString()), { a: 9, b: 3 })
})

test('conflicts: 凭据走记录级合并（不是字节级 fork）', () => {
  const base = ['version: 1', 'refs:', "  K: '{\"access_token\":\"old\",\"expires_at\":\"1792000000000\"}'"].join('\n')
  const ours = ['version: 1', 'refs:', "  K: '{\"access_token\":\"L\",\"expires_at\":\"1792100000000\"}'"].join('\n')
  const theirs = ['version: 1', 'refs:', "  K: '{\"access_token\":\"R\",\"expires_at\":\"1792245217674\"}'"].join('\n')
  const out = resolveOne({ sectionId: 'credentials', base: B(base), ours: B(ours), theirs: B(theirs), path: '.credentials.yaml' })
  assert.equal(out.kind, 'merged', '单一键可自动裁决，不该报冲突')
  const merged = parseCredYaml(out.data.toString())
  assert.equal(JSON.parse(merged.refs[0][1]).access_token, 'R', '取过期时间新的')
  assert.ok(out.note.includes('adopted'), 'note 应报告裁决统计')
})

test('conflicts: patch 条目级合并（不同 id 双侧新增 → 并集）', () => {
  const base = '- insert:\n    - id: shared\n'
  const ours = '- insert:\n    - id: shared\n    - id: local-only\n      config:\n        port: 19387\n'
  const theirs = '- insert:\n    - id: shared\n    - id: remote-only\n'
  const out = resolveOne({
    sectionId: 'home-patch', base: B(base), ours: B(ours), theirs: B(theirs), path: 'cordis.patch.yml',
  })
  assert.equal(out.kind, 'merged')
  const text = out.data.toString()
  for (const id of ['shared', 'local-only', 'remote-only']) assert.ok(text.includes(id), `${id} 必须在合并结果里`)
})

test('conflicts: credits 渲染回 .credentials.yaml 能过 DSH 解析形态（version: 1）', () => {
  const out = resolveOne({
    sectionId: 'credentials',
    base: undefined,
    ours: B('version: 1\nrefs:\n  A: x\n'),
    theirs: B('version: 1\nrefs:\n  B: y\n'),
    path: '.credentials.yaml',
  })
  const text = out.data.toString()
  assert.ok(text.startsWith('version: 1'), 'DSH 全拒式解析要求 version: 1 打头')
  assert.equal(renderCredYaml({ refs: new Map([['A', 'x']]), records: new Map() }).startsWith('version: 1'), true)
})

test('conflicts: 无冲突路径时是空操作（不产生多余 add）', async () => {
  const git = fakeGit({}, [])
  const r = await resolveAll({ git, sectionOf: () => 'instructions', deviceId: () => 'd', writeTree: async () => true })
  assert.deepEqual(r, { conflicts: [], forks: [], deleted: [] })
  assert.deepEqual(git.actions, ['add-all'])
})

test('墓碑: 阻止"删除被过期副本复活"（本轮接通的真功能）', () => {
  const withKey = (v) => Buffer.from(`version: 1\nrefs:\n  KEY: '${v}'\n`)
  const now = 1_700_000_000_000

  // 场景（真实发生路径）：
  //   A 机删掉 KEY 并推送 → B 机拉取时 base 有 KEY、theirs 没有 → 合并删除，
  //   并在 B 机记下墓碑。之后若有一台**从未同步过的 C 机**把旧副本推上来，
  //   B 机的三方基点里没有 KEY（=无基点），两方比较会判成 "theirs-only" →
  //   复活。墓碑补的正是这个信息。

  // ① 收到删除时，必须报出被删的键（供记墓碑）。
  const deletion = resolveOne({
    sectionId: 'credentials',
    base: withKey('old'), ours: withKey('old'), theirs: Buffer.from('version: 1\nrefs: {}\n'),
    path: '.credentials.yaml', now,
  })
  assert.equal(deletion.kind, 'merged')
  assert.deepEqual(deletion.deleted, ['ref:KEY'], '被删的键必须被报出来')

  // ② 记墓碑后，过期副本推上来 → 必须保持删除。
  const tombstones = updateTombstones({}, deletion.deleted, now)
  const stale = resolveOne({
    sectionId: 'credentials',
    base: undefined,                        // ← 无基点（C 机从未同步）
    ours: Buffer.from('version: 1\nrefs: {}\n'),  // 本机已删除
    theirs: withKey('old'),                 // C 机的过期副本
    path: '.credentials.yaml', now: now + 1000, tombstones,
  })
  assert.equal(parseCredYaml(stale.data.toString()).refs.length, 0, '墓碑生效：过期副本不得复活已删的键')

  // ③ 删除之后**真的重建**（时间戳晚于墓碑 + 重建宽限期 60s）→ 允许。
  const recreated = withKey('{"access_token":"new","expires_at":"' + (now + 600_000) + '"}')
  const allow = resolveOne({
    sectionId: 'credentials', base: undefined,
    ours: Buffer.from('version: 1\nrefs: {}\n'), theirs: recreated,
    path: '.credentials.yaml', now: now + 1000, tombstones,
  })
  assert.equal(parseCredYaml(allow.data.toString()).refs.length, 1, '删除后重建应被接受')

  // ④ 墓碑过期 → 不再阻止（否则永远无法重建）。
  assert.deepEqual(updateTombstones(tombstones, [], now + 100 * 24 * 3600_000), {})
})

test('墓碑: updateTombstones 保留最早的 at（TTL 才会到期）', () => {
  const first = updateTombstones({}, ['ref:A'], 1000)
  const again = updateTombstones(first, ['ref:A'], 9999)
  assert.equal(again['ref:A'].at, 1000, '重复记录不得刷新 at，否则墓碑永不过期')
})
