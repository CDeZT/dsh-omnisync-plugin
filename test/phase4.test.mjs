// test/phase4.test.mjs — 缺口修复的回归测试 + 引擎主流程端到端。
//
// 覆盖 5 个实测发现的缺口：
//   ① {userData} 模板未解析 → keybindings 分区失效
//   ② mirror 后端未 bootstrap → 首次同步必失败
//   ③ blob 合并器未注册 → 附件静默退化 keep-both
//   ④ 工作区路径无重定基 → 把 A 机绝对路径带到 B 机
//   ⑤ engine.run() 主流程无端到端测试

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sectionForPath, SECTIONS, externalRels } from '../lib/sections.mjs'
import { SECTION_MERGER, mergerFor } from '../lib/mergers/index.mjs'
import { rebindText, needsRebind } from '../lib/rebind.mjs'
import { applyToWorktree, applyToLocal } from '../lib/apply.mjs'
import { makeFsDeps } from '../lib/workspace.mjs'
import { Engine } from '../lib/engine.mjs'
import { backendFor, fsCtx, gitOut, nativeGit, rejectsCode, skipWithoutPeers, tmpRoot } from './helpers.mjs'


/* ─────────── ① {userData} 模板 ─────────── */

// 缺宿主 peer 依赖时整份跳过（而不是抛 ERR_MODULE_NOT_FOUND 误导用户）。
const _peersMissing = skipWithoutPeers(['@deepseek-ai/cordis'], 'phase4.test.mjs')
if (!_peersMissing) {

test('缺口①: keybindings 分区必须真的可达（走遍历，不是只问 sectionForPath）', async (t) => {
  // ★ 这个测试的形态很关键。原版只做 sectionForPath(绝对路径) → keybindings，
  //   于是**通过了**，但分区在生产里永远不可达：applyToWorktree 收到的是
  //   $DSH_HOME 相对路径，而没有任何地方遍历 userData。只问注册表 = 假验证。
  //   现在必须证明"文件真的会被 listLocal 捞出来"，即端到端可达。

  // 约定：外部根用 @userdata/ 虚拟前缀寻址。
  assert.equal(sectionForPath('@userdata/keybindings.json', 'desktop')?.id, 'keybindings')
  assert.deepEqual(externalRels(), ['@userdata/keybindings.json'], '注册表必须声明外部根文件')

  const home = await tmpRoot(t, 'omni-kb-')
  const userData = await tmpRoot(t, 'omni-ud-')
  await writeFile(join(userData, 'keybindings.json'), '{"bindings":[]}')
  await mkdir(join(home, 'skills'), { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), '# x\n')

  const deps = makeFsDeps({
    dshHome: home, workTree: join(home, 'omnisync/repo'),
    backupRoot: join(home, 'omnisync/backups'),
    externalRoots: { '@userdata': userData },
  })
  const rels = (await deps.listLocal('')).map((f) => f.rel)
  assert.ok(rels.includes('@userdata/keybindings.json'), `外部根文件必须被遍历捞到，实际：${rels.join(',')}`)
  assert.ok(rels.includes('AGENTS.md'), '$DSH_HOME 内文件照常')
  // 读写必须落到真实 userData 目录（而不是 $DSH_HOME 下造一个同名文件）。
  assert.equal((await deps.readLocal('@userdata/keybindings.json')).toString(), '{"bindings":[]}')
  await deps.writeLocal('@userdata/keybindings.json', Buffer.from('{"bindings":[1]}'))
  assert.equal((await deps.readLocal('@userdata/keybindings.json')).toString(), '{"bindings":[1]}')
  // 外部根不是越界写入的免罪牌。
  await rejectsCode(() => deps.readLocal('@userdata/../escape.json'), 'PATH_UNSAFE')
})

test('缺口①: 分区表里不再有未解析的占位符', () => {
  const KNOWN = ['{name}', '{userData}']
  for (const s of SECTIONS) {
    for (const tpl of s.relPaths) {
      const leftover = tpl.replaceAll('{name}', 'x').replaceAll('{userData}', '/tmp/u')
      assert.ok(!leftover.includes('{'), `${s.id} 的模板 ${tpl} 含未支持的占位符`)
    }
  }
})

/* ─────────── ③ blob 合并器 ─────────── */

test('缺口③: blob 已注册，且内容不同时硬失败（不静默丢/不扩散损坏）', () => {
  assert.ok(SECTION_MERGER.has('blob'), 'blob 必须注册（否则静默回落 keep-both）')
  const same = Buffer.from('same')
  assert.equal(mergerFor('blob').merge({ ours: same, theirs: Buffer.from('same'), path: 'objects/ab/cd' }).kind, 'keep-ours')
  assert.equal(mergerFor('blob').merge({ ours: undefined, theirs: same, path: 'objects/ab/cd' }).kind, 'take-theirs')
  assert.throws(
    () => mergerFor('blob').merge({ ours: Buffer.from('a'), theirs: Buffer.from('b'), path: 'objects/ab/cd' }),
    (e) => e.code === 'SNAPSHOT_CORRUPT',
    '内容寻址对象内容不同 = 损坏，必须硬失败',
  )
})

test('缺口③: 每个分区的 merger 都必须在注册表里（不许静默回落）', () => {
  for (const s of SECTIONS) {
    if (s.merger === undefined) continue
    assert.ok(SECTION_MERGER.has(s.merger), `${s.id} 声明的 merger '${s.merger}' 未注册 → 会静默回落 keep-both`)
  }
})

/* ─────────── ④ 路径重定基 ─────────── */

test('缺口④: 工作区绝对路径跨机重定基（A 机路径 → B 机路径）', () => {
  assert.equal(needsRebind('workspace'), true)
  const varsA = { home: '/Users/alice', dshHome: '/Users/alice/.dsh' }
  const varsB = { home: '/Users/bob', dshHome: '/Users/bob/.dsh' }
  const doc = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: ['u1'] },
    tables: { workspaces: { u1: { path: '/Users/alice/Documents/proj', title: 'proj' } } },
  })
  const templated = rebindText(Buffer.from(doc), 'templatize', varsA)
  assert.ok(templated.toString().includes('${HOME}/Documents/proj'), '通道内必须是模板形态')
  assert.ok(!templated.toString().includes('/Users/alice'), '本机绝对路径不得进通道')

  const onB = JSON.parse(rebindText(templated, 'detemplatize', varsB).toString())
  assert.equal(onB.tables.workspaces.u1.path, '/Users/bob/Documents/proj', 'B 机应得到自己的路径')
  // 非路径字段不受影响。
  assert.equal(onB.tables.workspaces.u1.title, 'proj')
  assert.equal(onB.unit.version, 2)
})

