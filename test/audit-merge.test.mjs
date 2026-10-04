// test/audit-merge.test.mjs — 合并内核审计（task-2）。
//
// 每个用例都对应一个**真实可复现的缺陷**，先写测试再修（无失败测试的改动不算数）。
// 命名约定：`回归: <文件> — <症状>`。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { merge as jsonMerge } from '../lib/mergers/json.mjs'
import { merge as blobMerge } from '../lib/mergers/blob.mjs'
import { planMerge, classifyPath } from '../lib/mergers/keepboth.mjs'
import { merge as treeMerge, mergeTree } from '../lib/mergers/tree.mjs'
import { mergerFor } from '../lib/mergers/index.mjs'
import {
  mergePatchEntries, renderPatchYaml, parsePatchYaml, merge as patchMerge, mergeRemoves,
} from '../lib/mergers/patch-yaml.mjs'
import { resolveOne, resolveAll } from '../lib/conflicts.mjs'
import { parseCredYaml, renderCredYaml } from '../lib/credyaml.mjs'
import { deepEqual } from '../lib/mergers/equal.mjs'
import { fakeGit } from './helpers.mjs'

const B = (s) => Buffer.from(s, 'utf8')

/* ─────────────── 第 1 轮 ─────────────── */

test('回归: json.mjs — 顶层结果为 undefined 时写出字面量 "undefined"（损坏 JSON）', () => {
  // 本地删除、远端修改（无基点）→ 本地删除优先 ⇒ 结果应是"删除"，不是一段文本。
  const out = jsonMerge({ base: B('{"a":1}'), ours: undefined, theirs: B('{"a":2}'), path: 'x.json' })
  assert.equal(out.delete, true, '本地删除优先 → 必须标记 delete')
  assert.equal(out.data, undefined, '不得写盘')
  assert.equal(out.merged, undefined, '不得写盘')

  // 两侧都删 → 同样是删除。
  const both = jsonMerge({ base: B('{"a":1}'), ours: undefined, theirs: undefined, path: 'x.json' })
  assert.equal(both.delete, true, '两侧都删 → 必须标记 delete')
  assert.equal(both.data, undefined, '不得写盘')
})

test('回归: keepboth.mjs — planMerge 的 summary.forkPaths 报的是原路径，不是 fork 路径', () => {
  const { resolutions, summary } = planMerge(
    [{ path: 'sessions/a.jsonl', base: B('b'), ours: B('b+o'), theirs: B('b+t') }],
    { deviceId: 'devAAAAA', now: Date.UTC(2026, 0, 2) },
  )
  assert.match(resolutions[0].forkPath, /\.remote-fork-\d{14}-devAAAAA$/u)
  assert.deepEqual(summary.forkPaths, [resolutions[0].forkPath], '汇总必须报 fork 路径本身')
})

test('回归: conflicts.mjs — take-theirs 丢弃 outcome.data，tree 行级合并结果被扔掉', () => {
  // skills 分区用 tree 合并器：双侧纯追加 → 行级合并出 l1+l2+l3，
  // 但 tree.merge 归一到 take-theirs 且带 data —— 调用方若不认 data，本地新增行就丢了。
  const out = resolveOne({
    sectionId: 'skills-dsh',
    base: B('l1\n'),
    ours: B('l1\nl2\n'),
    theirs: B('l1\nl3\n'),
    path: 'skills/a/SKILL.md',
  })
  assert.equal(out.kind, 'take-theirs')
  assert.ok(out.data !== undefined, 'tree 行级合并结果必须带 data')
  assert.ok(out.data.toString().includes('l2'), '本地新增行不得丢失')
  assert.ok(out.data.toString().includes('l3'), '远端新增行不得丢失')
})

test('回归: conflicts.mjs — resolveAll 对 take-theirs+data 只 checkout 远端，合并结果不落盘', async () => {
  const git = fakeGit(
    { 'skills/a/SKILL.md': { 1: B('l1\n'), 2: B('l1\nl2\n'), 3: B('l1\nl3\n') } },
    [{ path: 'skills/a/SKILL.md' }],
  )
  const written = []
  await resolveAll({
    git,
    sectionOf: () => 'skills-dsh',
    deviceId: () => 'devAAAAA',
    writeTree: async (rel, data) => { written.push([rel, data.toString()]); return true },
  })
  const main = written.find(([rel]) => rel === 'skills/a/SKILL.md')
  assert.ok(main !== undefined, '行级合并结果必须写回工作树（否则本地新增行静默丢失）')
  assert.ok(main[1].includes('l2') && main[1].includes('l3'), '两侧新增行都要在')
})

