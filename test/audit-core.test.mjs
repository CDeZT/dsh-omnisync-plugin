// test/audit-core.test.mjs — 核心编排层审计（Engine 编排 / index 接线 / 命令 / 路由）。
//
// 这里只放**回归守卫**：每个用例都对应一个真被修掉的缺陷，断言的是
// "为什么"（安全语义）而不是实现细节。Engine 全走依赖注入，零 I/O。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import { apply } from '../index.mjs'
import { NAMESPACE, STATE_KEY } from '../lib/constants.mjs'
import { ACTIONS } from '../lib/command.mjs'
import { ALLOWED_VERBS, GitBackend, assertSafe, classifyGitFailure, parseTokenExpiry } from '../lib/git.mjs'
import { Engine, STATES, backoffFor } from '../lib/engine.mjs'
import { makeFsDeps } from '../lib/workspace.mjs'
import { runCommand } from '../lib/command.mjs'
import { registerRoutes } from '../lib/routes.mjs'
import { tmpRoot } from './helpers.mjs'

/**
 * Engine 的纯 DI 桩。calls 记录**发生顺序** —— "确认门必须先于落盘"
 * 这类安全语义只能靠顺序断言，靠返回值断言抓不到。
 */
function makeDeps(overrides = {}) {
  const calls = []
  const deps = {
    now: () => 1_000,
    deviceId: () => 'dev00001',
    git: {
      schedule: (fn) => fn(),
      fetch: async () => true,
      remoteHeadSha: async () => 'remote-sha',
      headSha: async () => 'local-sha',
      beginMerge: async () => ({ conflicted: false, inProgress: true }),
      commitMerge: async () => 'merged-sha',
      commitAll: async () => 'commit-sha',
      push: async () => ({ tokenExpiry: undefined }),
    },
    mirror: async () => 0,
    previewLocal: async () => { calls.push('preview'); return 2 },
    applyToLocal: async () => { calls.push('apply'); return 2 },
    confirm: async () => { calls.push('confirm'); return true },
    resolveConflicts: async () => ({ conflicts: [], forks: [] }),
    ...overrides,
  }
  return { deps, calls }
}

/* ── 第 1 轮：确认门与写本机的顺序 / 取消后的状态复位 ── */

test('engine: 用户拒绝确认后，状态必须复位（不能永远停在 syncing）', async () => {
  const { deps } = makeDeps({ confirm: async () => false })
  const engine = new Engine(deps)
  const report = await engine.run({ mode: 'sync' })
  assert.equal(report.cancelled, true, '拒绝 = 本轮取消')
  assert.equal(engine.state, STATES.IDLE, '取消后状态必须复位，否则 UI 永远显示"同步中"且调度器误判在飞')
})

test('engine: 确认门必须先于写本机（拒绝 → 一个字节都不许落盘）', async () => {
  const { deps, calls } = makeDeps({ confirm: async () => { calls.push('confirm'); return false } })
  const engine = new Engine(deps)
  await engine.run({ mode: 'sync' })
  assert.deepEqual(calls, ['preview', 'confirm'], '顺序必须是 预估 → 确认；拒绝后 applyToLocal 不得被调用')
})

test('engine: pull 模式同样要过确认门（写本机的路径不能绕过）', async () => {
  const { deps, calls } = makeDeps({ confirm: async () => { calls.push('confirm'); return false } })
  const engine = new Engine(deps)
  const report = await engine.run({ mode: 'pull' })
  assert.equal(report.cancelled, true, 'pull 是纯写本机方向，更该过门')
  assert.equal(calls.includes('apply'), false)
})

test('engine: 放行时确认先于落盘，且 pulled 取真实写入数', async () => {
  const { deps, calls } = makeDeps()
  const engine = new Engine(deps)
  const report = await engine.run({ mode: 'sync' })
  assert.deepEqual(calls, ['preview', 'confirm', 'apply'])
  assert.equal(report.pulled, 2)
  assert.equal(engine.state, STATES.IDLE)
})

