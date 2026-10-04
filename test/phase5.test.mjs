// test/phase5.test.mjs — 会话双向 / 口令 / 工作区目录 / Windows 路径逻辑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mirrorSessions, applySessionsToLocal, isSessionPath } from '../lib/sessions.mjs'
import { ensureWorkspaceDirs } from '../lib/apply.mjs'
import { Engine } from '../lib/engine.mjs'
import { makeFsDeps } from '../lib/workspace.mjs'
import { projectKey, encodeSegment, platformCommand } from '../lib/paths.mjs'
import { tmpRoot, gitOut, nativeGit, backendFor, fsCtx, rejectsCode } from './helpers.mjs'


/* ─────────── 会话双向 ─────────── */

test('会话: 路径分类只认会话类路径', () => {
  for (const p of ['sessions/p/s/x.jsonl', 'storages/session_projcache/p/x.json']) {
    assert.equal(isSessionPath(p), true, `${p} 应属会话`)
  }
  for (const p of ['AGENTS.md', 'storages/workspace.json', 'sessions-notes.md', 'profiles/desktop/package.json']) {
    assert.equal(isSessionPath(p), false, `${p} 不应属会话`)
  }
})

test('会话: 双向端到端（真 git 裸仓，A 推 → B 拉）', async (t) => {
  const base = await tmpRoot(t, 'omni-sess-')
  const remote = join(base, 'remote.git')
  const homeA = join(base, 'homeA')
  const homeB = join(base, 'homeB')
  await gitOut(['init', '--bare', remote])
  await mkdir(join(homeA, 'sessions/proj/s1'), { recursive: true })
  await mkdir(join(homeA, 'storages/session_projcache/proj'), { recursive: true })
  await writeFile(join(homeA, 'sessions/proj/s1/session.jsonl'), '{"turn":1}\n')
  await writeFile(join(homeA, 'sessions/proj/s1/session.lock'), 'must-not-sync')
  await writeFile(join(homeA, 'storages/session_projcache/proj/s1.json'), '{"cache":1}')
  await mkdir(homeB, { recursive: true })

  const backend = (dir) => backendFor({
    repoDir: dir, remote, branch: 'mirror/sessions',
    commitName: 't', commitEmail: 't@l', run: nativeGit({ timeoutMs: 60_000 }),
  })
  const gitA = backend(join(homeA, 'omnisync/mirror'))
  const fsA = makeFsDeps({ dshHome: homeA, workTree: join(homeA, 'omnisync/mirror'), backupRoot: join(homeA, 'omnisync/backups'), git: gitA })
  const ctxA = fsCtx(fsA, {
    writeLocal: async (rel, data) => { await fsA.writeLocal(rel, data, { mode: 0o600 }); return true },
  })

  // A 机：会话流 engine（与 index.mjs 同构）。
  const engineA = new Engine({
    now: () => Date.now(), git: gitA, deviceId: () => 'devA',
    mirror: async () => mirrorSessions(ctxA),
    applyToLocal: async () => applySessionsToLocal(ctxA),
    confirm: async () => true,
    resolveConflicts: async () => ({ conflicts: [], forks: [] }),
  })
  await gitA.schedule(() => gitA.bootstrap())
  const push = await engineA.run({ mode: 'push', trigger: 'test' })
  assert.equal(push.error, undefined, `会话推送不应失败：${JSON.stringify(push.error)}`)
  assert.ok(push.pushed >= 2, `应推送 ≥2 项（实际 ${push.pushed}）`)
  // 锁文件绝不进通道。
  const tracked = await gitOut(['-C', join(homeA, 'omnisync/mirror'), 'ls-files'])
  assert.ok(!tracked.includes('session.lock'), '锁文件绝不能被提交')

  // B 机：clone 后 pull（这是"新机器拿到会话"的路径）。
  await gitOut(['clone', '-b', 'mirror/sessions', remote, join(homeB, 'omnisync/mirror')])
  const gitB = backend(join(homeB, 'omnisync/mirror'))
  const fsB = makeFsDeps({ dshHome: homeB, workTree: join(homeB, 'omnisync/mirror'), backupRoot: join(homeB, 'omnisync/backups'), git: gitB })
  const ctxB = fsCtx(fsB, {
    writeLocal: async (rel, data) => { await fsB.writeLocal(rel, data, { mode: 0o600 }); return true },
  })
  const engineB = new Engine({
    now: () => Date.now(), git: gitB, deviceId: () => 'devB',
    mirror: async () => mirrorSessions(ctxB),
    applyToLocal: async () => applySessionsToLocal(ctxB),
    confirm: async () => true,
    resolveConflicts: async () => ({ conflicts: [], forks: [] }),
  })
  const pull = await engineB.run({ mode: 'pull', trigger: 'test' })
  assert.equal(pull.error, undefined, `会话拉取不应失败：${JSON.stringify(pull.error)}`)
  assert.ok(pull.pulled >= 2, `应落地 ≥2 项（实际 ${pull.pulled}）`)

  // 会话字节一致（这是"换台电脑会话还在"的核心保证）。
  const a = await readFile(join(homeA, 'sessions/proj/s1/session.jsonl'))
  const b = await readFile(join(homeB, 'sessions/proj/s1/session.jsonl'))
  assert.ok(a.equals(b), '会话内容必须逐字节一致')
  assert.equal(await readFile(join(homeB, 'storages/session_projcache/proj/s1.json'), 'utf8'), '{"cache":1}')

  // 幂等：再跑一轮不该重复落地。
  const again = await engineB.run({ mode: 'pull', trigger: 'test2' })
  assert.equal(again.pulled, 0, '内容未变时不应重复写入')
})