test('回归: patch-yaml.mjs — renderPatchYaml 丢掉 remove: 指令（被删的配置会复活）', () => {
  const text = '- insert:\n    - id: a\n- remove:\n    - id: b\n'
  const parsed = parsePatchYaml(text)
  assert.deepEqual(parsed.removes, ['b'], '前置条件：解析层保留 remove')

  const rendered = renderPatchYaml(parsed.entries, parsed.removes)
  assert.deepEqual(parsePatchYaml(rendered).removes, ['b'], '渲染必须带上 remove')

  // 端到端：冲突裁决不得丢 remove。
  const out = resolveOne({
    sectionId: 'home-patch',
    base: B(text), ours: B(text), theirs: B('- insert:\n    - id: a\n    - id: c\n'),
    path: 'cordis.patch.yml',
  })
  assert.deepEqual(parsePatchYaml(out.data.toString()).removes, ['b'], '冲突裁决结果必须保留 remove')
})

test('回归: patch-yaml.mjs — 三层嵌套 / 嵌套数组渲染成 "[object Object]"（配置损坏）', () => {
  const entry = {
    id: 'x',
    config: {
      lvl1: { lvl2: { lvl3: 'deep' } },
      arr: [[1, 2], [3]],
      objs: [{ a: 1 }],
    },
  }
  const back = parsePatchYaml(renderPatchYaml([entry])).entries[0]
  assert.deepEqual(back.config, entry.config, '任意深度嵌套必须往返保真')
})

test('回归: tree.mjs — 本地落败时 fork 副本被冠上远端设备 ID（跨机不收敛）', () => {
  // 同一个分歧从两台机器看：A 机本地是 from-A、远端是 from-B（mtime 新）；
  // B 机本地是 from-B、远端是 from-A。两端都判 from-B 胜，输家都是 from-A 的字节。
  const view = (devO, devT, local, localMs, remote, remoteMs) => ({
    base: new Map([['a', { data: B('base'), mtimeMs: 1 }]]),
    ours: new Map([['a', { data: B(local), mtimeMs: localMs }]]),
    theirs: new Map([['a', { data: B(remote), mtimeMs: remoteMs }]]),
    deviceId: devO,
    remoteDeviceId: devT,
    now: Date.UTC(2026, 0, 2),
  })
  const fromA = mergeTree(view('devAAAAA', 'devBBBBB', 'from-A', 5, 'from-B', 9))
  const fromB = mergeTree(view('devBBBBB', 'devAAAAA', 'from-B', 9, 'from-A', 5))

  assert.equal(fromA.files.get('a').data.toString(), 'from-B', '两端都该收敛到 from-B')
  assert.equal(fromA.forks[0].data.toString(), 'from-A')
  assert.equal(fromB.forks[0].data.toString(), 'from-A')
  assert.match(fromA.forks[0].rel, /-devAAAAA$/u, 'fork 里的字节属于 A 机 → 名字必须标 A')
  assert.deepEqual(
    fromA.forks.map((f) => f.rel), fromB.forks.map((f) => f.rel),
    '同一分歧在两台机器上必须落到同一 fork 路径（否则各写各的、下轮再冲突）',
  )
})

/* ─────────────── 第 2 轮 ─────────────── */

test('回归: blob.mjs — 非 Buffer 入参直接 TypeError（契约与 keepboth 不一致）', () => {
  // Merger 契约只说 {base?, ours?, theirs?}；keepboth/tree 都做了 Buffer 归一。
  assert.equal(blobMerge({ ours: 'same', theirs: 'same', path: 'objects/ab/cd' }).kind, 'keep-ours')
  assert.equal(blobMerge({ ours: undefined, theirs: 'x', path: 'objects/ab/cd' }).kind, 'take-theirs')
  assert.throws(
    () => blobMerge({ ours: 'a', theirs: 'b', path: 'objects/ab/cd' }),
    (e) => e.code === 'SNAPSHOT_CORRUPT',
  )
})

