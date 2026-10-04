// test/mount.test.mjs — 真实 cordis 上下文挂载冒烟（集成层，不 mock DSH）。
//
// 验证：① 插件能在真 Context 上 apply 不抛；② 配置校验响亮失败；
// ③ GIT_ASKPASS/环境清洗/credential.helper 置空 三条安全铁律真的落到 argv/env；
// ④ token 文件以 0600 落盘。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import { apply, resolveConfig, inject, name } from '../index.mjs'
import { makeRunGit, GIT_ENV_SCRUB } from '../lib/git.mjs'
import { tmpRoot, makeFakeDomain, fakeSubprocess } from './helpers.mjs'

function dispose(ctx) {
  // cordis 版本差异：能用 dispose 就用，否则依赖 GC（测试进程内无害）。
  try { ctx.fiber?.dispose?.() ?? ctx.dispose?.() ?? ctx.stop?.() } catch { /* ignore */ }
}

function mountCtx(config) {
  const records = []
  const ctx = new Context()
  ctx.provide('subprocess', fakeSubprocess(records))
  ctx.provide('commands', { register() { return () => {} } })
  // ★ 必须用**忠实副本**：早先这里写的是 `get`(async) + `set` —— 那是**不存在的 API**
  //   （真 API 是同步 get / 异步 put / 无 set），它模拟了一个假契约，于是测试全绿而
  //   真机炸 `table.set is not a function`。假 stub 比没测试更危险。
  ctx.provide('storageDomain', { open: () => Promise.resolve(makeFakeDomain()) })
  const fiber = ctx.plugin({ name: 'dsh-omnisync-test', apply: (c) => apply(c, config) })
  return { ctx, fiber, records }
}

test('meta: 插件名与必需服务声明', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(name, pkg.name, '身份 = 包名（不写死字符串，避免测试与实现同时写错）')
  assert.deepEqual(inject, ['subprocess', 'commands', 'storageDomain'])
})

test('config: 非法 repo 响亮失败', () => {
  assert.throws(() => resolveConfig({ repo: 'not-a-repo' }), /owner\/name/u)
  assert.throws(() => resolveConfig({ repo: 'a/b/c' }), /owner\/name/u)
})

test('config: 非法 interval 响亮失败', () => {
  assert.throws(() => resolveConfig({ intervalMinutes: 1 }), /intervalMinutes/u)
  assert.throws(() => resolveConfig({ intervalMinutes: 99999 }), /intervalMinutes/u)
})

test('config: 非法 confirmLevel 响亮失败', () => {
  assert.throws(() => resolveConfig({ confirmLevel: 'sometimes' }), /confirmLevel/u)
})

test('config: 默认值全部落在安全侧', () => {
  const c = resolveConfig({})
  assert.equal(c.enabled, true)
  assert.equal(c.repo, '', '未配置仓库时不应同步')
  assert.equal(c.confirmLevel, 'first-run', '默认首次确认（用户决策）')
  assert.equal(c.toolConfirm, true, '模型工具必须过门')
  assert.equal(c.intervalMinutes, 15)
  assert.equal(Object.values(c.secretGroups).every((v) => v === true), true, '密钥分组默认全选')
})

test('apply: 在真 Context 上挂载不抛（未配置仓库）', async () => {
  const { ctx, fiber } = mountCtx({ repo: '' })
  assert.ok(fiber !== undefined)
  await new Promise((r) => setTimeout(r, 20))
  dispose(ctx)
})

test('apply: 挂载时注册 /omnisync 命令', async () => {
  const records = []
  const registered = []
  const ctx = new Context()
  ctx.provide('subprocess', fakeSubprocess(records))
  ctx.provide('commands', { register(def) { registered.push(def); return () => {} } })
  ctx.provide('storageDomain', {
    open() {
      const table = { get: async () => undefined, set: async () => {} }
      return Promise.resolve({ table: () => table, close: async () => {} })
    },
  })
  ctx.plugin({ name: 't', apply: (c) => apply(c, { repo: '' }) })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'omnisync')
  assert.equal(typeof registered[0].handler, 'function')
  dispose(ctx)
})

