// test/audit-backend.test.mjs — 文件夹后端（网盘即媒介）。
//
// 全部用**真临时目录 + 真 git 裸仓**（node:child_process 直连系统 git，零 mock）：
// 这里要证明的核心命题是「零新增合并逻辑」—— 于是测试必须真的让 GitBackend 对着
// 一个本地路径 remote 跑 bootstrap/push/非 FF 拒绝/合并，而不是断言 mock 被调用。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  probeFolderRemote, assertFolderUsable, prepareFolderRemote,
  findConflictCopies, makeFolderBackendDeps, CONFLICT_SUFFIX_RE,
} from '../lib/backend-folder.mjs'
import { GitBackend } from '../lib/git.mjs'
import { tmpRoot, nativeGit, gitOut, rejectsCode } from './helpers.mjs'

/* ─────────────── prepare：建仓与「绝不覆盖」 ─────────────── */

test('folder: allowInit=false → 拒绝抢建空仓（云盘还没同步下对端的仓 = 会分叉）', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  await mkdir(cloud, { recursive: true })
  const bare = join(cloud, 'dsh-omnisync.git')

  // 复合谓词（锁错误码 + 消息里必须点明"拒绝抢建"）—— 不能用 rejectsCode 的简化形态。
  await assert.rejects(
    () => prepareFolderRemote(bare, { run: nativeGit(), branch: 'main', allowInit: false }),
    (error) => error.code === 'BACKEND_UNSUPPORTED' && /refusing to create it/u.test(error.message),
  )
  assert.equal(existsSync(bare), false, '拒绝后不留下空仓')

  // 已存在的裸仓不受 allowInit=false 影响（照常可用）。
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  const again = await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main', allowInit: false })
  assert.equal(again.created, false)
})

test('folder: 云盘根是符号链接（iCloud 常见形态）→ 正常工作，不误判为未挂载', { skip: process.platform === 'win32' }, async (t) => {
  const root = await tmpRoot(t)
  const real = join(root, 'Mobile Documents', 'com~apple~CloudDocs')
  await mkdir(real, { recursive: true })
  const link = join(root, 'iCloud')          // 用户眼里的路径是链接
  await symlink(real, link)
  const bare = join(link, 'dsh-omnisync.git')

  const probeMissing = await probeFolderRemote(bare)
  assert.equal(probeMissing.code, 'NOT_MOUNTED', '还没建仓 → 未就绪（而不是「不是目录」）')

  const prepared = await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  assert.equal(prepared.created, true)
  assert.equal(await gitOut(['rev-parse', '--is-bare-repository'], { cwd: bare }), 'true')
  assert.equal((await probeFolderRemote(bare)).ok, true)
  // 真机：内容必须落在链接目标里（否则云盘同步的是个空壳）。
  assert.equal(existsSync(join(real, 'dsh-omnisync.git', 'HEAD')), true)

  const backend = new GitBackend(makeFolderBackendDeps({
    repoDir: join(root, 'work'), remoteDir: bare, branch: 'main', run: nativeGit(), commitName: 'A', commitEmail: 'a@test',
  }))
  await backend.bootstrap()
  await mkdir(join(root, 'work'), { recursive: true })
  await writeFile(join(root, 'work', 'x.txt'), 'x')
  await backend.commitAll('via symlinked cloud root')
  await backend.push()
  assert.match(await gitOut(['log', '--oneline'], { cwd: bare }), /via symlinked cloud root/u)
})

test('folder: 云盘目录不存在 → 真 git init --bare（并验证确是裸仓）', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'iCloud Drive')
  const bare = join(cloud, 'dsh-omnisync.git')
  await mkdir(cloud, { recursive: true })

  const prepared = await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  assert.equal(prepared.created, true)
  assert.equal(prepared.dir, bare)
  assert.equal(await gitOut(['rev-parse', '--is-bare-repository'], { cwd: bare }), 'true')
  // 幂等：第二次不再 init，也绝不动已有 refs。
  await writeFile(join(root, 'probe.txt'), 'x')
  const again = await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  assert.equal(again.created, false)
})