test('blob: 同路径同内容 → 保留；内容不同 → 硬失败（既有行为固化）', () => {
  const same = B('payload')
  assert.equal(blobMerge({ ours: same, theirs: Buffer.from('payload'), path: 'objects/ab/cd' }).kind, 'keep-ours')
  assert.equal(blobMerge({ ours: undefined, theirs: same, path: 'objects/ab/cd' }).kind, 'take-theirs')
  assert.equal(blobMerge({ ours: same, theirs: undefined, path: 'objects/ab/cd' }).kind, 'keep-ours')
  assert.throws(
    () => blobMerge({ ours: B('a'), theirs: B('b'), path: 'objects/ab/cd' }),
    (e) => e.code === 'SNAPSHOT_CORRUPT',
  )
})

test('回归: patch-yaml.mjs — 同一 id 既 insert 又 remove → 必须上报，不得静默择一', () => {
  const r = mergeRemoves(['x'], [], [], ['x'])
  assert.deepEqual(r.removes, ['x'], 'remove 指令不得丢')
  assert.equal(r.conflicts.length, 1, 'insert/remove 互相矛盾 → 上报')
  assert.equal(r.conflicts[0].kind, 'insert-vs-remove')
})

test('回归: credentials.mjs — Merger 入口被喂 Buffer 时静默返回 delete:true（会删掉 .credentials.yaml）', () => {
  // Merger 契约（lib/mergers/index.mjs 的 typedef）是 Buffer 进出；credentials 的
  // 这个入口却只认 cell（{present, value}）。Buffer 没有 .present ⇒ eqCell 判"相等"
  // ⇒ dL=dR=false ⇒ 走 base 分支 ⇒ present=false ⇒ 返回 delete:true。
  // 也就是说：任何按契约调用它的代码都会**删掉整份凭据文件**，且不报错。
  // 结论：必须响亮拒绝，绝不静默给错答案。
  assert.throws(
    () => mergerFor('credentials').merge({
      base: B("version: 1\nrefs:\n  A: 'old'\n"),
      ours: B("version: 1\nrefs:\n  A: 'local'\n"),
      theirs: B("version: 1\nrefs:\n  A: 'remote'\n"),
      path: '.credentials.yaml',
    }),
    (e) => e.code === 'BAD_INPUT',
    'Buffer 入参必须响亮拒绝（否则静默 delete:true = 凭据文件被删）',
  )
})

test('credentials: Merger 入口的 cell 契约（既有行为固化）', () => {
  const cell = (present, value) => (present ? { present: true, value } : { present: false })
  const m = mergerFor('credentials')
  // 单边改动 → 采纳远端。
  assert.equal(m.merge({ ns: 'ref', base: cell(true, 'b'), ours: cell(true, 'b'), theirs: cell(true, 't') }).kind, 'take-theirs')
  // 本地未动、远端未动 → 保本地。
  assert.equal(m.merge({ ns: 'ref', base: cell(true, 'b'), ours: cell(true, 'b'), theirs: cell(true, 'b') }).kind, 'keep-ours')
  // 两侧都删 → 删除。
  assert.equal(m.merge({ ns: 'ref', base: cell(true, 'b'), ours: cell(false), theirs: cell(false) }).delete, true)
  // 无法裁决 → 冲突（保本地 + 隔离远端）。
  const amb = m.merge({ ns: 'rec', base: cell(false), ours: cell(true, { payload: { v: 1 } }), theirs: cell(true, { payload: { v: 2 } }) })
  assert.equal(amb.kind, 'conflict')
  assert.equal(amb.keepOurs, true)
})

test('回归: tree.mjs — 缺 mtimeMs 的条目产出 NaN，NaN 会被写进合并结果', () => {
  const r = mergeTree({
    base: new Map([['a', { data: B('l1\n') }]]),
    ours: new Map([['a', { data: B('l1\nl2\n') }]]),
    theirs: new Map([['a', { data: B('l1\nl3\n') }]]),
  })
  assert.equal(Number.isNaN(r.files.get('a').mtimeMs), false, 'mtimeMs 不得是 NaN（会随索引/状态扩散）')
  assert.equal(r.files.get('a').mtimeMs, 0, '缺失 mtime 按 0 处理（与 lwwPick 同口径）')
})

/* ─────────────── 工具 ─────────────── */

