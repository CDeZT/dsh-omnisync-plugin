// test/domain.test.mjs — 与**真实持久化栈**联调（离线闭环，零自造桩）。
//
// 为什么需要这个文件：`table.set is not a function` 这个 bug 在真机安装时才暴露，
// 因为旧单测的桩用了想当然的 API 名。这里改为挂载**官方真实三件套**
// （dsh-storage 中枢 + dsh-storage-json 真实后端 + dsh-storage-domain 表单），
// 与 dsh-base/cordis.patch.yml:165-176 的生产装配一致，只把 root 指向临时目录。
//
// 于是"接口误用"与"持久化是否真落盘"两件事都在本文件里被验证。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Context } = await peer('@deepseek-ai/cordis')
const storageHub = await peer('@deepseek-ai/dsh-storage')
const storageJson = await peer('@deepseek-ai/dsh-storage-json')
const storageDomain = await peer('@deepseek-ai/dsh-storage-domain')
const { defineDomain, domainTable, descriptorOf } = await peer('@deepseek-ai/dsh-storage-domain')
import { z } from 'zod'

import { emptyState, migrateState, deriveDeviceId, pushHistory } from '../lib/state.mjs'
const _entry = await pluginEntry()
const { omnisyncDomainSpec } = _entry ?? {}
import { peer, pluginEntry, skipWithoutPeers, tmpRoot } from './helpers.mjs'

const tick = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等真实条件成立（真实后端是节流写 —— 固定 sleep 不可靠）。
 * @param {() => Promise<boolean>} cond
 * @param {number} [timeoutMs]
 */
async function waitFor(cond, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await tick(25)
  }
  return false
}

/** 等某条记录真的落到磁盘（避免"读到旧文件"的假失败）。 */
async function waitForPersisted(root, needle) {
  const fs = await import('node:fs/promises')
  return waitFor(async () => {
    const files = await fs.readdir(root, { recursive: true }).catch(() => [])
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const text = await fs.readFile(join(root, f), 'utf8').catch(() => '')
      if (text.includes(needle)) return true
    }
    return false
  })
}

/** 按生产装配挂载真实栈（storage → storage-json → storage-domain）。 */
async function mountStack(root) {
  const ctx = new Context()
  ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })
  // 中枢是 Service 子类（default 导出）。
  ctx.plugin(storageHub.default)
  await tick(20)
  // ★ 必须整个命名空间传进去 —— cordis 从插件对象上读 apply/name/**inject**；
  //   只传 {name, apply} 会丢掉 inject，导致 ctx.storage 未注入、apply 内抛错被吞。
  ctx.plugin(storageJson, { root })
  await tick(30)
  ctx.plugin(storageDomain, { backend: 'json' })
  await tick(30)
  return ctx
}

// 直接用插件**真实的** state schema（不是测试里另写一份）——这样 schema 与
// emptyState 漂移会立刻被测出来。
const STATE_SCHEMA = omnisyncDomainSpec.tables.state.valueSchema

/** 与 index.mjs 完全同形的状态读写（get 同步 / put 异步）。 */
function stateAccess(domain) {
  const table = domain.table('state')
  return {
    table,
    withState: async (fn) => {
      const state = migrateState(table.get('singleton') ?? emptyState())
      if (state.deviceId === null) state.deviceId = deriveDeviceId('test-host', 'darwin')
      const next = await fn(state)
      await table.put('singleton', next)
      return next
    },
  }
}

// 缺宿主 peer 依赖时整份跳过（而不是抛 ERR_MODULE_NOT_FOUND 误导用户）。
const _peersMissing = skipWithoutPeers(['@deepseek-ai/cordis', '@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-storage-json'], 'domain.test.mjs')
if (!_peersMissing) {

test('domain: 真实栈上开域 + 状态往返（get 同步 / put 异步）', async (t) => {
  const root = await tmpRoot(t, 'omni-domain-')
  const ctx = await mountStack(root)
  const domain = await ctx.storageDomain.open(defineDomain({ name: 'omnisync_rt', version: 1, tables: { state: domainTable(STATE_SCHEMA) } }))
  const { table, withState } = stateAccess(domain)

  assert.equal(table.get('singleton'), undefined, 'get 必须同步返回 undefined')

  const a = await withState(async (s) => { s.lastSyncedAt = 111; return s })
  assert.equal(a.deviceId.length, 8, '设备 ID 应被派生并持久化')
  assert.equal(table.get('singleton').lastSyncedAt, 111, '写后可同步读回')

  const b = await withState(async (s) => { s.confirmedOnce = true; s.settings = { confirmLevel: 'auto' }; s.history = pushHistory(s.history, { trigger: 'manual' }); return s })
  assert.equal(b.lastSyncedAt, 111, '第二次读回应保留上次写入')
  assert.equal(b.history.length, 1)
  assert.equal(table.size, 1)
  await domain.close()
})

test('domain: 真的落盘到 storages 目录（不是只活在内存）', async (t) => {
  const root = await tmpRoot(t, 'omni-persist-')
  const ctx = await mountStack(root)
  const domain = await ctx.storageDomain.open(defineDomain({ name: 'omnisync_persist', version: 1, tables: { state: domainTable(z.object({ deviceId: z.string() })) } }))
  await domain.table('state').put('singleton', { deviceId: 'abc12345' })
  await domain.close()
  await tick(30)

  const files = await readdir(root, { recursive: true })
  assert.ok(files.length > 0, `root 下应有持久化文件（实际：${JSON.stringify(files)}）`)
  const contents = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => readFile(join(root, f), 'utf8')))
  assert.ok(contents.some((c) => c.includes('abc12345')), '落盘内容里应有写入的值')
})

