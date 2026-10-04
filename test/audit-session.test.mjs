// test/audit-session.test.mjs — 会话流加固（task-7）的回归测试。
//
// 覆盖三块：
//   ① 落本机路径防御（纵深防御：拦截必须在 lib/sessions.mjs 里发生，而不是靠 fs 层兜底）
//   ② 大文件写前备份策略（阈值 + 跳过必须留痕）
//   ③ 双向幂等与 fork 语义（本机领先不被旧树覆盖；远端版本转 fork 且命名合协议）
//
// 全部用**朴素 ctx**（故意不做任何校验/原子写）：这样一旦断言通过，就证明
// 拦截发生在本模块内部 —— 生产环境的 fsDeps 会再挡一层，两层互不依赖。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applySessionsToLocal, mirrorSessions, isSessionPath, sessionTargetVerdict, SESSION_BACKUP_MAX_BYTES } from '../lib/sessions.mjs'
import { FORK_NAME_RE } from '../lib/constants.mjs'
import { rejectsCode } from './helpers.mjs'

/**
 * 朴素 ctx：Map 当盘，零校验。
 * @param {object} [opts]
 * @param {Map<string, Buffer>} [opts.tree] - 镜像树内容。
 * @param {Map<string, Buffer>} [opts.local] - 本机内容。
 * @returns {{ctx: object, calls: object, tree: Map, local: Map, log: string[], backed: string[]}}
 */
function naiveCtx(opts = {}) {
  const tree = opts.tree ?? new Map()
  const local = opts.local ?? new Map()
  const calls = { readTree: [], readLocal: [], writeLocal: [] }
  const log = []
  const backed = []
  const ctx = {
    listTree: async () => [...tree.keys()],
    readTree: async (rel) => { calls.readTree.push(rel); return tree.get(rel) ?? null },
    readLocal: async (rel) => { calls.readLocal.push(rel); return local.get(rel) ?? null },
    writeLocal: async (rel, data) => { calls.writeLocal.push(rel); local.set(rel, data); return true },
    logger: { warn: (m) => log.push(m) },
  }
  if (opts.base !== undefined) ctx.base = opts.base
  if (opts.backup !== false) {
    ctx.backupDir = async (kind) => `backups/${kind}`
    ctx.backupFile = async (rel, dir) => { backed.push(rel); return `${dir}/${rel}` }
  }
  if (opts.deviceId !== undefined) ctx.deviceId = opts.deviceId
  if (opts.now !== undefined) ctx.now = opts.now
  return { ctx, calls, tree, local, log, backed }
}

/* ─────────────────────────── ① 落本机路径防御 ─────────────────────────── */

test('会话: 落本机拒绝树里的越界路径（本模块拦截，不依赖 fs 层）', async () => {
  const bad = [
    'sessions/../pwned.jsonl',                    // 上跳出 $DSH_HOME
    'sessions/proj/../../../pwned.jsonl',         // 深上跳
    'storages/session_projcache/../../pwned.json', // projcache 分支同样要挡
    'sessions/proj/a\0b.jsonl',                   // NUL 截断
  ]
  for (const rel of bad) {
    const { ctx, calls } = naiveCtx({ tree: new Map([[rel, Buffer.from('pwned')]]) })
    await assert.rejects(
      () => applySessionsToLocal(ctx),
      (err) => err.code === 'PATH_UNSAFE',
      `${rel} 必须被本模块拒绝（PATH_UNSAFE）`,
    )
    assert.deepEqual(calls.writeLocal, [], `${rel} 绝不能被写`)
    assert.deepEqual(calls.readTree, [], `${rel} 连读都不该发生（裁决先于 I/O）`)
  }
})

test('会话: 目标裁决分支（会话 / 硬排除 / 宿主产物 / 越界 / 非会话）', () => {
  assert.equal(sessionTargetVerdict('sessions/p/s.jsonl').ok, true)
  assert.equal(sessionTargetVerdict('storages/session_projcache/p/s.json').ok, true)
  assert.equal(sessionTargetVerdict('AGENTS.md').reason, 'not-session')
  // NEVER_SYNC 守卫必须**真的被查询**：断言 reason 而不是 ok，否则无法区分是哪条分支拒的。
  assert.equal(sessionTargetVerdict('storages/omnisync.json').reason, 'never-synced')
  assert.equal(sessionTargetVerdict('omnisync/passphrase.vault').reason, 'never-synced')
  assert.equal(sessionTargetVerdict('sessions/p/session.lock').reason, 'host-artifact')
  assert.equal(sessionTargetVerdict('sessions/../x').reason, 'unsafe')
  assert.equal(sessionTargetVerdict('').reason, 'not-session')
  assert.equal(sessionTargetVerdict(null).reason, 'not-session')
})