/** 假 git：记录 checkout/add 动作，返回预设的索引阶段内容。 */
/* ─────────────── 第 3 轮：三不变量扫描 ─────────────── */

test('回归: credyaml.mjs — record 的 env: 块被整块丢弃（凭据字段静默消失）', () => {
  // DSH 的 record schema 白名单是 kind/key/env/payload 四选；renderCredYaml 也会
  // 把 env 渲染成嵌套块。但解析侧只认 4 空格行 ⇒ `    env:` 被读成空串，
  // 6 空格的子行（真正的键值）既不匹配 payload 分支也没人收 ⇒ **整块丢失**。
  const src = [
    'version: 1',
    'refs:',
    "  KEY: 'plainvalue'",
    'records:',
    '  acme/grant:',
    '    kind: grant',
    "    key: 'acme'",
    '    env:',
    "      ACME_ID: 'id-1'",
    "      ACME_SECRET: 'sec-1'",
    '    payload:',
    '      {',
    '        "scope": "all"',
    '      }',
    '',
  ].join('\n')

  const parsed = parseCredYaml(src)
  const rec = parsed.records[0][1]
  assert.deepEqual(rec.env, { ACME_ID: 'id-1', ACME_SECRET: 'sec-1' }, 'env 块必须被解析出来')
  assert.deepEqual(rec.payload, { scope: 'all' }, 'payload 不受影响')

  // 往返：渲染 → 再解析，env 必须还在（否则每轮同步都在丢字段）。
  const back = renderCredYaml({ refs: new Map(parsed.refs), records: new Map(parsed.records) })
  assert.deepEqual(parseCredYaml(back).records[0][1].env, { ACME_ID: 'id-1', ACME_SECRET: 'sec-1' }, '往返不得丢 env')
})

test('回归: credyaml.mjs — 键名形态超出硬编码子集时被静默丢弃（= 合并时删条目）', () => {
  // 解析器只认 `[A-Za-z_][A-Za-z0-9_]*` 的 ref 键与 `[a-z][a-z0-9-]*/[a-z][a-z0-9-]*`
  // 的 record 键，但渲染器对键名不做任何限制 ⇒ 渲染得出、读不回来。
  // 后果不是"少读一个字段"，而是：合并结果写回后该条目**从文件里消失**。
  const withDash = renderCredYaml({ refs: new Map([['openai-compat', 'v1'], ['KEY', 'ok']]), records: new Map() })
  assert.deepEqual(
    parseCredYaml(withDash).refs, [['openai-compat', 'v1'], ['KEY', 'ok']],
    'ref 键里的连字符不得导致条目被丢',
  )

  const withCase = renderCredYaml({
    refs: new Map(),
    records: new Map([
      ['Acme/Default', { kind: 'grant', payload: { a: 1 } }],
      ['acme/ok', { kind: 'grant', payload: { b: 2 } }],
    ]),
  })
  assert.deepEqual(
    parseCredYaml(withCase).records.map(([k]) => k), ['Acme/Default', 'acme/ok'],
    'record 键里的大写/点不得导致条目被丢',
  )
})

test('回归: credyaml.mjs — 端到端：三方合并后 record 的 env 不得丢', () => {
  const doc = (name, envKey) => Buffer.from([
    'version: 1',
    'refs: {}',
    'records:',
    `  ${name}/grant:`,
    '    kind: grant',
    `    key: '${name}'`,
    '    env:',
    `      ${envKey}: 'v-${envKey}'`,
    '',
  ].join('\n'))

  const out = resolveOne({
    sectionId: 'credentials',
    base: undefined,
    ours: doc('acme', 'ACME_ID'),
    theirs: doc('beta', 'BETA_ID'),
    path: '.credentials.yaml',
  })
  const recs = new Map(parseCredYaml(out.data.toString()).records)
  assert.deepEqual([...recs.keys()].sort(), ['acme/grant', 'beta/grant'], '两侧记录都要在')
  assert.deepEqual(recs.get('acme/grant').env, { ACME_ID: 'v-ACME_ID' })
  assert.deepEqual(recs.get('beta/grant').env, { BETA_ID: 'v-BETA_ID' })
})

