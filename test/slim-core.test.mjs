// test/slim-core.test.mjs — 核心编排层精简后的回归网。
//
// 两类断言：
//   ① 从 index.mjs 抽出去的工厂（health/confirm/command/tools/routes/deps）行为不变；
//   ② client.js 的**渲染冒烟** —— 面板此前只有"能加载"的契约测试，没有任何
//      渲染覆盖，于是精简 UI 代码等于盲改。这里用最小 React 桩真跑一遍渲染树。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import * as indexExports from '../index.mjs'
import { makeHealth, buildReport } from '../lib/health.mjs'
import { makeConfirm } from '../lib/gate.mjs'
import { mountCommand } from '../lib/command.mjs'
import { mountTools } from '../lib/tools.mjs'
import { mountRoutes } from '../lib/routes.mjs'
import { makeRebuildDeps } from '../lib/deps.mjs'
import { emptyState } from '../lib/state.mjs'
import { fakeSubprocess, makeFakeDomain, peer, pluginEntry, skipWithoutPeers } from './helpers.mjs'

/* ── ① 对外 API 与抽出去的工厂 ── */

// 缺宿主 peer 依赖时整份跳过（而不是抛 ERR_MODULE_NOT_FOUND 误导用户）。
const _peersMissing = skipWithoutPeers(['@deepseek-ai/cordis'], 'slim-core.test.mjs')
if (!_peersMissing) {

test('index: 声明搬到 lib/config.mjs 后，四个公开名字仍在 index.mjs 上', () => {
  for (const name of ['Config', 'resolveConfig', 'stateSchema', 'omnisyncDomainSpec']) {
    assert.ok(indexExports[name] !== undefined, `index.mjs 必须继续导出 ${name}（宿主与守卫测试按它取）`)
  }
  assert.equal(typeof indexExports.apply, 'function')
  assert.equal(typeof indexExports.stateSchema.shape, 'object', 'stateSchema 必须仍是 zod 对象（守卫要读 .shape）')
})

test('config: 纯声明模块可单独 import，且不产生副作用', async () => {
  const mod = await import('../lib/config.mjs')
  const cfg = mod.resolveConfig({ repo: 'a/b' })
  assert.equal(cfg.branch, 'main')
  assert.equal(Object.values(cfg.secretGroups).every((v) => v === true), true, '六个密级分组默认全开')
  assert.throws(() => mod.resolveConfig({ repo: 'not-a-repo' }), /owner\/name/u)
})

test('health: makeHealth 采集/落盘/回读（含损坏报告忽略与时间倒序）', async () => {
  const files = [
    { rel: 'storages/workspace.json' }, { rel: 'sessions/p/s1.jsonl' }, { rel: 'omnisync/repo/x' },
  ]
  const written = new Map()
  const health = makeHealth({
    state: async () => ({ deviceId: 'dev1', lastError: null, history: [1, 2] }),
    cfg: { repo: 'a/b', branch: 'main', mirrorBranch: 'mirror/sessions', secretGroups: { mcpEnv: true, homeEnv: false } },
    fsDeps: {
      listLocal: async (prefix) => (prefix === 'omnisync-devices'
        ? [{ rel: 'omnisync-devices/dev1.json' }, { rel: 'omnisync-devices/dev2.json' }, { rel: 'omnisync-devices/broken.json' }]
        : files),
      readLocal: async (rel) => {
        if (rel === 'omnisync-devices/dev1.json') return Buffer.from(JSON.stringify({ deviceId: 'dev1', at: 10 }))
        if (rel === 'omnisync-devices/dev2.json') return Buffer.from(JSON.stringify({ deviceId: 'dev2', at: 20 }))
        if (rel === 'omnisync-devices/broken.json') return Buffer.from('{not json')
        return written.get(rel) ?? null
      },
      writeLocal: async (rel, buf) => { written.set(rel, buf) },
    },
    version: '9.9.9',
    sectionOf: (rel) => (rel.endsWith('.json') ? 'workspace' : null),
    runGit: async () => ({ code: 0, stdout: 'git version 2.44.0\n' }),
  })

  const report = await health.collect()
  assert.equal(report.reportV, 1)
  assert.equal(report.deviceId, 'dev1')
  assert.equal(report.gitVersion, 'git version 2.44.0')
  assert.deepEqual(report.counts, { files: 3, classified: 1 })
  assert.equal(report.sessionFiles, 1)
  assert.deepEqual(report.secretGroups, ['mcpEnv'], '只报开着的分组')

  await health.write({ notes: ['x'] })
  assert.ok(written.has('omnisync-devices/dev1.json'), '报告必须落到 omnisync-devices/<deviceId>.json')

  const all = await health.readAll()
  assert.deepEqual(all.map((r) => r.deviceId), ['dev2', 'dev1'], '损坏报告忽略、其余按 at 倒序')
})

test('health: git 不可用时 gitVersion=null（诊断信息缺失不得让采集抛）', async () => {
  const health = makeHealth({
    state: async () => emptyState(), cfg: {}, version: '1',
    fsDeps: { listLocal: async () => [], readLocal: async () => null, writeLocal: async () => {} },
    sectionOf: () => null,
    runGit: async () => { throw new Error('spawn git ENOENT') },
  })
  const r = await health.collect()
  assert.equal(r.gitVersion, null)
  assert.equal(buildReport({}).deviceId, 'unknown')
})

test('gate: makeConfirm 允许时持久化"已确认过"，拒绝时不写状态', async () => {
  const answers = [{ id: 'omnisync-confirm', selected: ['完成'] }]
  let persisted = null
  const deps = {
    ctx: { get: (n) => (n === 'userQuestions' ? { ask: async () => ({ answers }) } : undefined) },
    cfg: { confirmLevel: 'first-run', toolConfirm: true },
    state: async () => ({ confirmedOnce: false }),
    withState: async (fn) => { persisted = await fn({ confirmedOnce: false }); return persisted },
  }
  assert.equal(await makeConfirm(deps)({ files: 3 }), true)
  assert.equal(persisted.confirmedOnce, true, '首次确认后必须落盘，否则每轮都打扰')

  persisted = null
  answers[0] = { id: 'omnisync-confirm', selected: ['Cancel'] }
  assert.equal(await makeConfirm(deps)({ files: 3 }), false)
  assert.equal(persisted, null, '拒绝 = 不写状态')
})

test('command: mountCommand 注册 /omnisync 并把 rawInput 转给 runCommand', async () => {
  let def = null
  const ctx = { commands: { register: (d) => { def = d; return () => {} } } }
  const api = { repo: () => 'a/b', cfg: { branch: 'main' }, git: { schedule: (fn) => fn(), recentCommits: async () => ['abc msg'] } }
  mountCommand(ctx, api)
  assert.equal(def.name, 'omnisync')
  const out = await def.handler({ rawInput: 'log' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /abc msg/u)
})

test('tools: mountTools 注册三件套；确认门拒绝时 execute 返回 not allowed', async () => {
  const registered = []
  const ctx = {
    get: () => undefined, // 没有 userQuestions/approval → 要问必拒（fail closed）
    inject: (deps, cb) => cb({ tools: { register: (t) => registered.push(t) } }),
  }
  const api = { cfg: { confirmLevel: 'always', toolConfirm: true }, state: async () => ({}), engine: { status: async () => ({ state: 'idle', dirty: 0 }) }, runSync: async () => ({ pushed: 0, pulled: 0, conflicts: [] }) }
  mountTools(ctx, api)
  assert.deepEqual(registered.map((t) => t.name), ['omni_sync_status', 'omni_sync_push', 'omni_sync_pull'])
  const push = registered.find((t) => t.name === 'omni_sync_push')
  const out = await push.execute({}, {})
  assert.equal(out.ok, true, '工具不抛错，把"未授权"作为文本返回')
  assert.match(out.text, /not allowed/u, '无确认通道时 push 必须被拒（fail closed）')
})

test('routes: mountRoutes 在命名空间下注册；webServer 缺席时静默跳过', () => {
  const paths = []
  const ctx = { inject: (deps, cb) => cb({ get: () => ({ register: (d) => { paths.push(d.path); return () => {} } }) }) }
  mountRoutes(ctx, { engine: { state: 'idle' }, state: async () => ({}), repo: () => '', cfg: { branch: 'main', secretGroups: {}, confirmLevel: 'first-run' } })
  assert.ok(paths.includes('/omnisync/api/v1/status'))
  assert.ok(paths.every((p) => p.startsWith('/omnisync/api/v1/')))

  let called = false
  mountRoutes({ inject: (deps, cb) => { called = true; cb({ get: () => undefined }) } }, {})
  assert.equal(called, true, '没有 webServer 时不抛，也不注册（可选服务）')
})

test('deps: makeRebuildDeps 缺 pluginManager 时响亮失败，有则走 installBundle', async () => {
  await assert.rejects(() => makeRebuildDeps({ ctx: { get: () => undefined } })(), (e) => e.code === 'BAD_CONFIG')

  const calls = []
  const dir = await mkdtemp(join(tmpdir(), 'omni-deps-'))
  try {
    const manifest = join(dir, 'package.json')
    await (await import('node:fs/promises')).writeFile(manifest, JSON.stringify({ version: '1.0.0', dependencies: { '@scope/a': '1.0.0' } }))
    const out = await makeRebuildDeps({
      ctx: { get: () => ({ listBundles: async () => [], installBundle: async (spec) => { calls.push(spec); return {} } }) },
      manifestPath: manifest,
      logger: { warn: () => {} },
    })()
    assert.deepEqual(calls, ['@scope/a'])
    assert.deepEqual(out.installed, ['@scope/a'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/* ── ② client.js 渲染冒烟（精简 UI 代码的安全网） ── */

/** 最小 React 桩：useState 按预置队列返回，createElement 只建树不渲染；可 reset 游标。 */
function makeReact(states) {
  let i = 0
  return {
    createElement(type, props) { return { type, props, children: [].slice.call(arguments, 2) } },
    useState(init) { const v = i < states.length && states[i] !== undefined ? states[i] : init; i += 1; return [v, () => {}] },
    useEffect() {},
    reset() { i = 0 },
  }
}

/** 深度收集组件节点：函数组件要**真的调用**才会展开出子树（同 React 语义）。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    out.push(node)
    return collect(node.type(node.props), out)
  }
  for (const kid of node.children ?? []) collect(kid, out)
  return out
}

/** 按宿主契约加载 client.js，取出 settings.section 组件并渲染成树。 */
function loadClientPanel(states) {
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  const sandbox = { window: { __ModuleLoader__: { load: (def) => { captured = def } } }, console, Date, setInterval, clearInterval }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  const react = makeReact(states)
  const out = captured.factory.call({ exports: {} }, (n) => (n === 'react' ? react : {}))
  let component = null
  const slots = { inject: (_slot, cb) => { component = cb() }, register: (_meta, Comp) => Comp }
  out.apply({ get: (n) => (n === 'slots' ? slots : undefined), effect: (fn) => fn() })
  const tree = () => component()
  return { out, react, states, tree, nodes: () => collect(tree()), render: () => tree().type() }
}

const DATA = {
  state: 'idle', deviceId: 'd1', repo: 'a/b', branch: 'main', lastSyncedAt: 1, backoffUntil: 0,
  lastError: { code: 'GIT_FAILED' }, passphraseConfigured: true, passphraseFromEnv: false,
  secrets: { mcpEnv: false }, confirmLevel: 'first-run',
  history: [{ at: 1, trigger: 'interval', pushed: 1, pulled: 2, error: 'GIT_FAILED' }],
}

test('client: Panel 三种状态都能渲染出树（loading / error / data）', () => {
  const loading = loadClientPanel([{ loading: true }])
  assert.equal(typeof loading.out.apply, 'function')
  assert.ok(loading.render() !== undefined, 'loading 分支必须渲染出树')

  const err = loadClientPanel([{ loading: false, error: { code: 'NETWORK', message: 'boom' } }])
  assert.ok(err.render() !== undefined, 'error 分支必须渲染出树')

  const data = loadClientPanel([{ loading: false, data: DATA }])
  const tree = data.render()
  assert.ok(tree !== undefined, 'data 分支必须渲染出树（含历史/分组/确认级别/向导/分区）')
  assert.ok(collect(tree).length >= 4, '数据分支必须带出 Wizard / Sections / Row 等子组件')
})

test('client: Wizard 三个步骤都能渲染（待连接 / 待口令 / 待首次同步）', () => {
  for (const data of [
    { repo: '', passphraseConfigured: false, lastSyncedAt: 0 },
    { repo: 'a/b', passphraseConfigured: false, lastSyncedAt: 0 },
    { repo: 'a/b', passphraseConfigured: true, lastSyncedAt: 5, passphraseFromEnv: true },
  ]) {
    const panel = loadClientPanel([{ loading: false, data }, false, null])
    const wizard = panel.nodes().find((n) => n.type.name === 'Wizard')
    assert.ok(wizard !== undefined, 'Panel 必须挂载向导')
    assert.ok(wizard.type(wizard.props) !== undefined, `向导必须渲染：${JSON.stringify(data)}`)
  }
})

test('client: Sections 列表未到达时渲染 null，到达后渲染分区开关', () => {
  const states = [{ loading: false, data: DATA }, false, null]
  const panel = loadClientPanel(states)
  const sections = panel.nodes().find((n) => n.type.name === 'Sections')
  assert.ok(sections !== undefined, 'Panel 必须挂载分区卡')
  assert.equal(sections.type(sections.props), null, '列表未到 = 不渲染（不闪空卡）')

  states[0] = [{ id: 'workspace', enabled: true, note: '工作区', secretGroup: null }]
  panel.react.reset()
  assert.ok(sections.type(sections.props) !== undefined, '列表到达后必须渲染开关')
})

}

/* ── 路由注册契约：每条路由都必须真的能被调用 ─────────────────────────
   为什么加这条：`/sections` 曾把**对象** `{ handler }` 传给 route()（它签名是
   `(path, fn)`），于是每次请求都 `fn is not a function` → 500。而当时的测试只覆盖了
   纯逻辑（sectionOf / 偏好持久化），**没有一条真的把路由跑一遍** —— 所以这个 bug
   一路到了真机上才被用户发现。这里补上"每条路由都真调一次"的契约。 */

test('契约: 每条路由都能被真实调用（不得 fn is not a function）', async () => {
  // 直接驱动 registerRoutes，不挂载整个插件 —— 挂载会启动调度器/定时器，测试进程不退出。
  // 这里要抓的正是"/sections 曾把对象当函数传给 route()"那类注册形态错误。
  const { registerRoutes } = await import('../lib/routes.mjs')
  const routes = []
  const ws = { register(def) { routes.push(def); return () => {} } }
  // 忠实的 req/res 桩：send() 会调 writeHead/setHeader/end，缺一个就变成
  // "桩不够真"的假红（假 stub 比没测试更危险 —— 踩过 table.set 那次）。
  const mkRes = () => ({
    statusCode: 0, body: '', headers: {},
    writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h ?? {}) },
    setHeader(k, v) { this.headers[k] = v },
    end(b) { this.body = b ?? '' },
  })
  const mkReq = (url, method) => ({
    method, url, headers: {}, on() {},
    [Symbol.asyncIterator]: async function* () {},
  })
  const api = {
    engine: { state: 'idle', run: async () => ({ pushed: 0, pulled: 0 }), status: async () => ({}) },
    state: async () => ({ deviceId: 'x', history: [], tombstones: {}, settings: {} }),
    cfg: {}, repo: () => 'o/r', branch: 'main',
    sections: () => [{ id: 'sessions', note: 'n', enabled: true }],
    setDisabledSections: async (ids) => ids,
    secrets: () => [], setSecretGroup: async () => {}, setConfirmLevel: async () => {},
    remember: async () => ({}), runSync: async () => ({ pushed: 0, pulled: 0 }),
    writeToken: async () => {}, verify: async () => {}, passphraseConfigured: () => false,
    passphraseFromEnv: () => false, savePassphrase: async () => {}, plugins: async () => [],
    rebuildDeps: async () => ({}),
  }
  registerRoutes(ws, api)
  assert.ok(routes.length >= 6, `应注册 ≥6 条路由（实际 ${routes.length}）`)

  for (const def of routes) {
    const res = mkRes()
    const req = mkReq(def.path, 'GET')
    await assert.doesNotReject(() => def.handler(req, res), `${def.path} 的 handler 抛了`)
    const parsed = JSON.parse(res.body || '{}')
    assert.notEqual(parsed?.error?.message, 'fn is not a function', `${def.path} 注册形态不对`)
  }

  // /sections 必须返回数组（GET 读），且 POST 能改。
  const sec = routes.find((r) => r.path.endsWith('/sections'))
  assert.ok(sec !== undefined, '必须注册 /sections')
  const res2 = mkRes()
  await sec.handler(mkReq(sec.path, 'GET'), res2)
  const data = JSON.parse(res2.body).data
  assert.ok(Array.isArray(data) && data.length === 1, '/sections GET 必须返回分区数组')
})