test('会话: 越界路径不阻断其它合法文件的落地（先裁决、后写，但顺序不掩盖）', async () => {
  const { ctx, local } = naiveCtx({
    tree: new Map([
      ['sessions/p/ok.jsonl', Buffer.from('good')],
      ['sessions/../pwned.jsonl', Buffer.from('pwned')],
    ]),
  })
  // 顺序不定：无论先撞到哪个，最终都必须抛出，且越界项永不落盘。
  await rejectsCode(() => applySessionsToLocal(ctx), 'PATH_UNSAFE')
  assert.equal(local.has('sessions/../pwned.jsonl'), false, '越界项绝不落盘')
})

/* ─────────────────────────── ② 大文件写前备份策略 ─────────────────────────── */

test('会话: 小文件写前备份，超阈值的大文件不备份但必须留痕', async () => {
  const big = Buffer.alloc(SESSION_BACKUP_MAX_BYTES + 1, 7)
  const small = Buffer.from('old-small')
  const { ctx, backed, log, local } = naiveCtx({
    tree: new Map([
      ['sessions/p/big.jsonl.zstd', Buffer.from('new-big')],
      ['sessions/p/small.jsonl.zstd', Buffer.from('new-small')],
    ]),
    local: new Map([
      ['sessions/p/big.jsonl.zstd', big],
      ['sessions/p/small.jsonl.zstd', small],
    ]),
  })
  const n = await applySessionsToLocal(ctx)
  assert.equal(n, 2, '两个文件都应落地（备份策略不改变落盘结果）')
  assert.deepEqual(backed, ['sessions/p/small.jsonl.zstd'], '只备份 ≤ 阈值的那一个')
  assert.ok(
    log.some((m) => m.includes('backup skipped') && m.includes('big.jsonl.zstd')),
    `跳过备份必须留痕（当前日志：${JSON.stringify(log)}）`,
  )
  assert.equal(local.get('sessions/p/big.jsonl.zstd').toString(), 'new-big', '跳过备份 ≠ 跳过写入')
})

test('会话: 新文件（本机无旧字节）不产生备份', async () => {
  const { ctx, backed } = naiveCtx({ tree: new Map([['sessions/p/new.jsonl', Buffer.from('x')]]) })
  assert.equal(await applySessionsToLocal(ctx), 1)
  assert.deepEqual(backed, [], '没有旧内容可备份 → 不该调用 backupFile')
})

test('会话: 内容一致时既不写也不备份（幂等 + 不惊动 chokidar）', async () => {
  const same = Buffer.from('same-bytes')
  const { ctx, calls, backed } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl', same]]),
    local: new Map([['sessions/p/s.jsonl', same]]),
  })
  assert.equal(await applySessionsToLocal(ctx), 0)
  assert.deepEqual(calls.writeLocal, [], '内容一致绝不能再写（重写会触发 DSH 热重载）')
  assert.deepEqual(backed, [], '没写就不该备份')
})

test('会话: 未接线备份能力时不报错（备份是后悔药，不是前置条件）', async () => {
  const { ctx } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl', Buffer.from('new')]]),
    local: new Map([['sessions/p/s.jsonl', Buffer.from('old')]]),
    backup: false,
  })
  assert.equal(await applySessionsToLocal(ctx), 1)
})

/* ─────────── ③ 双向幂等：本机领先绝不被旧树覆盖（三方 base） ─────────── */

test('会话: 有基点时「本机领先」绝不被旧树覆盖（会丢对话的真 bug）', async () => {
  const base = Buffer.from('turns-1..10')
  const localNewer = Buffer.from('turns-1..12') // 本轮新追加的两轮对话，还没镜像上去
  const { ctx, calls, local } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', base]]), // 远端没动 → 树 == 基点
    local: new Map([['sessions/p/s.jsonl.zstd', localNewer]]),
    base: async () => base,
  })
  assert.equal(await applySessionsToLocal(ctx), 0, '本机领先时不该写主路径')
  assert.deepEqual(calls.writeLocal, [], '一个字节都不该写')
  assert.equal(local.get('sessions/p/s.jsonl.zstd').toString(), 'turns-1..12', '本机字节必须原封不动')
})