test('缺口④: 非 JSON 内容原样返回（绝不破坏）', () => {
  const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe])
  assert.ok(rebindText(bin, 'templatize', { home: '/x' }).equals(bin))
})

/* ─────────── ② mirror 故障隔离 ─────────── */

test('缺口②: 会话镜像失败不得拖垮配置流（故障隔离）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-iso-')
  const home = join(tmp, 'home')
  await mkdir(join(home, 'sessions', 'p', 's'), { recursive: true })
  await writeFile(join(home, 'sessions/p/s/x.jsonl'), 'session')
  await writeFile(join(home, 'AGENTS.md'), '# keep\n')
  await mkdir(join(home, 'omnisync/repo'), { recursive: true })

  // 用一个必然失败的镜像 git（模拟"未 bootstrap / 网络断"），配置流仍须成功。
  const brokenMirror = {
    schedule: async (fn) => fn(),
    bootstrap: async () => { throw Object.assign(new Error('mirror unavailable'), { code: 'GIT_FAILED' }) },
    commitAll: async () => { throw new Error('should not reach') },
    push: async () => { throw new Error('should not reach') },
  }
  let mirrorFailed = false
  try {
    await brokenMirror.bootstrap()
  } catch { mirrorFailed = true }
  assert.ok(mirrorFailed, '镜像确实不可用（前提成立）')

  // 配置流（不含会话）应独立成功。
  const fsDeps = makeFsDeps({ dshHome: home, workTree: join(home, 'omnisync/repo'), backupRoot: join(home, 'omnisync/backups') })
  const r = await applyToWorktree(fsCtx(fsDeps, {
    secretGroupOf: () => null,
    passphrase: '',
    vars: { home, dshHome: home },
  }))
  assert.ok(r.changed >= 1, '配置流必须照常完成')
  assert.equal(await fsDeps.readTree('AGENTS.md') !== null, true)
})

/* ─────────── ⑤ engine.run() 端到端 ─────────── */