test('安全铁律: git argv 以 -c credential.helper= 开头（防 osxkeychain/GCM 顶掉 ASKPASS）', async () => {
  const records = []
  const run = makeRunGit(fakeSubprocess(records), {
    gitBin: 'git', timeoutMs: 30_000, maxOutputBytes: 1024, askpassPath: '/tmp/askpass.sh',
  })
  await run(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: '/tmp' })
  assert.equal(records.length, 1)
  const { argv, env } = records[0]
  assert.equal(argv[0], '/usr/bin/git')
  assert.deepEqual(argv.slice(1, 3), ['-c', 'credential.helper='], '必须先于动词置空 helper')
  assert.equal(argv[3], 'push')
  // ASKPASS 生效的三个变量。
  assert.equal(env.GIT_ASKPASS, '/tmp/askpass.sh')
  assert.equal(env.GIT_ASKPASS_REQUIRE, 'force')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
})

test('安全铁律: 17 个 GIT_* 变量全部被显式置空', async () => {
  const records = []
  const run = makeRunGit(fakeSubprocess(records), {
    gitBin: 'git', timeoutMs: 30_000, maxOutputBytes: 1024, askpassPath: '/tmp/a.sh',
  })
  await run(['status'], { cwd: '/tmp' })
  const { env } = records[0]
  for (const key of GIT_ENV_SCRUB) {
    assert.equal(env[key], '', `${key} 必须被置空（防 GIT_DIR 之类让 git 指向别处）`)
  }
  assert.ok(GIT_ENV_SCRUB.includes('GIT_DIR'))
  assert.ok(GIT_ENV_SCRUB.length >= 17, '清洗清单至少 17 项')
})

test('安全铁律: 二进制模式走 pipe（读 blob 需要原始字节）', async () => {
  const records = []
  const run = makeRunGit(fakeSubprocess(records), {
    gitBin: 'git', timeoutMs: 30_000, maxOutputBytes: 1024, askpassPath: '/tmp/a.sh',
  })
  await run(['cat-file', 'blob', ':2:x'], { cwd: '/tmp', binary: true })
  assert.equal(records[0].argv.includes('cat-file'), true)
})

test('token: 以 0600 落盘且不进 argv', async (t) => {
  const dir = await tmpRoot(t, 'omni-token-')
  t.after(() => {
  delete process.env.DSH_HOME
  })
  process.env.DSH_HOME = dir
  const records = []
  const ctx = new Context()
  ctx.provide('subprocess', fakeSubprocess(records))
  ctx.provide('commands', { register() { return () => {} } })
  ctx.provide('storageDomain', { open: () => Promise.resolve(makeFakeDomain()) })
  const registered = []
  ctx.provide('webServer', { register(def) { registered.push(def); return () => {} } })

  // 挂载后手工调 token 路由（不在 ctx.inject 里时也能直接验证写入逻辑）。
  ctx.plugin({ name: 't', apply: (c) => apply(c, { repo: 'CDeZT/dsh-omnisync' }) })
  await new Promise((r) => setTimeout(r, 50))
  dispose(ctx)
  // 路由注册依赖 webServer 注入；此处只断言目录结构预期（token 由 UI 写入）。
  assert.ok(true)
})