test('会话: 有基点时「远端领先」正常落地（不能因为加固就不更新）', async () => {
  const base = Buffer.from('turns-1..10')
  const treeNewer = Buffer.from('turns-1..14')
  const { ctx, local } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', treeNewer]]),
    local: new Map([['sessions/p/s.jsonl.zstd', base]]), // 本机 == 基点（本机没动）
    base: async () => base,
  })
  assert.equal(await applySessionsToLocal(ctx), 1)
  assert.equal(local.get('sessions/p/s.jsonl.zstd').toString(), 'turns-1..14')
})

test('会话: 有基点时「双方都改」→ 本机留主路径 + 远端版本转 fork（绝不二选一）', async () => {
  const base = Buffer.from('turns-1..10')
  const ours = Buffer.from('turns-1..12-local')
  const theirs = Buffer.from('turns-1..13-remote')
  const { ctx, calls, local } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', theirs]]),
    local: new Map([['sessions/p/s.jsonl.zstd', ours]]),
    base: async () => base,
    deviceId: 'abcdef01',
    now: Date.parse('2026-10-04T12:00:00Z'),
  })
  assert.equal(await applySessionsToLocal(ctx), 1, '只写 fork 这一个文件')
  assert.equal(local.get('sessions/p/s.jsonl.zstd').toString(), 'turns-1..12-local', '本机版本留在主路径')
  const forks = calls.writeLocal.filter((r) => r !== 'sessions/p/s.jsonl.zstd')
  assert.equal(forks.length, 1, '远端版本必须转成 fork')
  assert.match(forks[0], FORK_NAME_RE, 'fork 命名必须合协议（否则 forks.mjs / 用户都找不到它）')
  assert.equal(local.get(forks[0]).toString(), 'turns-1..13-remote', 'fork 里必须是远端字节')
  assert.equal(isSessionPath(forks[0]), true, 'fork 必须仍属会话类（下轮才能被镜像上去）')
})

test('会话: fork 绝不覆盖已存在的 fork（同秒同设备的极端情形）', async () => {
  const base = Buffer.from('b')
  const forkRel = 'sessions/p/s.jsonl.zstd.remote-fork-20261004120000-abcdef01'
  const { ctx, local } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', Buffer.from('theirs')]]),
    local: new Map([
      ['sessions/p/s.jsonl.zstd', Buffer.from('ours')],
      [forkRel, Buffer.from('earlier-fork')], // 先到的 fork
    ]),
    base: async () => base,
    deviceId: 'abcdef01',
    now: Date.parse('2026-10-04T12:00:00Z'),
  })
  await applySessionsToLocal(ctx)
  assert.equal(local.get(forkRel).toString(), 'earlier-fork', '已存在的 fork 绝不能被覆盖')
  assert.equal(local.get('sessions/p/s.jsonl.zstd').toString(), 'ours', '本机版本仍在主路径')
})

test('会话: 无基点时退回「树优先」但必须留痕（提示接线 ctx.base）', async () => {
  const { ctx, log } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', Buffer.from('theirs')]]),
    local: new Map([['sessions/p/s.jsonl.zstd', Buffer.from('ours')]]),
  })
  assert.equal(await applySessionsToLocal(ctx), 1, '无基点仍按旧行为落地（不改变既有接线）')
  assert.ok(
    log.some((m) => m.includes('base')),
    `无基点的盲覆盖必须留痕（当前日志：${JSON.stringify(log)}）`,
  )
})

test('会话: 有基点且两侧都未动 → 零写入（幂等）', async () => {
  const same = Buffer.from('same')
  const { ctx, calls } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', same]]),
    local: new Map([['sessions/p/s.jsonl.zstd', same]]),
    base: async () => same,
  })
  assert.equal(await applySessionsToLocal(ctx), 0)
  assert.deepEqual(calls.writeLocal, [])
})