test('folder: prepare 幂等且不动已有 refs（有提交后重跑，HEAD 不变）', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  const bare = join(cloud, 'dsh-omnisync.git')
  const work = join(root, 'work')
  await mkdir(cloud, { recursive: true })
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })

  const backend = new GitBackend(makeFolderBackendDeps({
    repoDir: work, remoteDir: bare, branch: 'main', run: nativeGit(), commitName: 'A', commitEmail: 'a@test',
  }))
  await backend.bootstrap()
  await mkdir(work, { recursive: true })
  await writeFile(join(work, 'seed.txt'), 'seed')
  await backend.commitAll('seed')
  await backend.push()
  const before = await gitOut(['rev-parse', '--verify', 'refs/heads/main'], { cwd: bare })

  const again = await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  assert.equal(again.created, false)
  assert.equal(await gitOut(['rev-parse', '--verify', 'refs/heads/main'], { cwd: bare }), before)
})

test('folder: 目录存在但不是裸仓（有用户数据）→ 响亮拒绝且绝不覆盖', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  const dir = join(cloud, 'dsh-omnisync.git')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'important.txt'), '用户的真实数据')

  await assert.rejects(
    () => prepareFolderRemote(dir, { run: nativeGit() }),
    (error) => error.code === 'BACKEND_UNSUPPORTED' && /refusing to initialize over existing data/u.test(error.message),
  )
  assert.equal(await readFile(join(dir, 'important.txt'), 'utf8'), '用户的真实数据')
  assert.equal(existsSync(join(dir, 'objects')), false, '绝不留下半个裸仓')
})

test('folder: 云盘根未挂载 → 拒绝，且绝不替用户创建云盘根', async (t) => {
  const root = await tmpRoot(t)
  const notMounted = join(root, 'iCloud Drive')      // 未挂载 = 这一级不存在
  const bare = join(notMounted, 'dsh-omnisync.git')

  await assert.rejects(
    () => prepareFolderRemote(bare, { run: nativeGit() }),
    (error) => error.code === 'BACKEND_UNSUPPORTED' && /cloud root not mounted/u.test(error.message),
  )
  // ★ 关键：mkdir 出来会是一个"看着成功、永远不同步"的本地目录 —— 静默假成功。
  assert.equal(existsSync(notMounted), false)
})

test('folder: 目标路径是文件 → 拒绝（不把文件换成裸仓）', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  await mkdir(cloud, { recursive: true })
  const asFile = join(cloud, 'dsh-omnisync.git')
  await writeFile(asFile, 'not a dir')

  await assert.rejects(
    () => prepareFolderRemote(asFile, { run: nativeGit() }),
    (error) => error.code === 'BACKEND_UNSUPPORTED' && /refusing to replace a file/u.test(error.message),
  )
  assert.equal(await readFile(asFile, 'utf8'), 'not a dir')
})

test('folder: 空目录（只有 .DS_Store 噪声）→ 允许 init', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  const dir = join(cloud, 'dsh-omnisync.git')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.DS_Store'), 'junk')

  const prepared = await prepareFolderRemote(dir, { run: nativeGit(), branch: 'main' })
  assert.equal(prepared.created, true)
  assert.equal(await gitOut(['rev-parse', '--is-bare-repository'], { cwd: dir }), 'true')
})

/* ─────────────── probe：能不能安全写 ─────────────── */