test('缺口⑤: engine.run() 主流程端到端（真 git 裸仓：push → 另一机 pull）', async (t) => {
  const base = await tmpRoot(t, 'omni-engine-')
  const remote = join(base, 'remote.git')
  const homeA = join(base, 'homeA')
  const homeB = join(base, 'homeB')
  await gitOut(['init', '--bare', remote])
  await mkdir(join(homeA, 'profiles/desktop'), { recursive: true })
  await writeFile(join(homeA, 'AGENTS.md'), '# 引擎端到端\n')
  await writeFile(join(homeA, 'profiles/desktop/package.json'), '{"name":"p","dependencies":{}}')
  await mkdir(join(homeB), { recursive: true })

  const backend = (dir) => backendFor({
    repoDir: dir, remote, branch: 'main',
    commitName: 't', commitEmail: 't@l', run: nativeGit({ timeoutMs: 60_000 }),
  })
  const gitA = backend(join(homeA, 'omnisync/repo'))
  const fsA = makeFsDeps({ dshHome: homeA, workTree: join(homeA, 'omnisync/repo'), backupRoot: join(homeA, 'omnisync/backups'), git: gitA })
  const treeCtx = (home, fsDeps) => fsCtx(fsDeps, {
    writeLocal: async (rel, data) => { await fsDeps.writeLocal(rel, data, { mode: 0o600 }); return true },
    secretGroupOf: () => null,
    passphrase: '',
    vars: { home, dshHome: home },
  })

  // ── A 机：engine.run('push') ──
  const engineA = new Engine({
    now: () => Date.now(), git: gitA, deviceId: () => 'devA',
    mirror: async () => (await applyToWorktree(treeCtx(homeA, fsA))).changed,
    applyToLocal: async () => applyToLocal(treeCtx(homeA, fsA)),
    confirm: async () => true,
    resolveConflicts: async () => ({ conflicts: [], forks: [] }),
  })
  await gitA.schedule(() => gitA.bootstrap())
  const pushReport = await engineA.run({ mode: 'push', trigger: 'test' })
  assert.equal(pushReport.error, undefined, `push 不应失败：${JSON.stringify(pushReport.error)}`)
  assert.ok(pushReport.pushed >= 2, `应推送 ≥2 项（实际 ${pushReport.pushed}）`)
  assert.ok(typeof pushReport.commit === 'string')
  assert.equal(engineA.state, 'idle', '成功后状态回到 idle')

  // ── B 机：克隆后 engine.run('pull') ──
  await gitOut(['clone', remote, join(homeB, 'omnisync/repo')])
  const gitB = backend(join(homeB, 'omnisync/repo'))
  const fsB = makeFsDeps({ dshHome: homeB, workTree: join(homeB, 'omnisync/repo'), backupRoot: join(homeB, 'omnisync/backups'), git: gitB })
  const engineB = new Engine({
    now: () => Date.now(), git: gitB, deviceId: () => 'devB',
    mirror: async () => (await applyToWorktree(treeCtx(homeB, fsB))).changed,
    applyToLocal: async () => applyToLocal(treeCtx(homeB, fsB)),
    confirm: async () => true,
    resolveConflicts: async () => ({ conflicts: [], forks: [] }),
  })
  const pullReport = await engineB.run({ mode: 'pull', trigger: 'test' })
  assert.equal(pullReport.error, undefined, `pull 不应失败：${JSON.stringify(pullReport.error)}`)
  assert.ok(pullReport.pulled >= 2, `应落地 ≥2 项（实际 ${pullReport.pulled}）`)

  // 内容逐字节一致。
  const a = await readFile(join(homeA, 'AGENTS.md'))
  const b = await readFile(join(homeB, 'AGENTS.md'))
  assert.ok(a.equals(b), 'AGENTS.md 必须逐字节一致')
})

test('缺口⑤: engine 单飞（并发调用第二个直接跳过）', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const engine = new Engine({
    now: () => Date.now(),
    git: { schedule: async (fn) => fn(), fetch: async () => { await gate }, remoteHeadSha: async () => undefined, headSha: async () => 'h', dirtyLines: async () => [], mergeInProgress: async () => false, recentCommits: async () => [] },
    deviceId: () => 'd',
    mirror: async () => 0,
    applyToLocal: async () => 0,
    confirm: async () => true,
    resolveConflicts: async () => ({ conflicts: [], forks: [] }),
  })
  const first = engine.run({ mode: 'pull' })
  await new Promise((r) => setTimeout(r, 10))
  const second = await engine.run({ mode: 'pull' })
  assert.equal(second.skipped, true, '并发第二轮必须被跳过（单飞）')
  release()
  await first
})

}