test('engine: 没有待写文件时不打扰确认门', async () => {
  const { deps, calls } = makeDeps({
    previewLocal: async () => { calls.push('preview'); return 0 },
    applyToLocal: async () => { calls.push('apply'); return 0 },
    confirm: async () => { calls.push('confirm'); return true },
  })
  const engine = new Engine(deps)
  const report = await engine.run({ mode: 'sync' })
  assert.equal(calls.includes('confirm'), false, '零写入还弹确认 = 纯噪音')
  assert.equal(report.cancelled, undefined)
})

/* ── 命令层（此前无任何测试） ── */

test('command: 未配置仓库时除 doctor 外一律拒绝', async () => {
  const api = { repo: () => '', cfg: { branch: 'main' } }
  for (const raw of ['status', 'push', 'pull', 'diff', 'log']) {
    const out = await runCommand(api, raw)
    assert.equal(out.kind, 'error', `${raw} 未配置仓库时必须报错`)
  }
})

test('command: 未知子命令退化为 usage（不是静默推送）', async () => {
  const api = { repo: () => 'a/b', cfg: { branch: 'main' } }
  const out = await runCommand(api, 'rm -rf /')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /omnisync|usage/iu)
})

/* ── 第 2 轮：index 的偏好写入点（remember）不得污染状态行 ── */

/**
 * 真 cordis Context + 与真接口同形的假 storageDomain/webServer（get 同步、put 异步）。
 * 返回捕获到的路由表，便于直接打 HTTP 面（UI 的真实入口）。
 */