test('folder: probe 各类不可用形态都返回 code 而不是抛错', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  await mkdir(cloud, { recursive: true })

  const missing = await probeFolderRemote(join(root, 'nope', 'dsh-omnisync.git'))
  assert.deepEqual([missing.ok, missing.code], [false, 'NOT_MOUNTED'])

  const asFile = join(cloud, 'file.git')
  await writeFile(asFile, 'x')
  assert.equal((await probeFolderRemote(asFile)).code, 'NOT_A_DIR')

  const dataDir = join(cloud, 'data.git')
  await mkdir(dataDir)
  await writeFile(join(dataDir, 'important.txt'), 'x')
  const notBare = await probeFolderRemote(dataDir)
  assert.deepEqual([notBare.ok, notBare.code], [false, 'NOT_BARE'])
  assert.match(notBare.reason, /holds data but is not a bare repo/u)
  assert.deepEqual(notBare.entries, ['important.txt'])

  const emptyDir = join(cloud, 'empty.git')
  await mkdir(emptyDir)
  const notReady = await probeFolderRemote(emptyDir)
  assert.deepEqual([notReady.ok, notReady.code], [false, 'NOT_BARE'])
  assert.match(notReady.reason, /run prepareFolderRemote first/u)
})

test('folder: probe 拒绝 iCloud 驱逐占位 / 半同步临时文件 / 陈旧锁', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  await mkdir(cloud, { recursive: true })
  const bare = join(cloud, 'dsh-omnisync.git')
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  assert.equal((await probeFolderRemote(bare)).ok, true)

  // ① .icloud = 内容不在本地（与冲突无关）→ 读到就是读到空。
  await writeFile(join(bare, 'packed-refs.icloud'), 'placeholder')
  const evicted = await probeFolderRemote(bare)
  assert.deepEqual([evicted.ok, evicted.code], [false, 'EVICTED'])
  assert.deepEqual(evicted.entries, ['packed-refs.icloud'])
  await rm(join(bare, 'packed-refs.icloud'))

  // ② 云盘客户端正在下载 → 半截 pack 会污染本地仓。
  await writeFile(join(bare, 'pack-abc.part'), 'half')
  const syncing = await probeFolderRemote(bare)
  assert.deepEqual([syncing.ok, syncing.code], [false, 'SYNCING'])
  await rm(join(bare, 'pack-abc.part'))

  // ③ git 自己的锁：进程在写，或云盘同步了崩溃残留。
  await writeFile(join(bare, 'HEAD.lock'), '')
  const locked = await probeFolderRemote(bare)
  assert.deepEqual([locked.ok, locked.code], [false, 'LOCKED'])
  await rm(join(bare, 'HEAD.lock'))
  assert.equal((await probeFolderRemote(bare)).ok, true, '清理后恢复可用')
})

test('folder: probe 只读目录 → READ_ONLY（非 root 且非 win32）', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  const bare = join(cloud, 'dsh-omnisync.git')
  await mkdir(cloud, { recursive: true })
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  await chmod(bare, 0o500)
  try {
    const probe = await probeFolderRemote(bare)
    assert.deepEqual([probe.ok, probe.code], [false, 'READ_ONLY'])
  } finally {
    await chmod(bare, 0o700)
  }
})

test('folder: assertFolderUsable 把探测失败升级成 BACKEND_UNSUPPORTED', async (t) => {
  const root = await tmpRoot(t)
  const dir = join(root, 'data.git')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'important.txt'), 'x')

  await assert.rejects(
    () => assertFolderUsable(dir),
    (error) => error.code === 'BACKEND_UNSUPPORTED' && error.details.code === 'NOT_BARE',
  )
})

/* ─────────────── 冲突副本：识别 + 报告（不删） ─────────────── */