test('回归: conflicts.mjs — keepOurs 的无数据冲突（如非法 JSON）不得改成采纳远端', async () => {
  // json 对非法 JSON 的裁决是 {kind:'conflict', keepOurs:true}（不带 data）——
  // 语义是"保本地 + 远端进隔离区"。若分派逻辑只按"无 data + 远端有内容"就
  // checkout --theirs，本地那份会被静默丢掉。
  const git = fakeGit(
    { 'x.json': { 1: B('{}'), 2: B('{broken-ours'), 3: B('{"theirs":1}') } },
    [{ path: 'x.json' }],
  )
  const r = await resolveAll({
    git, sectionOf: () => 'workspace', deviceId: () => 'd',
    writeTree: async () => { throw new Error('非法 JSON 时不得写盘（保本地由 git 检出完成）') },
  })
  assert.ok(git.actions.includes('checkout:ours:x.json'), '必须保本地')
  assert.ok(!git.actions.includes('checkout:theirs:x.json'), '不得采纳远端（本地内容会丢）')
  assert.equal(r.conflicts.length, 1, '未收敛的路径必须上报')
})

test('回归: conflicts.mjs — 删除裁决必须真的移除路径（不得 checkout 复活）', async () => {
  // 本地删除 + 远端未改 → 跟随删除。ours 侧没有该文件，git checkout --ours
  // 会直接报 "does not have our version"；若改用 checkout --theirs 则等于复活。
  const git = fakeGit(
    { 'AGENTS.md': { 1: B('base'), 3: B('base') } },  // stage 2 缺席 = 本地删除
    [{ path: 'AGENTS.md' }],
  )
  const removed = []
  await resolveAll({
    git, sectionOf: () => 'instructions', deviceId: () => 'd',
    writeTree: async () => { throw new Error('删除裁决不得写盘') },
    removeTree: async (rel) => { removed.push(rel) },
  })
  assert.deepEqual(removed, ['AGENTS.md'], '必须从工作树移除')
  assert.deepEqual(git.actions.filter((a) => a.startsWith('checkout')), [], '不得 checkout（会复活已删文件）')
})

test('回归: conflicts.mjs — 缺 removeTree 能力时必须上报，不得静默复活', async () => {
  const git = fakeGit({ 'AGENTS.md': { 1: B('base'), 3: B('base') } }, [{ path: 'AGENTS.md' }])
  const r = await resolveAll({
    git, sectionOf: () => 'instructions', deviceId: () => 'd',
    writeTree: async () => true,
    logger: { warn: () => {} },
  })
  assert.ok(
    r.conflicts.some((c) => /removeTree/u.test(String(c.note))),
    '没有删除能力就必须上报（否则 add -A 会把它复活且无人知道）',
  )
})

test('回归: patch-yaml.mjs — 无 id 条目被 indexById 收进 orphan 后无人消费（条目被删）', () => {
  // indexById 明确把"无 id 无 name"的条目收进 orphan（注释写着"无 id 无法合并"），
  // 但 mergePatchEntries 只读 .map ⇒ orphan 桶从来没被消费过 ⇒ 条目静默消失。
  const ours = parsePatchYaml('- insert:\n    - config:\n        keep: 1\n    - id: ok\n').entries
  const r = mergePatchEntries([], ours, [])
  assert.equal(r.merged.length, 2, '无 id 的条目也必须留在结果里（绝不丢失）')
  assert.ok(r.merged.some((e) => e.config?.keep === 1), 'orphan 条目的 config 必须原样保留')
  assert.equal(r.conflicts.length, 1, '无 id 无法按 id 合并 → 必须上报')
  assert.equal(r.conflicts[0].kind, 'orphan-entry')
  // 渲染 → 再解析：orphan 不得被塞进一个空 id 从而互相覆盖。
  const back = parsePatchYaml(renderPatchYaml(r.merged)).entries
  assert.equal(back.length, 2, '渲染往返后条目数不得减少')
})