/* ─────────── 工作区目录自动创建 ─────────── */

test('工作区: 新机器上自动创建缺失的目录（否则工作区打不开）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-wsdir-')
  const target = join(tmp, 'Documents/newproj')
  const doc = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    tables: { workspaces: { u1: { path: target, title: 'newproj' }, u2: { path: join(tmp, 'other'), title: 'o' } } },
  })
  const created = []
  const exists = async (p) => { const fs = await import('node:fs/promises'); return fs.access(p).then(() => true, () => false) }
  const r = await ensureWorkspaceDirs({
    readLocal: async () => Buffer.from(doc),
    exists,
    mkdir: async (p) => { await mkdir(p, { recursive: true }); created.push(p); return true },
  })
  assert.equal(r.length, 2)
  assert.equal(await exists(target), true, '目录必须真的被建出来')

  // 再跑一次：已存在则不再创建（幂等）。
  const r2 = await ensureWorkspaceDirs({ readLocal: async () => Buffer.from(doc), exists, mkdir: async () => { throw new Error('不该再建') } })
  assert.deepEqual(r2, [])
})

test('工作区: 非 JSON / 缺文件时安静返回（绝不抛）', async () => {
  assert.deepEqual(await ensureWorkspaceDirs({ readLocal: async () => null, exists: async () => false, mkdir: async () => true }), [])
  assert.deepEqual(await ensureWorkspaceDirs({ readLocal: async () => Buffer.from('not json'), exists: async () => false, mkdir: async () => true }), [])
})

/* ─────────── 口令 ─────────── */

test('口令: 0600 落盘 + env 优先于文件', async (t) => {
  const { writeAtomic } = await import('../lib/workspace.mjs')
  const tmp = await tmpRoot(t, 'omni-pw-')
  const file = join(tmp, 'omnisync/passphrase.vault')
  await writeAtomic(file, 'file-passphrase', { mode: 0o600 })
  assert.equal((await stat(file)).mode & 0o777, 0o600, '口令文件必须 0600')

  // index.mjs 的解析语义：env > 文件。
  const resolve = (env, fileValue) => env || fileValue
  assert.equal(resolve('env-pass', (await readFile(file, 'utf8')).trim()), 'env-pass')
  assert.equal(resolve('', (await readFile(file, 'utf8')).trim()), 'file-passphrase')
  assert.equal(resolve('', ''), '')
})