test('folder: 识别三家云盘的冲突副本，且不误报无关兄弟目录', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'cloud')
  const bare = join(cloud, 'dsh-omnisync.git')
  await mkdir(cloud, { recursive: true })
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })

  const copies = [
    'dsh-omnisync 2.git',                                  // iCloud 编号
    "dsh-omnisync (Alice's conflicted copy 2024-01-02).git", // Dropbox
    'dsh-omnisync.conflict-20260101T000000.git',           // 通用 .conflict-*
  ]
  for (const name of copies) await mkdir(join(cloud, name), { recursive: true })
  // 反例：同前缀但语义无关的目录绝不能被当成副本（误报会让用户删错目录）。
  for (const name of ['dsh-omnisync-backup.git', 'dsh-omnisync-old', 'other.git']) {
    await mkdir(join(cloud, name), { recursive: true })
  }

  const found = await findConflictCopies(bare)
  assert.deepEqual(found.map((f) => f.name).sort(), [...copies].sort())
  const kinds = new Map(found.map((f) => [f.name, f.kind]))
  assert.equal(kinds.get('dsh-omnisync 2.git'), 'numbered')
  assert.equal(kinds.get("dsh-omnisync (Alice's conflicted copy 2024-01-02).git"), 'conflicted-copy')
  assert.equal(kinds.get('dsh-omnisync.conflict-20260101T000000.git'), 'conflict-suffix')
  assert.equal(found.every((f) => f.path.startsWith(cloud)), true)
  // 只报告不删除：副本原样还在（里面可能是对端唯一的一份数据）。
  assert.equal(existsSync(join(cloud, copies[1])), true)
})

test('folder: CONFLICT_SUFFIX_RE 只认副本形态（保守，宁可漏报）', () => {
  for (const ok of [' 2', ' 12.git', ' (1)', " (Bob's conflicted copy 2025-03-04).git", '.conflict-20260101.git', '.conflicted.git']) {
    assert.equal(CONFLICT_SUFFIX_RE.test(ok), true, `should match: ${ok}`)
  }
  for (const no of ['', '-backup.git', '-old', '_v2.git', '.git']) {
    assert.equal(CONFLICT_SUFFIX_RE.test(no), false, `should not match: ${no}`)
  }
})

/* ─────────────── deps：remote 从 URL 换成本地绝对路径 ─────────────── */

test('folder: 未接 runner 的误接线 → BAD_INPUT（而不是深层 TypeError）', async (t) => {
  const root = await tmpRoot(t)
  await assert.rejects(
    () => prepareFolderRemote(join(root, 'cloud.git'), {}),
    (error) => error.code === 'BAD_INPUT' && /needs a git runner/u.test(error.message),
  )
  assert.throws(
    () => makeFolderBackendDeps({ repoDir: join(root, 'repo'), remoteDir: join(root, 'cloud.git') }),
    (error) => error.code === 'BAD_INPUT' && /needs a git runner/u.test(error.message),
  )
})

test('folder: makeFolderBackendDeps 要求绝对路径（相对路径会静默走错目录）', async (t) => {
  const root = await tmpRoot(t)
  assert.throws(
    () => makeFolderBackendDeps({ repoDir: 'relative/repo', remoteDir: join(root, 'cloud.git'), run: nativeGit() }),
    (error) => error.code === 'BAD_INPUT' && /repoDir must be absolute/u.test(error.message),
  )
  assert.throws(
    () => makeFolderBackendDeps({ repoDir: join(root, 'repo'), remoteDir: 'cloud.git', run: nativeGit() }),
    (error) => error.code === 'BAD_INPUT' && /remoteDir must be absolute/u.test(error.message),
  )
})

test('folder: 工作树与云盘仓互相嵌套 → 拒绝；同前缀兄弟目录不误判', async (t) => {
  const root = await tmpRoot(t)
  const runGit = nativeGit()
  assert.throws(
    () => makeFolderBackendDeps({ repoDir: join(root, 'repo'), remoteDir: join(root, 'repo', 'cloud.git'), branch: 'main', run: runGit }),
    (error) => error.code === 'BACKEND_UNSUPPORTED' && /must not nest/u.test(error.message),
  )
  assert.throws(
    () => makeFolderBackendDeps({ repoDir: join(root, 'cloud.git', 'work'), remoteDir: join(root, 'cloud.git'), branch: 'main', run: runGit }), 'BACKEND_UNSUPPORTED')
  // /x/repo 与 /x/repo2 是兄弟，不是嵌套（path.sep 收口）。
  const ok = makeFolderBackendDeps({ repoDir: join(root, 'repo'), remoteDir: join(root, 'repo2'), branch: 'main', run: runGit, commitName: 'A', commitEmail: 'a@test' })
  assert.equal(ok.remote, join(root, 'repo2'))
  assert.equal(ok.branch, 'main')
  assert.equal(ok.run, runGit)
})