test('回归: conflicts.mjs — tree 的 forks[] 从未落盘（落败方字节静默丢失）', async () => {
  // tree 的单路径合并把落败方放在 `outcome.forks`（数组），而不是 `forkPath`。
  // resolveAll 只认 forkPath ⇒ 冲突副本从不写盘 ⇒ LWW 落败的那份字节消失
  // （skills/ 这类 tree 分区在双机各改同一文件时就会命中）。
  const git = fakeGit(
    { 'skills/a/SKILL.md': { 1: B('base'), 2: B('zzz'), 3: B('yyy') } },
    [{ path: 'skills/a/SKILL.md' }],
  )
  const written = []
  const r = await resolveAll({
    git, sectionOf: () => 'skills-dsh', deviceId: () => 'devAAAAA',
    writeTree: async (rel, data) => { written.push([rel, data.toString()]); return true },
  })
  const fork = written.find(([rel]) => rel.includes('.conflict-'))
  assert.ok(fork !== undefined, '落败方必须转冲突副本（绝不丢失）')
  assert.equal(fork[1], 'yyy', 'fork 里必须是落败方的字节')
  assert.equal(r.forks.length, 1, 'fork 必须出现在返回值里（调用方据此上报）')
})

test('不变量: patch-yaml 渲染是解析的不动点（真实 MCP 嵌套形态）', () => {
  // 渲染器若与解析器不完全对偶，每一轮同步都会"改"一遍文件（幂等性破裂），
  // 而 patch 文件被改写会触发新的冲突 → 回声。这里用真实 MCP 配置形态钉住对偶性。
  const entry = {
    id: 'mcp-mineru',
    name: '@mineru/mcp',
    config: {
      command: 'npx',
      args: ['-y', 'mineru-mcp', '--flag'],
      port: '19387',
      env: { MINERU_API_TOKEN: 'sk-abc', RETRIES: '3' },
      mcpServers: { mineru: { command: 'npx', args: ['a'], nested: { deep: { deeper: 'v' } } } },
      empty: {},
      empties: [],
    },
  }
  const one = renderPatchYaml([entry])
  const parsed = parsePatchYaml(one).entries
  assert.deepEqual(parsed[0].config, entry.config, '嵌套形态必须逐类型读回')
  assert.equal(renderPatchYaml(parsed), one, 'render ∘ parse ∘ render 必须是不动点')
})

test('equal: 共享深比较的语义（键序无关 / 数组序敏感 / 类型敏感）', () => {
  assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }))
  assert.ok(!deepEqual([1, 2], [2, 1]), '数组序敏感')
  assert.ok(!deepEqual({ a: 1 }, { a: '1' }), '类型敏感')
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }), '键数不同')
  assert.ok(deepEqual(null, null))
  assert.ok(!deepEqual(null, {}), 'null ≠ {}')
  assert.ok(deepEqual(undefined, undefined))
  assert.ok(!deepEqual(undefined, null), 'undefined ≠ null（缺失与 null 是两回事）')
  assert.ok(deepEqual({ a: [{ b: 1 }] }, { a: [{ b: 1 }] }))
})

test('不变量: json 合并是确定性的（同输入 → 同输出）', () => {
  const args = () => ({ base: B('{"a":{"x":1},"b":[1,2]}'), ours: B('{"a":{"x":2},"b":[1,2,3]}'), theirs: B('{"a":{"y":9},"b":[1,2]}'), path: 'w.json' })
  const one = jsonMerge(args())
  const two = jsonMerge(args())
  assert.equal(one.data.toString(), two.data.toString())
})

test('不变量: patch-yaml 条目合并不丢任何一侧的 id', () => {
  const P = (t) => parsePatchYaml(t).entries
  const base = P('- insert:\n    - id: shared\n')
  const ours = P('- insert:\n    - id: shared\n    - id: only-local\n')
  const theirs = P('- insert:\n    - id: shared\n    - id: only-remote\n')
  const r = mergePatchEntries(base, ours, theirs)
  const ids = r.merged.map((e) => e.id).sort()
  assert.deepEqual(ids, ['only-local', 'only-remote', 'shared'])
})

test('不变量: tree 合并不丢任何一侧的文件', () => {
  const r = mergeTree({
    base: new Map(),
    ours: new Map([['a', { data: B('o'), mtimeMs: 1 }]]),
    theirs: new Map([['b', { data: B('t'), mtimeMs: 1 }]]),
  })
  assert.deepEqual([...r.files.keys()].sort(), ['a', 'b'])
})

test('不变量: keepboth 任何分歧都保留两侧字节', () => {
  const v = classifyPath(B('base'), B('ours!'), B('theirs!'))
  assert.equal(v.keepOurs, true)
  assert.equal(v.forkTheirs, true, '分歧必须产 fork（远端字节不得丢）')
})