test('会话: mirror 方向幂等 —— fork 已在树里且内容一致时不重复上传', async () => {
  const fork = 'sessions/p/s.jsonl.zstd.remote-fork-20261004120000-abcdef01'
  const buf = Buffer.from('remote-version')
  const tree = new Map([[fork, buf]]) // fork 已由冲突裁决写进镜像树
  const walked = []
  const ctx = {
    walkAll: async () => [{ rel: fork, size: buf.length }],
    readLocal: async () => buf,
    // 与 workspace.writeTree 同契约：内容一致 → false（不产生空提交）。
    writeTree: async (rel, data) => {
      walked.push(rel)
      const cur = tree.get(rel)
      if (cur !== undefined && cur.equals(data)) return false
      tree.set(rel, data)
      return true
    },
  }
  assert.equal(await mirrorSessions(ctx), 0, 'fork 不该被当成"新会话"重复上传')
  assert.deepEqual(walked, [fork], 'fork 仍要被走到（不能漏出通道，否则本机新增的 fork 传不上去）')
})

test('会话: 设备 ID 被污染时绝不写出越界 fork 路径（派生路径同样要过闸）', async () => {
  const { ctx, calls, local, log } = naiveCtx({
    tree: new Map([['sessions/p/s.jsonl.zstd', Buffer.from('theirs')]]),
    local: new Map([['sessions/p/s.jsonl.zstd', Buffer.from('ours')]]),
    base: async () => Buffer.from('base'),
    deviceId: '../../evil', // 伪造的 deviceId（本地状态文件可被篡改）
    now: Date.parse('2026-10-04T12:00:00Z'),
  })
  await applySessionsToLocal(ctx)
  assert.deepEqual(calls.writeLocal, [], 'fork 路径含 `..` 时必须整体放弃写入')
  assert.equal(local.get('sessions/p/s.jsonl.zstd').toString(), 'ours', '本机版本必须原封不动')
  assert.ok(log.some((m) => m.includes('fork')), `放弃 fork 必须留痕（当前日志：${JSON.stringify(log)}）`)
})

/* ─────────────────── ④ 真实数据取证（本机无数据时跳过） ─────────────────── */

test('会话: 真实 ~/.dsh/sessions 全量路径都能通过裁决（只挡 session.lock）', async (t) => {
  const { readdir } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const root = `${homedir()}/.dsh`
  const walk = async (dir, rel) => {
    let out = []
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      out = out.concat(e.isDirectory() ? await walk(`${dir}/${e.name}`, r) : [r])
    }
    return out
  }
  const rels = await walk(`${root}/sessions`, 'sessions')
  if (rels.length === 0) return t.skip('本机无 ~/.dsh/sessions 数据')
  const blocked = rels.filter((r) => !sessionTargetVerdict(r).ok)
  // 只允许挡宿主私有产物（session.lock / session.migration.*.tmp / .DS_Store）。
  // 任何别的理由被挡 = 真实会话**静默不同步**（比丢字节更隐蔽的事故）。
  assert.deepEqual(
    [...new Set(blocked.map((r) => sessionTargetVerdict(r).reason))].sort(),
    ['host-artifact'],
    `真实数据里出现了非宿主产物的拦截：${JSON.stringify(blocked.slice(0, 5))}`,
  )
  assert.ok(blocked.every((r) => /(?:session\.lock|session\.migration\..+\.tmp|\.DS_Store)$/u.test(r)), '被挡的必须都是宿主产物')
  const cache = await walk(`${root}/storages/session_projcache`, 'storages/session_projcache')
  assert.deepEqual(cache.filter((r) => !sessionTargetVerdict(r).ok), [], '投影缓存路径必须全部可同步')
})

/* ─────────────────────────── ③ fork 语义（判定层） ─────────────────────────── */

test('会话: fork 路径仍属会话类（否则 fork 永远落不了本机）', () => {
  const fork = 'sessions/proj/s1/session.v4.jsonl.zstd.remote-fork-20261004120000-abcdef01'
  assert.equal(isSessionPath(fork), true)
  assert.equal(sessionTargetVerdict(fork).ok, true, 'fork 必须通过裁决（不能被当宿主产物跳过）')
  assert.match(fork, FORK_NAME_RE)
  assert.equal(sessionTargetVerdict('storages/session_projcache/p/x.json.remote-fork-20261004120000-abcdef01').ok, true)
})
