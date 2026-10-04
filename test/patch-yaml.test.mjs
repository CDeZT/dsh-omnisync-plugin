// test/patch-yaml.test.mjs — cordis.patch.yml 条目级合并与 YAML 往返锁定。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePatchYaml, renderPatchYaml, mergePatchEntries, merge, scalar, serializeScalar,
} from '../lib/mergers/patch-yaml.mjs'

const P = (text) => parsePatchYaml(text).entries

test('parse: 真实 patch 形态（含注释/嵌套 config/内联数组）', () => {
  const r = parsePatchYaml(`# header comment
- insert:
    - id: omnisync
      name: '@cdezt/dsh-omnisync'
      config:
        enabled: true
        repo: ''
        intervalMinutes: 15
        secretGroups:
          providerKeys: true
          mcpEnv: false
    - id: mcp-mineru
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mineru
        command: uvx
        args: [mineru-mcp, --flag]
        env:
          MINERU_API_TOKEN: "123456"
`)
  assert.equal(r.entries.length, 2)
  const first = r.entries[0]
  assert.equal(first.id, 'omnisync')
  assert.equal(first.config.enabled, true)
  assert.equal(first.config.repo, '')
  assert.equal(first.config.intervalMinutes, 15)
  assert.deepEqual(first.config.secretGroups, { providerKeys: true, mcpEnv: false })
  const second = r.entries[1]
  assert.deepEqual(second.config.args, ['mineru-mcp', '--flag'])
  assert.equal(second.config.env.MINERU_API_TOKEN, '123456')
})

test('parse: remove 指令被保留', () => {
  const r = parsePatchYaml(`- insert:
    - id: a
- remove:
    - id: b
`)
  assert.deepEqual(r.entries.map((e) => e.id), ['a'])
  assert.deepEqual(r.removes, ['b'])
})

test('roundtrip: 类型保真（数字形态的字符串必须仍是字符串）', () => {
  const src = renderPatchYaml([{ id: 'm', name: '@x/y', config: { port: '123456', flag: 'true', nothing: 'null', num: 42 } }])
  const back = parsePatchYaml(src).entries[0]
  assert.equal(back.config.port, '123456', '字符串形态的数字不能被强转')
  assert.equal(back.config.flag, 'true')
  assert.equal(back.config.nothing, 'null')
  assert.equal(back.config.num, 42)
})

test('roundtrip: 空串与特殊字符', () => {
  const src = renderPatchYaml([{ id: 'x', config: { empty: '', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-1' } }])
  const back = parsePatchYaml(src).entries[0]
  assert.equal(back.config.empty, '')
  assert.equal(back.config.url, 'https://mcp.tavily.com/mcp/?tavlyApiKey=tvly-1'.replace('tavly', 'tavily'))
})

test('merge: 双侧各自新增条目 → 并集（云电脑最常用路径）', () => {
  const base = P(`- insert:
    - id: shared
`)
  const ours = P(`- insert:
    - id: shared
    - id: local-only
`)
  const theirs = P(`- insert:
    - id: shared
    - id: remote-only
`)
  const r = mergePatchEntries(base, ours, theirs)
  assert.deepEqual(r.merged.map((e) => e.id).sort(), ['local-only', 'remote-only', 'shared'])
  assert.deepEqual(r.adopted, ['remote-only'])
  assert.deepEqual(r.kept, ['shared', 'local-only'])
})

test('merge: 同 id 单侧改动 → 取改动侧（无冲突）', () => {
  const base = P(`- insert:
    - id: a
      config:
        v: 1
`)
  const ours = P(`- insert:
    - id: a
      config:
        v: 1
`)
  const theirs = P(`- insert:
    - id: a
      config:
        v: 2
`)
  const r = mergePatchEntries(base, ours, theirs)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.merged[0].config.v, 2)
})

test('merge: 同 id 双侧改不同字段 → 字段级合并（无冲突）', () => {
  const base = P(`- insert:
    - id: a
      config:
        x: 1
        y: 1
`)
  const ours = P(`- insert:
    - id: a
      config:
        x: 2
        y: 1
`)
  const theirs = P(`- insert:
    - id: a
      config:
        x: 1
        y: 9
`)
  const r = mergePatchEntries(base, ours, theirs)
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.merged[0].config.x, 2)
  assert.equal(r.merged[0].config.y, 9)
})

test('merge: 同 id 同字段双侧改不同值 → 冲突并保本地', () => {
  const base = P(`- insert:
    - id: a
      config:
        repo: base
`)
  const ours = P(`- insert:
    - id: a
      config:
        repo: mine
`)
  const theirs = P(`- insert:
    - id: a
      config:
        repo: theirs
`)
  const r = mergePatchEntries(base, ours, theirs)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].path, 'repo')
  assert.equal(r.merged[0].config.repo, 'mine')
  assert.equal(r.conflicts[0].remote, 'theirs', '远端值必须进冲突报告而非丢失')
})