test('口令: 口令文件在硬排除清单里（绝不上云）', async () => {
  const { NEVER_SYNC } = await import('../lib/constants.mjs')
  const { sectionForPath } = await import('../lib/sections.mjs')
  assert.ok(NEVER_SYNC.includes('omnisync/passphrase.vault'), '口令文件必须在 NEVER_SYNC')
  assert.equal(sectionForPath('omnisync/passphrase.vault', 'desktop'), null)
  assert.equal(sectionForPath('omnisync/github.token', 'desktop'), null)
})

/* ─────────── Windows 路径逻辑（无 Windows 机器，用纯函数覆盖）────────── */

test('Windows: 盘符路径的 projectKey 与官方语义一致（无冒号、无反斜杠）', () => {
  const k = projectKey('C:\\Users\\x\\Documents\\foo')
  assert.equal(k, '--C-Users-x-Documents-foo--')
  assert.ok(!k.includes(':') && !k.includes('\\'), '目录名不能含冒号或反斜杠')
  // 同一逻辑路径的 posix/win 形态应产出同一 key（跨机才能对上同一工程）。
  assert.equal(projectKey('C:/Users/x/Documents/foo'), k)
})

test('Windows: 非法段编码（防目录穿越）', () => {
  assert.equal(encodeSegment('../etc/passwd'), '..~002Fetc~002Fpasswd')
  assert.ok(!encodeSegment('a/b').includes('/'))
})

test('Windows: 命令模板展开时分隔符风格必须一致（曾混出两边都不认的路径）', () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\demo' : '/home/demo'
  const win = platformCommand('uvx', home, 'win32')
  const mac = platformCommand('uvx', home, 'darwin')
  assert.ok(win !== null && mac !== null, 'uvx 应在命令映射表里')
  assert.ok(win.includes('\\'), 'Windows 形态应含反斜杠')
  assert.ok(!win.includes('/'), `Windows 形态不得混入 posix 分隔符：${win}`)
  assert.ok(mac.startsWith('/'), 'posix 形态应是绝对路径')
  // 未知命令返回 null（调用方据此跳过替换）。
  assert.equal(platformCommand('no-such-cmd', home, 'win32'), null)
})

/* ─────────── 远程排障：随同步流动的体检报告 ─────────── */

test('体检: 报告只含结构性事实（不泄露用户名/绝对路径/文件内容）', async () => {
  const { buildReport } = await import('../lib/health.mjs')
  const r = buildReport({
    deviceId: 'abc12345', version: '0.4.1',
    state: { lastError: { code: 'GIT_FAILED', message: 'boom', at: 1 }, lastSyncedAt: 5, backoffUntil: 0, history: [{}, {}] },
    cfg: { repo: 'me/private', branch: 'main', mirrorBranch: 'mirror/sessions', secretGroups: { providerKeys: true, mcpEnv: false }, syncSessions: true },
    gitVersion: 'git version 2.42.0', counts: { files: 173, classified: 145 }, sessionFiles: 64,
  })
  assert.equal(r.reportV, 1)
  assert.equal(r.deviceId, 'abc12345')
  assert.equal(r.platform, process.platform)
  assert.equal(r.state, 'error')
  assert.equal(r.runs, 2)
  assert.deepEqual(r.secretGroups, ['providerKeys'], '只报开启的分组名，不报值')
  const text = JSON.stringify(r)
  // 绝不出现用户目录与密钥形态。
  assert.ok(!text.includes(process.env.HOME ?? '/Users/nonexistent'), '不得含家目录')
  assert.ok(!/sk-|ghp_|tvly-|BEGIN PRIVATE/u.test(text), '不得含密钥形态')
})