test('domain: 重开域后数据仍在（真实持久化，跨重启等价）', async (t) => {
  const root = await tmpRoot(t, 'omni-reopen-')
  const ctx1 = await mountStack(root)
  const d1 = await ctx1.storageDomain.open(defineDomain({ name: 'omnisync_reopen', version: 1, tables: { state: domainTable(STATE_SCHEMA) } }))
  await stateAccess(d1).withState(async (s) => { s.lastSyncedAt = 42; s.confirmedOnce = true; return s })
  await d1.close()
  // 真实后端是节流写：等"记录真的在磁盘上"再重开（不用魔法 sleep）。
  assert.equal(await waitForPersisted(root, '\"lastSyncedAt\": 42'), true, '记录应先落到磁盘')

  // 全新 ctx、同一 root（等价于 DSH 重启）。
  const ctx2 = await mountStack(root)
  const d2 = await ctx2.storageDomain.open(defineDomain({ name: 'omnisync_reopen', version: 1, tables: { state: domainTable(STATE_SCHEMA) } }))
  const restored = await stateAccess(d2).withState(async (s) => s)
  assert.equal(restored.lastSyncedAt, 42, '重启后必须读回上次同步时间')
  assert.equal(restored.confirmedOnce, true, '确认状态必须跨重启保留')
  await d2.close()
})

test('domain: schema 校验发生在开域加载时（真实语义，不是 put 时）', async (t) => {
  const root = await tmpRoot(t, 'omni-valid-')
  const spec = () => defineDomain({ name: 'omnisync_valid', version: 1, tables: { state: domainTable(STATE_SCHEMA) } })
  const ctx = await mountStack(root)
  const domain = await ctx.storageDomain.open(spec())
  const { table, withState } = stateAccess(domain)
  const good = await withState(async (s) => s)

  // put 本身不做校验（官方实现：写直达后端）—— 这是必须记住的真实语义。
  await table.put('singleton', { ...good, deviceId: '' })
  await domain.close()
  assert.equal(await waitForPersisted(root, '\"deviceId\": \"\"'), true, '越界记录应先落到磁盘')

  // 越界记录在下一次开域时被拒（invalid-record），响亮而不是静默。
  const ctx2 = await mountStack(root)
  await assert.rejects(() => ctx2.storageDomain.open(spec()), /invalid-record|does not match its schema|too_small|invalid/iu)
})

test('domain: descriptor 形状与命名规则（官方实现强制）', () => {
  const spec = defineDomain({ name: 'omnisync_desc', version: 1, tables: { state: domainTable(z.object({ a: z.string() })) } })
  const d = descriptorOf(spec)
  assert.equal(d.name, 'omnisync_desc')
  assert.equal(d.version, 1)
  assert.deepEqual(d.tables, ['state'])
  assert.equal(d.hasGlobal, false)
  // 连字符命名会被官方实现拒绝 —— 常量里的 DOMAIN_NAME 必须是下划线。
  assert.throws(() => defineDomain({ name: 'omnisync-bad', version: 1, tables: {} }), /must match|UNIT_NAME/u)
})


test('守卫: 状态 schema 必须覆盖 emptyState 的每一个键（防静默丢状态）', () => {
  // storageDomain 加载记录时按 schema 解析，未声明的键会被 zod 剥掉。
  // 漏掉 `version` 曾导致每次重启 migrateState() 判定版本不符 → 静默重置全部状态。
  const declared = Object.keys(STATE_SCHEMA.shape)
  const required = Object.keys(emptyState())
  const missing = required.filter((k) => !declared.includes(k))
  assert.deepEqual(missing, [], `schema 缺少字段：${missing.join(',')}（会被剥掉 → 重启丢状态）`)
  assert.ok(declared.includes('version'), 'version 必须声明，否则 migrateState 认不出记录')
})

test('守卫: 真实 schema 能往返一个完整 emptyState（含 version）', async (t) => {
  const root = await tmpRoot(t, 'omni-full-')
  const ctx = await mountStack(root)
  const domain = await ctx.storageDomain.open(omnisyncDomainSpec)
  const { table, withState } = stateAccess(domain)
  const written = await withState(async (s) => { s.lastSyncedAt = 7; return s })
  assert.equal(written.version, 1)
  await domain.close()
  assert.equal(await waitForPersisted(root, '"lastSyncedAt": 7'), true)

  // 重开（等价重启）：状态必须原样回来，而不是被重置。
  const ctx2 = await mountStack(root)
  const d2 = await ctx2.storageDomain.open(omnisyncDomainSpec)
  const back = await stateAccess(d2).withState(async (s) => s)
  assert.equal(back.lastSyncedAt, 7, '重启后不得丢状态')
  assert.equal(back.version, 1)
  await d2.close()
})

}