/* ─────────────── 端到端：复用 GitBackend，零新增合并逻辑 ─────────────── */

test('folder: 双机经网盘裸仓同步（真 push/fetch/merge，remote 是本地路径）', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'iCloud Drive')   // 真机路径就带空格 —— 顺带证明 argv 不经 shell
  const bare = join(cloud, 'dsh-omnisync.git')
  await mkdir(cloud, { recursive: true })
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })
  await assertFolderUsable(bare)

  const makeMachine = (name) => new GitBackend(makeFolderBackendDeps({
    repoDir: join(root, name), remoteDir: bare, branch: 'main',
    run: nativeGit(), commitName: name, commitEmail: `${name}@test`,
  }))
  const a = makeMachine('machine-a')
  const b = makeMachine('machine-b')

  // A 机：bootstrap（含 remote add）→ 写文件 → push。
  await a.bootstrap()
  assert.equal(await gitOut(['remote', 'get-url', 'origin'], { cwd: join(root, 'machine-a') }), bare, 'remote 就是网盘目录的绝对路径')
  await mkdir(join(root, 'machine-a', 'config'), { recursive: true })
  await writeFile(join(root, 'machine-a', 'config', 'a.txt'), 'from-A')
  await a.commitAll('A: add a.txt')
  await a.push()

  // B 机：bootstrap → fetch → 合并（无共同历史也允许）→ 内容真的落到了 B 的工作树。
  await b.bootstrap()
  assert.equal(await b.fetch(), true)
  const remoteHead = await b.remoteHeadSha()
  assert.notEqual(remoteHead, undefined)
  await b.beginMerge(remoteHead)
  await b.commitMerge()
  assert.equal(await readFile(join(root, 'machine-b', 'config', 'a.txt'), 'utf8'), 'from-A')
})

test('folder: 非 FF push 被拒（绝不强推）→ fetch+merge 后两台都在', async (t) => {
  const root = await tmpRoot(t)
  const cloud = join(root, 'iCloud Drive')
  const bare = join(cloud, 'dsh-omnisync.git')
  await mkdir(cloud, { recursive: true })
  await prepareFolderRemote(bare, { run: nativeGit(), branch: 'main' })

  const makeMachine = (name) => new GitBackend(makeFolderBackendDeps({
    repoDir: join(root, name), remoteDir: bare, branch: 'main',
    run: nativeGit(), commitName: name, commitEmail: `${name}@test`,
  }))
  const a = makeMachine('a')
  const b = makeMachine('b')
  await a.bootstrap()
  await writeFile(join(root, 'a', 'base.txt'), 'base')
  await a.commitAll('A: base')
  await a.push()
  await b.bootstrap()
  await b.fetch()
  await b.beginMerge(await b.remoteHeadSha())
  await b.commitMerge()

  // 两台同时各改一个文件：A 先推，B 的 push 必然非 FF。
  await writeFile(join(root, 'a', 'a2.txt'), 'A2')
  await a.commitAll('A: a2')
  await writeFile(join(root, 'b', 'b2.txt'), 'B2')
  await b.commitAll('B: b2')
  await a.push()
  await assert.rejects(() => b.push(), (error) => error.code === 'PUSH_REJECTED', '非 FF 必须被拒，绝不强推')

  // 复用引擎的既有路径：fetch → merge → commit → push，两侧改动都保住。
  await b.fetch()
  await b.beginMerge(await b.remoteHeadSha())
  await b.commitMerge()
  await b.push()
  const log = await gitOut(['log', '--oneline', '--all'], { cwd: bare })
  assert.match(log, /A: a2/u)
  assert.match(log, /B: b2/u)
  await a.fetch()
  await a.beginMerge(await a.remoteHeadSha())
  await a.commitMerge()
  assert.equal(await readFile(join(root, 'a', 'b2.txt'), 'utf8'), 'B2')
})