test('体检: 问题判定（供 doctor 高亮）', async () => {
  const { buildReport, reportIssues } = await import('../lib/health.mjs')
  const healthy = buildReport({ deviceId: 'a', version: '1', state: { lastError: null, history: [] }, cfg: { repo: 'x/y', branch: 'main', secretGroups: {} }, gitVersion: 'git version 2', counts: { files: 5 } })
  assert.deepEqual(reportIssues(healthy), [])
  const bad = buildReport({ deviceId: 'b', version: '1', state: { lastError: { code: 'AUTH_BLOCKED', message: 'no token', at: 1 }, history: [] }, cfg: { repo: '', secretGroups: {} }, gitVersion: null, counts: { files: 0 } })
  const issues = reportIssues(bad)
  assert.ok(issues.length >= 3, `应报出多个问题（实际 ${issues.length}）`)
  assert.ok(issues.some((i) => i.includes('AUTH_BLOCKED')))
  assert.ok(issues.some((i) => i.includes('未配置远端')))
  assert.ok(issues.some((i) => i.includes('git 不可用')))
})

test('体检: 报告目录属于同步分区（否则远程永远看不到）', async () => {
  const { sectionForPath } = await import('../lib/sections.mjs')
  assert.equal(sectionForPath('omnisync-devices/abc12345.json', 'desktop')?.id, 'device-health')
  // 但插件自身的运行态目录仍然绝不同步。
  assert.equal(sectionForPath('omnisync/github.token', 'desktop'), null)
  assert.equal(sectionForPath('omnisync/repo/AGENTS.md', 'desktop'), null)
})

/* ─────────── 我范围外的模块补测（errors/i18n/tools/gate/deps/health）─────────── */

test('gate: approval 通道按真实契约判定（返回字符串，只有 allowed-once 是授权）', async () => {
  const { confirm } = await import('../lib/gate.mjs')
  const seen = []
  const mk = (outcome) => ({
    get: (n) => (n === 'approval'
      ? { request: async (req) => { seen.push(req); return outcome } }
      : undefined),
  })
  const cfg = { confirmLevel: 'always', confirmedOnce: false }
  const req = { question: 'q', agent: { session: {} }, toolName: 'omni_sync_push' }

  // 唯一授权值。
  assert.equal((await confirm({ ctx: mk('allowed-once') }, req, cfg)).allowed, true)
  // 其余三个取值都必须拒绝（此前代码永远拒绝，包括 allowed-once）。
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const r = await confirm({ ctx: mk(outcome) }, req, cfg)
    assert.equal(r.allowed, false, `${outcome} 必须被拒`)
    assert.match(r.reason, new RegExp(outcome, 'u'))
  }
  // 请求形状必须是 { agent, toolName, reason }（不是 summary/detail）。
  assert.equal(seen[0].toolName, 'omni_sync_push')
  assert.equal(seen[0].reason, 'q')
  assert.ok(seen[0].agent !== undefined)
  // 轮外调用（服务抛错）→ fail closed，不崩。
  const throwing = { get: (n) => (n === 'approval' ? { request: async () => { throw new Error('outside an open turn') } } : undefined) }
  const r = await confirm({ ctx: throwing }, req, cfg)
  assert.equal(r.allowed, false)
  assert.match(r.reason, /confirmation failed/u)
})

test('i18n: 缺失键返回可读兜底（不抛、不返回 undefined）', async () => {
  const { t, allMessages } = await import('../lib/i18n.mjs')
  assert.equal(typeof t('err.GIT_FAILED', { msg: 'x' }), 'string')
  const missing = t('no.such.key')
  assert.equal(typeof missing, 'string', '缺键必须返回字符串')
  assert.ok(missing.length > 0, '缺键不得返回空串')
  // 参数替换真的生效。
  assert.ok(!t('confirm.apply', { n: 3, s: 1 }).includes('{n}'), '占位符必须被替换')
  // 双语表结构完整：zh 为权威，en 缺项时应回落 zh。
  const all = allMessages()
  assert.ok(Object.keys(all).length > 20)
  for (const [key, entry] of Object.entries(all)) {
    assert.equal(typeof entry.zh, 'string', `${key} 缺 zh`)
  }
})