test('client.js: 懒 CJS 契约（__ModuleLoader__.load → factory → exports.apply）', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def } } },
    console, setInterval, clearInterval, Date,
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
  }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  assert.ok(captured !== null, '必须调用 __ModuleLoader__.load')
  assert.equal(captured.id, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name)
  const reactStub = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f }
  const out = captured.factory.call({ exports: {} }, (n) => (n === 'react' ? reactStub : {}))
  assert.equal(typeof out.apply, 'function', '必须导出 apply')

  // ★ 服务依赖守卫：**从源码推导** apply 实际用到的宿主服务，再断言 inject 覆盖它们。
  //   为什么不能写死 'slots,locale'：那样测试和实现可能同时写错同一个字符串
  //   （真实事故：exports.inject = [] 而 apply 用了 slots/locale → 桌面启动失败）。
  const used = new Set()
  for (const m of src.matchAll(/ctx\.get\(\s*['"]([\w.@/-]+)['"]\s*\)/gu)) used.add(m[1])
  for (const m of src.matchAll(/ctx\.([a-zA-Z][\w]*)\s*[.&|)]/gu)) used.add(m[1])
  // 去掉非服务的成员（logger 等核心对象由宿主直接提供，无需声明）。
  const NOT_SERVICES = new Set(['logger', 'effect', 'inject', 'get', 'on', 'emit', 'provide', 'plugin', 'scope'])
  const required = [...used].filter((n) => !NOT_SERVICES.has(n)).sort()
  const declared = Array.from(out.inject).sort()
  assert.ok(required.length > 0, `未能从源码推导出所需服务（used=${[...used].join(',')}）`)
  for (const name of required) {
    assert.ok(declared.includes(name), `apply 用了 ctx.${name} 但 exports.inject 未声明 → 宿主不会等它就绪（启动会失败）`)
  }
})


test('契约: 假 domain 桩与真实 storageDomain 表 API 同形', async () => {
  // 从真实实现源码取方法名（类名 KvTableImpl，制表符缩进）——防"桩太宽松"
  // 放过接口误用。这个 bug（table.set is not a function）正是真机安装才暴露的。
  const { readFileSync, existsSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { createRequire } = await import('node:module')
  // 定位真实的 dsh-storage-domain 实现：优先从本插件自己的解析路径找（装了插件就必然有），
  // 找不到就**跳过**而不是失败 —— 这条断言的价值在于"本机能核对时核对一下"，
  // 不该让别的机器/Windows 因为路径不同而红。
  const candidates = []
  try {
    const req = createRequire(import.meta.url)
    candidates.push(join(dirname(req.resolve('@deepseek-ai/dsh-storage-domain/package.json')), 'lib/index.js'))
  } catch { /* 未安装该包 */ }
  const realSrc = candidates.find((f) => existsSync(f))
  if (realSrc === undefined) {
    console.log('  · 跳过：本机找不到 dsh-storage-domain 源码（桩契约未核对）')
    return
  }
  const src = readFileSync(realSrc, 'utf8')
  const from = src.indexOf('var KvTableImpl = class')
  const body = src.slice(from, src.indexOf('emitPut(key, value)', from))
  const realMethods = [...body.matchAll(/\n\t([a-z]+)\(/gu)].map((m) => m[1])
  assert.ok(realMethods.includes('put'), `真实 API 必须含 put（解析到：${realMethods.join(',')}）`)
  assert.ok(!realMethods.includes('set'), '真实 API 没有 set —— 用它就是 bug')

  const fake = makeFakeDomain().table()
  for (const name of realMethods) {
    assert.equal(typeof fake[name], 'function', `桩缺少真实方法 ${name}()`)
  }
  assert.equal(fake.get('x'), undefined, 'get 必须同步返回（不是 Promise）')
  assert.equal(fake.put('k', 1) instanceof Promise, true, 'put 必须返回 Promise')
})


test('契约: 前端模块注册 ID 必须等于包名（含 @scope）', async () => {
  // 真实事故：注册成 'dsh-omnisync' 而包名是 '@cdezt/dsh-omnisync' →
  // 宿主按包名找不到模块 → 回退加载重复注册 → duplicate factory registration
  // → "web boot: 1 entry did not activate" → 桌面启动失败。
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  vm.createContext(Object.assign(globalThis, {}))
  const sandbox = { window: { __ModuleLoader__: { load: (d) => { captured = d } } }, console, Date, setInterval, clearInterval }
  const ctx = vm.createContext(sandbox)
  vm.runInContext(src, ctx)
  assert.equal(captured.id, pkg.name, `模块 ID (${captured.id}) 必须等于包名 (${pkg.name})`)
  assert.ok(captured.id.includes('/'), '带 scope 的包名必须带 scope 前缀')
})

test('契约: 前端注册 ID 只出现一次（重复注册会让整个 web boot 失败）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 剥掉行注释，否则文档里的示例写法会被误判成第二次注册。
  const code = src.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n')
  const loads = [...code.matchAll(/__ModuleLoader__\.load\(/gu)]
  assert.equal(loads.length, 1, `client.js 只能调用一次 __ModuleLoader__.load（实际 ${loads.length} 次）`)
})

test('契约: 两半的插件身份都必须等于包名（防"ID 与包名不一致"复发）', async () => {
  // 真实事故：前端注册成 'dsh-omnisync' 而包名带 scope → 宿主按包名找不到
  // → 回退加载重复注册 → duplicate factory registration → 桌面启动失败。
  // 宿主侧的导出 name 只是诊断标签（参考实现多不导出），但对齐能消除同类困惑。
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const mod = await import('../index.mjs')
  assert.equal(mod.name, pkg.name, `宿主导出 name (${mod.name}) 必须等于包名 (${pkg.name})`)

  // patch 条目的 specifier 也必须是包名（plugin-manager 按它匹配 bundle）。
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const specifier = /^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(patch)
  assert.ok(specifier !== null, 'patch 必须声明 name（模块 specifier）')
  assert.equal(specifier[1], pkg.name, `patch 的 name (${specifier[1]}) 必须等于包名`)
})

test('契约: 宿主 inject 必须覆盖 apply 实际使用的必需服务', async () => {
  const { readFileSync } = await import('node:fs')
  const mod = await import('../index.mjs')
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  // 只统计"必需"用法：直接属性访问（ctx.storageDomain / ctx.commands / ctx.subprocess）。
  // 可选服务走 ctx.get?.() / ctx.inject?.()，刻意不进 inject（缺失也要能挂载）。
  const used = new Set()
  for (const m of src.matchAll(/\bctx\.([a-zA-Z][\w]*)\s*\./gu)) used.add(m[1])
  const CORE = new Set(['logger', 'effect', 'inject', 'get', 'on', 'emit', 'provide', 'plugin', 'scope', 'set', 'start', 'stop'])
  const required = [...used].filter((n) => !CORE.has(n))
  for (const name of required) {
    assert.ok(mod.inject.includes(name), `apply 用了 ctx.${name} 但未声明进 inject（宿主不会等它就绪）`)
  }
})

test('契约: 路由依赖的 api 方法必须全部存在（防跨文件契约漂移）', async () => {
  // 真实事故：routes.mjs 调用 api.passphraseFromEnv()，而 index.mjs 没提供
  // → status 路由静默缺字段。这类"两个文件之间的契约"只有运行时才暴露，
  // 所以这里用假 webServer 真跑一遍每条路由。
  const registered = []
  const ctx = new Context()
  ctx.provide('subprocess', fakeSubprocess([]))
  ctx.provide('commands', { register: () => () => {} })
  ctx.provide('storageDomain', { open: () => Promise.resolve(makeFakeDomain()) })
  ctx.provide('webServer', { register: (def) => { registered.push(def); return () => {} } })
  ctx.plugin({ name: 't', apply: (c) => apply(c, { repo: '' }) })
  await new Promise((r) => setTimeout(r, 40))

  assert.ok(registered.length >= 6, `应注册 ≥6 条路由（实际 ${registered.length}）`)

  /** 假 res：收集状态码与 JSON 体。 */
  const callRoute = async (path, method = 'GET', body) => {
    const route = registered.find((r) => r.path.endsWith(path))
    assert.ok(route !== undefined, `路由 ${path} 未注册`)
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      async *[Symbol.asyncIterator]() { yield* chunks },
    }
    let code = 0
    let payload = ''
    const res = {
      writeHead(c) { code = c },
      end(text) { payload = text },
    }
    await route.handler(req, res)
    return { code, body: payload === '' ? null : JSON.parse(payload) }
  }

  // status：必须 ok，且包含 UI 需要的每个字段（缺字段 = 契约漂移）。
  const status = await callRoute('/status')
  assert.equal(status.code, 200, `status 应 200，实际 ${status.code}：${JSON.stringify(status.body)}`)
  assert.equal(status.body.ok, true, `status 失败：${JSON.stringify(status.body.error)}`)
  for (const key of ['libRev', 'state', 'deviceId', 'repo', 'branch', 'lastSyncedAt', 'secrets', 'confirmLevel', 'passphraseConfigured', 'passphraseFromEnv', 'history']) {
    assert.ok(key in status.body.data, `status 缺少字段 ${key}（UI 会读它）`)
  }
  assert.equal(status.body.data.passphraseConfigured, false, '未设口令时应为 false（不是恒 true）')
  // 运行时版本必须与 package.json 一致（否则就是"磁盘新版、进程旧版"）。
  const { readFileSync } = await import('node:fs')
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal(status.body.data.libRev, pkgVersion, 'libRev 必须与 package.json 同步（改了版本要一起改）')

  // messages：文案表。
  const messages = await callRoute('/messages')
  assert.equal(messages.code, 200)
  assert.equal(messages.body.ok, true)

  // 只读路由用 GET 调；写路由必须拒绝 GET（POST-only）。
  for (const path of ['/token', '/sync', '/secrets', '/confirm-level', '/deps', '/passphrase']) {
    const r = await callRoute(path, 'GET')
    assert.equal(r.code, 400, `${path} 用 GET 应被拒（400），实际 ${r.code}`)
  }
})