async function mountPlugin(config, dshHome) {
  const rows = new Map()
  const table = {
    get: (k) => rows.get(k),
    put: async (k, v) => { rows.set(k, v) },
    delete: async (k) => rows.delete(k),
    entries: () => [...rows.entries()][Symbol.iterator](),
    keys: () => [...rows.keys()][Symbol.iterator](),
    get size() { return rows.size },
  }
  const ctx = new Context()
  ctx.provide('subprocess', {
    resolveExecutable: async (bin) => `/usr/bin/${bin}`,
    spawn: () => ({
      stdout: (async function* none() {})(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
    }),
  })
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('storageDomain', { open: async () => ({ table: () => table, close: async () => {} }) })
  const routes = new Map()
  ctx.provide('webServer', { register(def) { routes.set(def.path, def); return () => {} } })
  process.env.DSH_HOME = dshHome
  ctx.plugin({ name: 'audit-core', apply: (c) => apply(c, config) })
  await new Promise((r) => setTimeout(r, 60))
  const dispose = () => { try { ctx.fiber?.dispose?.() ?? ctx.dispose?.() ?? ctx.stop?.() } catch { /* ignore */ } }
  return { rows, routes, dispose }
}

/** 打一条 POST 路由（真 req/res 形状：异步可迭代 body + writeHead/end）。 */
async function callRoute(def, body) {
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
  await def.handler(req, res)
  return { code: res.code, payload: JSON.parse(res.body) }
}

test('index: /secrets 存偏好后状态行必须仍是完整状态文档（否则下次读取静默全量重置）', async (t) => {
  const dir = await tmpRoot(t, 'omni-remember-')
  t.after(() => {
  delete process.env.DSH_HOME
  })
  const { rows, routes, dispose } = await mountPlugin({ repo: 'a/b' }, dir)
  try {
    const before = rows.get(STATE_KEY)
    assert.equal(before?.version, 1, '挂载后应已有状态行')
    assert.equal(typeof before.deviceId, 'string')

    const res = await callRoute(routes.get(`/${NAMESPACE}/api/v1/secrets`), { group: 'mcpEnv', enabled: false })
    assert.equal(res.code, 200)
    assert.equal(res.payload.data.secretGroups.mcpEnv, false, '回包要带上合并后的全部分组')
    assert.equal(res.payload.data.secretGroups.providerKeys, true)

    const after = rows.get(STATE_KEY)
    assert.equal(after?.version, 1, '落盘的状态行必须仍是完整状态文档（version 是 migrateState 的判据）')
    assert.equal(after.deviceId, before.deviceId, '改一个偏好不得丢掉设备身份')
    assert.deepEqual(after.tombstones, {}, '墓碑等字段必须原样保留')

    // 用户可见症状：改完偏好再看状态，设备 ID 不能变成 undefined。
    const status = await callRoute(routes.get(`/${NAMESPACE}/api/v1/status`), {})
    assert.equal(status.payload.data.deviceId, before.deviceId)
  } finally { dispose() }
})

test('index: /confirm-level 立即生效（配置项与状态偏好同时更新）', async (t) => {
  const dir = await tmpRoot(t, 'omni-confirm-')
  t.after(() => {
  delete process.env.DSH_HOME
  })
  const { rows, routes, dispose } = await mountPlugin({ repo: 'a/b' }, dir)
  try {
    const res = await callRoute(routes.get(`/${NAMESPACE}/api/v1/confirm-level`), { level: 'always' })
    assert.equal(res.code, 200)
    assert.equal(res.payload.data.confirmLevel, 'always')
    assert.equal(rows.get(STATE_KEY).version, 1, '状态行不得被偏好对象覆盖')
    assert.equal(rows.get(STATE_KEY).settings.confirmLevel, 'always', '偏好必须落盘（重启后仍生效）')
  } finally { dispose() }
})

/* ── 第 3 轮：git 契约 / 遍历边界 / 死代码 ── */

test('git: 已是最新的合并必须报 inProgress=false（git 把它打在 stdout，不是 stderr）', async () => {
  const backend = new GitBackend({
    repoDir: '/tmp', remote: 'https://github.com/a/b.git', branch: 'main',
    run: async (args) => (args[0] === 'merge'
      ? { code: 0, stdout: 'Already up to date.\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }),
  })
  const result = await backend.beginMerge('deadbeef')
  assert.deepEqual(result, { conflicted: false, inProgress: false }, '误报"合并进行中"会让上层多提交一次空合并')
})

test('git: 真冲突仍必须报 conflicted=true', async () => {
  const backend = new GitBackend({
    repoDir: '/tmp', remote: 'https://github.com/a/b.git', branch: 'main',
    run: async (args) => (args[0] === 'merge'
      ? { code: 1, stdout: 'CONFLICT (content): ...\n', stderr: '' }
      : { code: 0, stdout: 'abc123\n', stderr: '' }), // rev-parse MERGE_HEAD
  })
  assert.deepEqual(await backend.beginMerge('deadbeef'), { conflicted: true, inProgress: true })
})

test('workspace: 本机遍历必须排除插件自己的 omnisync/ 工作区（镜像树不该被反复读）', async (t) => {
  const home = await tmpRoot(t, 'omni-walk-')
    const put = async (rel, text) => {
      await mkdir(join(home, rel.split('/').slice(0, -1).join('/')), { recursive: true })
      await writeFile(join(home, rel), text)
    }
    await put('omnisync/repo/x.json', '{}')
    await put('omnisync/mirror/sessions/p/s1.jsonl', 'session-bytes')
    await put('omnisync/backups/2024/a', 'backup')
    await put('omnisync-devices/dev1.json', '{"at":1}')
    await put('storages/workspace.json', '{}')

    const deps = makeFsDeps({ dshHome: home, workTree: join(home, 'omnisync/repo') })
    const rels = (await deps.listLocal('')).map((f) => f.rel)
    assert.ok(rels.includes('storages/workspace.json'), '正常分区必须照常进通道')
    assert.ok(rels.includes('omnisync-devices/dev1.json'), '体检报告是 device-health 分区，必须留（远程排障窗口）')
    assert.equal(
      rels.some((r) => r.startsWith('omnisync/')), false,
      'omnisync/ 是插件自己的工作区（repo/mirror/backups）：不进通道，也不该每轮被 stat 一遍',
    )
})

/* ── 第 3 轮（续）：路由错误分流 + git 安全原语（此前零覆盖） ── */

test('routes: 请求体不是 JSON → 400 BAD_INPUT（不能混成 500 让 UI 以为插件故障）', async (t) => {
  const dir = await tmpRoot(t, 'omni-routes-')
  t.after(() => {
  delete process.env.DSH_HOME
  })
  const { routes, dispose } = await mountPlugin({ repo: 'a/b' }, dir)
  try {
    const def = routes.get(`/${NAMESPACE}/api/v1/secrets`)
    const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{not json') } }
    const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
    await def.handler(req, res)
    assert.equal(res.code, 400, '调用方传坏 body 是 4xx，不是 5xx')
    assert.equal(JSON.parse(res.body).error.code, 'BAD_INPUT')
  } finally { dispose() }
})

test('routes: 非 POST 打 POST 路由 → 400；未知分组 → 400', async (t) => {
  const dir = await tmpRoot(t, 'omni-routes2-')
  t.after(() => {
  delete process.env.DSH_HOME
  })
  const { routes, dispose } = await mountPlugin({ repo: 'a/b' }, dir)
  try {
    const get = { method: 'GET', async *[Symbol.asyncIterator]() { } }
    const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
    await routes.get(`/${NAMESPACE}/api/v1/sync`).handler(get, res)
    assert.equal(res.code, 400)

    const bad = await callRoute(routes.get(`/${NAMESPACE}/api/v1/secrets`), { group: 'not-a-group', enabled: true })
    assert.equal(bad.code, 400)
    assert.equal(bad.payload.error.code, 'BAD_CONFIG')
  } finally { dispose() }
})

test('command: README 记录的子命令必须真的可执行（文档承诺 ≠ 空头支票）', async () => {
  const { readFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const documented = [...readme.matchAll(/^\/omnisync ([a-z]+)/gmu)].map((m) => m[1])
  assert.ok(documented.length >= 5, `README 应记录子命令（解析到 ${documented.join(',')}）`)
  for (const action of documented) {
    assert.ok(ACTIONS.includes(action), `README 承诺了 /omnisync ${action}，但 ACTIONS 里没有 → 用户敲了只会看到 usage`)
  }
})

test('git: 安全原语——force/amend/裸 checkout/裸 merge 一律拒绝', () => {
  for (const args of [
    ['push', '--force', 'origin', 'main'],
    ['push', '-f', 'origin', 'main'],
    ['push', '+main:main'],
    ['commit', '--amend', '-m', 'x'],
    ['checkout', 'main'],
    ['merge', 'origin/main'],
    ['rm', '-rf', '.'],
    ['reset', '--hard'],
  ]) {
    assert.throws(() => assertSafe(args), (e) => e.code === 'GIT_FAILED', `必须拒绝：git ${args.join(' ')}`)
  }
  // 正常形态必须放行（否则插件根本跑不起来）。
  for (const args of [
    ['push', 'origin', 'HEAD:refs/heads/main'],
    ['fetch', 'origin', '+main:refs/remotes/origin/main'],
    ['merge', '--no-commit', '--allow-unrelated-histories', 'abc'],
    ['merge', '--abort'],
    ['checkout', '--ours', '--', 'a.json'],
    ['commit', '-m', 'x'],
    ['cat-file', 'blob', ':2:a.json'],
  ]) {
    assert.doesNotThrow(() => assertSafe(args), `必须放行：git ${args.join(' ')}`)
  }
})

test('git: 认证失败必须分类为 AUTH_BLOCKED（决定长退避，不空转）', () => {
  assert.equal(classifyGitFailure('fatal: Authentication failed for https://github.com/a/b.git')?.code, 'AUTH_BLOCKED')
  assert.equal(classifyGitFailure('remote: Permission denied (403)')?.code, 'AUTH_BLOCKED')
  assert.equal(classifyGitFailure('could not read Username for https://github.com')?.code, 'AUTH_BLOCKED')
  assert.equal(classifyGitFailure('fatal: not a git repository'), null, '非认证错误不得误判（否则白退避 6 小时）')
})

test('git: PAT 过期头解析（只在能解析出日期时给值）', () => {
  assert.equal(typeof parseTokenExpiry('GitHub-Authentication-Token-Expiration: 2026-01-01 00:00:00 UTC'), 'number')
  assert.equal(parseTokenExpiry('no header here'), undefined)
  assert.equal(parseTokenExpiry('GitHub-Authentication-Token-Expiration: not-a-date'), undefined)
})

test('engine: 退避表——认证必须长退避，冲突/解密失败立即重试', () => {
  assert.ok(backoffFor('AUTH_BLOCKED') >= 3600_000, '认证阻断不能每 5 分钟撞一次')
  assert.equal(backoffFor('MERGE_CONFLICT'), 0)
  assert.equal(backoffFor('DECRYPT_FAILED'), 0, '口令错要立刻可见，不能压 5 分钟')
  assert.equal(backoffFor('SOMETHING_NEW'), 5 * 60_000, '未知错误走默认短退避')
})

test('git: 动词白名单不含任何改写历史 / 删工作树的动词', () => {
  for (const verb of ['reset', 'clean', 'rm', 'rebase', 'stash', 'filter-branch', 'gc', 'prune', 'update-index', 'checkout-index']) {
    assert.equal(ALLOWED_VERBS.has(verb), false, `${verb} 绝不许进白名单`)
  }
  for (const verb of ['fetch', 'merge', 'push', 'commit', 'cat-file', 'ls-files', 'rev-parse']) {
    assert.equal(ALLOWED_VERBS.has(verb), true, `${verb} 是同步必需动词`)
  }
})

/* ── routes.mjs 直接单测（此前该模块在审计里算"零测试"） ── */

test('routes: 缺可选方法时 /status 退化为默认值，而不是整条 500（真实事故守卫）', async () => {
  const registered = []
  const ws = { register(def) { registered.push(def); return () => {} } }
  registerRoutes(ws, {
    engine: { state: 'idle' },
    state: async () => ({ deviceId: 'd1', history: [] }),
    repo: () => 'a/b',
    cfg: { branch: 'main', secretGroups: {}, confirmLevel: 'first-run' },
  })
  const def = registered.find((d) => d.path === `/${NAMESPACE}/api/v1/status`)
  assert.ok(def !== undefined, 'status 路由必须注册在命名空间前缀下')
  const req = { method: 'GET' }
  const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
  await def.handler(req, res)
  assert.equal(res.code, 200, 'api 少给一个可选方法不该让整条路由 500')
  const data = JSON.parse(res.body).data
  assert.equal(data.passphraseConfigured, false)
  assert.equal(data.passphraseFromEnv, false)
  assert.equal(data.deviceId, 'd1')
})

test('routes: /sync 的未知 mode 归一为 sync（不把 UI 的脏值透给引擎）', async () => {
  const registered = []
  const ws = { register(def) { registered.push(def); return () => {} } }
  const seen = []
  registerRoutes(ws, {
    engine: { state: 'idle' }, state: async () => ({}), repo: () => 'a/b',
    cfg: { branch: 'main', secretGroups: {}, confirmLevel: 'first-run' },
    runSync: async (mode, trigger) => { seen.push([mode, trigger]); return { pushed: 1, pulled: 2, conflicts: [] } },
  })
  const def = registered.find((d) => d.path === `/${NAMESPACE}/api/v1/sync`)
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ mode: 'DROP TABLE' })) } }
  const res = { code: 0, body: '', writeHead(code) { this.code = code }, end(text) { this.body = text } }
  await def.handler(req, res)
  assert.deepEqual(seen, [['sync', 'ui']], '未知 mode 必须归一为 sync')
  assert.equal(JSON.parse(res.body).data.mode, 'sync')
})