test('tools: 三个工具定义能被真实 defineTool 接受（DSL 校验）', async () => {
  const { makeTools, TOOL_STATUS, TOOL_PUSH, TOOL_PULL } = await import('../lib/tools.mjs')
  const tools = makeTools({ status: async () => 'ok', run: async () => 'ok' })
  assert.equal(tools.length, 3)
  assert.deepEqual(tools.map((x) => x.name), [TOOL_STATUS, TOOL_PUSH, TOOL_PULL])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} 必须有 execute`)
    assert.equal(typeof tool.description, 'string')
  }
  // 只读工具不该带确认语义，写工具必须带。
  assert.match(tools[0].description, /Read-only/iu)
  assert.match(tools[1].description, /confirmation/iu)
  // execute 失败时必须返回 ok:false 而不是抛（模型工具不允许炸掉轮次）。
  const bad = makeTools({ status: async () => { throw Object.assign(new Error('boom'), { code: 'GIT_FAILED' }) }, run: async () => 'x' })
  const out = await bad[0].execute({}, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'GIT_FAILED')
})

test('errors: 工厂产出的错误带稳定 code 与可读消息', async () => {
  const e = await import('../lib/errors.mjs')
  const cases = [
    [e.badInput('x'), 'BAD_INPUT'], [e.badConfig('x'), 'BAD_CONFIG'],
    [e.gitFailed('push', 'stderr tail'), 'GIT_FAILED'], [e.pushRejected('tail'), 'PUSH_REJECTED'],
    [e.pathUnsafe('/etc/passwd'), 'PATH_UNSAFE'], [e.authBlocked('no token'), 'AUTH_BLOCKED'],
    [e.decryptFailed('envelope'), 'DECRYPT_FAILED'],
  ]
  for (const [err, code] of cases) {
    assert.equal(err.code, code, `${code} 不匹配`)
    assert.ok(err.message.length > 0)
    assert.ok(err instanceof Error)
  }
  // 错误消息不得包含密钥形态（错误会进日志与模型可见面）。
  assert.ok(!/sk-|ghp_|tvly-/u.test(e.gitFailed('push', 'token=sk-abcdefgh1234').message))
})

test('deps: planInstalls 精确版本语义（不用 @latest）', async () => {
  const { planInstalls, dependenciesOf } = await import('../lib/deps.mjs')
  const wanted = ['a', 'b', 'c']
  assert.deepEqual(planInstalls(wanted, new Map([['b', '1']])), ['a', 'c'])
  assert.deepEqual(planInstalls(wanted, new Map(), new Set(['c'])), ['a', 'b'], 'exempt 应被跳过')
  const m = dependenciesOf({ dependencies: { '@x/y': '^0.2.0', z: '1.0.0' } })
  assert.equal(m.get('@x/y'), '^0.2.0')
})

/* ─────────── 按分区选择同步（原需求里"逐项选择"的落地）─────────── */

test('分区开关: 关掉的分区等同未分类（不进工作树），且注册表驱动', async (t) => {
  const { sectionList, sectionForPath, SECTIONS } = await import('../lib/sections.mjs')
  const { applyToWorktree } = await import('../lib/apply.mjs')
  const { makeFsDeps } = await import('../lib/workspace.mjs')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // ① 清单由注册表驱动：每个分区都在，且带说明（UI 不需要硬编码分区名）。
  const list = sectionList()
  assert.equal(list.length, SECTIONS.length, '清单必须覆盖全部注册分区')
  for (const s of list) {
    assert.equal(typeof s.id, 'string')
    assert.equal(typeof s.note, 'string', `${s.id} 缺说明（UI 靠它解释）`)
    assert.equal(s.defaultOn, true, '默认全开（用户装插件就是为了全部同步）')
  }

  // ② 关掉一个分区 → 该分区的文件不再进工作树；其他分区不受影响。
  const home = await tmpRoot(t, 'omni-sec-')
  await mkdir(join(home, 'skills/demo'), { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), '# 指令\n')
  await writeFile(join(home, 'skills/demo/SKILL.md'), '# 技能\n')
  const fsDeps = makeFsDeps({ dshHome: home, workTree: join(home, 'omnisync/repo'), backupRoot: join(home, 'omnisync/backups') })
  // 复刻 index.mjs 的 sectionOf：关掉的分区返回 null（等同未分类 → 跳过）
  const ctx = (disabled) => fsCtx(fsDeps, {
    sectionOf: (rel) => {
      const id = sectionForPath(rel, 'desktop')?.id ?? null
      return id !== null && disabled.includes(id) ? null : id
    },
    secretGroupOf: () => null, passphrase: '', vars: { home, dshHome: home },
  })

  await applyToWorktree(ctx([]))
  let tree = await fsDeps.listTree()
  assert.ok(tree.includes('AGENTS.md') && tree.includes('skills/demo/SKILL.md'), '默认全同步')

  await applyToWorktree(ctx(['skills-dsh']))
  tree = await fsDeps.listTree()
  assert.ok(tree.includes('AGENTS.md'), '未关的分区照常同步')
  assert.ok(!tree.includes('skills/demo/SKILL.md'), '关掉的分区必须退出工作树')
})

test('分区开关: 偏好持久化 + 只接受真实分区 id（挡拼错/污染）', async () => {
  const { emptyState, mergeSettings, applySettings } = await import('../lib/state.mjs')
  const st = emptyState()
  mergeSettings(st, { disabledSections: ['sessions'] })
  assert.deepEqual(st.settings.disabledSections, ['sessions'], '必须落盘')
  const cfg = { repo: '', confirmLevel: 'auto', secretGroups: {}, disabledSections: [] }
  applySettings(cfg, st.settings)
  assert.deepEqual(cfg.disabledSections, ['sessions'], '必须能套回运行期')
  // 注册表外的 id 会被 index.mjs 的 setDisabledSections 过滤掉（这里验证过滤逻辑本身）。
  const { SECTIONS } = await import('../lib/sections.mjs')
  const known = new Set(SECTIONS.map((s) => s.id))
  const filtered = [...new Set(['sessions', 'no-such-section', 'sessions'])].filter((id) => known.has(id))
  assert.deepEqual(filtered, ['sessions'], '未知 id 必须被丢弃、重复必须去重')
})

test('附件对象: 落本机前校验「路径 == sha256(内容)」，篡改零写入', async (t) => {
  // 对象是云端唯一副本（本机删掉、远端被覆盖就永久损坏），所以坏内容绝不能被
  // 写成一个"看起来合法"的对象路径。校验必须在写之前。
  const { applyToLocal } = await import('../lib/apply.mjs')
  const { makeFsDeps } = await import('../lib/workspace.mjs')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createHash } = await import('node:crypto')

  const home = await tmpRoot(t, 'omni-obj-')
  const deps = makeFsDeps({ dshHome: home, workTree: join(home, 'omnisync/repo'), backupRoot: join(home, 'omnisync/backups') })
  const ctx = {
    listTree: () => deps.listTree(), readTree: (r) => deps.readTree(r), readLocal: (r) => deps.readLocal(r),
    writeLocal: async (r, d) => { await deps.writeLocal(r, d, { mode: 0o600 }); return true },
    sectionOf: () => 'attachments', vars: { home, dshHome: home },
  }
  // ① 合法对象正常落地。
  const good = Buffer.from('hello-attachment')
  const h = createHash('sha256').update(good).digest('hex')
  const goodRel = `attachments/v1/objects/${h.slice(0, 2)}/${h}`
  await deps.writeTree(goodRel, good)
  assert.equal(await applyToLocal(ctx), 1)
  assert.ok((await deps.readLocal(goodRel)).equals(good))

  // ② 路径合法但内容被篡改 → SNAPSHOT_CORRUPT，且**本机不留任何字节**。
  const fake = 'b'.repeat(64)
  const badRel = `attachments/v1/objects/bb/${fake}`
  await deps.writeTree(badRel, Buffer.from('tampered'))
  await rejectsCode(() => applyToLocal(ctx), 'SNAPSHOT_CORRUPT')
  assert.equal(await deps.readLocal(badRel), null, '篡改对象绝不能落本机')
})