test('merge: 实例字段（端口）双侧不等 → 保本地且不算冲突', () => {
  const ours = P(`- insert:
    - id: ws
      config:
        port: 19387
`)
  const theirs = P(`- insert:
    - id: ws
      config:
        port: 3080
`)
  const r = mergePatchEntries([], ours, theirs, { instanceKeys: [/^port$/u] })
  assert.equal(r.conflicts.length, 0, '每台机器的端口天然不同，不该互相覆盖')
  assert.equal(r.merged[0].config.port, 19387)
})

test('merge: 本地删 + 远端未改 → 跟随删除', () => {
  const base = P(`- insert:
    - id: gone
      config:
        v: 1
`)
  const ours = P(`- insert: []`)
  const theirs = base
  const r = mergePatchEntries(base, ours, theirs)
  assert.equal(r.merged.length, 0)
  assert.deepEqual(r.deleted, ['gone'])
})

test('merge: 本地删 + 远端改 → 保留远端并上报（不静默删配置）', () => {
  const base = P(`- insert:
    - id: k
      config:
        v: 1
`)
  const ours = P(`- insert: []`)
  const theirs = P(`- insert:
    - id: k
      config:
        v: 2
`)
  const r = mergePatchEntries(base, ours, theirs)
  assert.equal(r.merged.length, 1)
  assert.equal(r.conflicts[0].kind, 'delete-vs-modify')
})

test('merge: 幂等', () => {
  const base = P(`- insert:
    - id: a
      config:
        v: 1
`)
  const ours = P(`- insert:
    - id: a
      config:
        v: 2
    - id: b
`)
  const theirs = P(`- insert:
    - id: a
      config:
        v: 1
    - id: c
`)
  const r1 = mergePatchEntries(base, ours, theirs)
  const text = renderPatchYaml(r1.merged)
  const r2 = mergePatchEntries(P(text), P(text), P(text))
  assert.deepEqual(r2.merged.map((e) => e.id), r1.merged.map((e) => e.id))
})

test('merge: Merger 接口（Buffer 进出）', () => {
  const out = merge({
    base: Buffer.from('- insert:\n    - id: a\n'),
    ours: Buffer.from('- insert:\n    - id: a\n    - id: b\n'),
    theirs: Buffer.from('- insert:\n    - id: a\n    - id: c\n'),
    path: 'cordis.patch.yml',
  })
  assert.equal(out.kind, 'merged')
  assert.deepEqual(parsePatchYaml(out.data.toString()).entries.map((e) => e.id), ['a', 'b', 'c'])
})

test('scalar/serializeScalar: 边界', () => {
  assert.equal(scalar('~'), null)
  assert.equal(scalar('null'), null)
  assert.deepEqual(scalar('[]'), [])
  assert.equal(scalar('"quoted"'), 'quoted')
  assert.equal(serializeScalar('123'), '"123"')
  assert.equal(serializeScalar(123), '123')
  assert.equal(serializeScalar(''), '""')
  assert.equal(serializeScalar('true'), '"true"')
  assert.equal(serializeScalar(true), 'true')
})
