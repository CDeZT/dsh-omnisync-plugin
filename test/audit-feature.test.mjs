// test/audit-feature.test.mjs — 附件内容寻址完整性 + fork 落本机（真 fs、真 sha256）。
//
// 被测逻辑全部真跑：真文件、真哈希、真目录遍历；只有"能力"是注入的
// （这正是两个模块的设计：I/O 走 ctx，逻辑可单测）。能力形态刻意对齐
// makeFsDeps：listLocal 返回 `{rel}`（walk 形态），listTree 返回字符串。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'

import {
  OBJECT_ROOT, objectRelOf, hashOfObjectRel, isObjectRel, verifyObjectData,
  extractRefs, refStatus, assertRefsPresent, knownObjects, checkReferences,
} from '../lib/attachments.mjs'
import { isForkRel, localForkRel, planForkLanding, landForks } from '../lib/forks.mjs'
import { FORK_NAME_RE } from '../lib/constants.mjs'
import { tmpHomeTree, readMaybe, caps, rejectsCode } from './helpers.mjs'

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5) // → 14 位戳 20260102030405
const STAMP = '20260102030405'
const DEV = 'a1b2c3d4' // deriveDeviceId 的真实形态：8 位 hex

const exists = (abs) => access(abs).then(() => true, () => false)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/* ────────────────────── ① 内容寻址：路径与哈希 ────────────────────── */

test('attachments: objectRelOf 由 hash 推出规范路径（目录=前 2 位）', () => {
  const h = sha256(Buffer.from('hello attachment'))
  assert.equal(objectRelOf(h), `${OBJECT_ROOT}/${h.slice(0, 2)}/${h}`)
  assert.equal(objectRelOf(h.toUpperCase()), objectRelOf(h)) // 大写 hex 归一化
})

test('attachments: 坏 hash 立即拒绝，绝不拿去拼路径', () => {
  for (const bad of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null, 42]) {
    assert.throws(() => objectRelOf(bad), (e) => e.code === 'BAD_INPUT', `应拒绝: ${String(bad)}`)
  }
})

test('attachments: hashOfObjectRel 只认「前缀 = hash 前 2 位」的路径', () => {
  const h = sha256(Buffer.from('x'))
  assert.equal(hashOfObjectRel(`${OBJECT_ROOT}/${h.slice(0, 2)}/${h}`), h)
  assert.equal(isObjectRel(`${OBJECT_ROOT}/${h.slice(0, 2)}/${h}`), true)
  // 前缀不符 = 损坏/碰撞 → 不算合法对象路径
  assert.equal(hashOfObjectRel(`${OBJECT_ROOT}/ff/${h}`), null)
  assert.equal(hashOfObjectRel(`attachments/v1/tmp/${h.slice(0, 2)}/${h}`), null) // tmp 不是 objects
  assert.equal(hashOfObjectRel(`attachments/v1/objects/${h}`), null) // 少一层目录
  assert.equal(isObjectRel('sessions/a/b.zstd'), false)
})

test('attachments: verifyObjectData 真算 sha256；篡改一字节即 SNAPSHOT_CORRUPT', () => {
  const data = Buffer.from('attachment payload 内容寻址')
  const rel = objectRelOf(sha256(data))
  assert.equal(verifyObjectData(rel, data), hashOfObjectRel(rel))
  assert.equal(verifyObjectData(rel, data.toString('utf8')), hashOfObjectRel(rel)) // 字符串形态同哈希
  const tampered = Buffer.from('attachment payload 内容寻址!')
  assert.throws(() => verifyObjectData(rel, tampered), (e) => {
    assert.equal(e.code, 'SNAPSHOT_CORRUPT')
    assert.equal(e.details.rel, rel)
    assert.equal(e.details.expected, hashOfObjectRel(rel))
    assert.equal(e.details.actual, sha256(tampered))
    return true
  })
  assert.throws(() => verifyObjectData('not/an/object', data), (e) => e.code === 'BAD_INPUT')
  assert.throws(() => verifyObjectData(rel, null), (e) => e.code === 'BAD_INPUT')
})

/* ────────────────────── ② 引用抽取与完整性 ────────────────────── */

test('attachments: extractRefs 收三种显式形态、去重排序、不收裸 hash', () => {
  const a = sha256(Buffer.from('a'))
  const b = sha256(Buffer.from('b'))
  const c = sha256(Buffer.from('c'))
  const text = [
    `{"content":[{"type":"file","path":"${OBJECT_ROOT}/${a.slice(0, 2)}/${a}"}]}`,
    `see attachment://${b} for details`,
    `{"attachmentId":"${c.toUpperCase()}","attachmentHash":"${a}"}`,
    // 裸 hash：可能是 doc_id / 校验和 → 绝不当作附件引用
    `{"doc_id":"${sha256(Buffer.from('doc')).toLowerCase()}"}`,
  ].join('\n')
  assert.deepEqual(extractRefs(text), [a, b, c].sort())
  assert.deepEqual(extractRefs(''), [])
  assert.deepEqual(extractRefs(null), [])
  assert.deepEqual(extractRefs(Buffer.from(`attachment://${b}`)), [b])
})

test('attachments: refStatus 是纯函数，且不信任传入路径的前缀', () => {
  const a = sha256(Buffer.from('a'))
  const b = sha256(Buffer.from('b'))
  const known = [objectRelOf(a), `${OBJECT_ROOT}/ff/${b}`] // b 的路径前缀是错的
  const r = refStatus([a, b], known)
  assert.deepEqual(r.present, [a])
  assert.deepEqual(r.missing, [b]) // 前缀不符 → 规范路径不在集合里 → 算缺失
  assert.deepEqual(refStatus([], known), { present: [], missing: [] })
})

test('attachments: assertRefsPresent 缺引用即硬失败，details 带全部缺失项', () => {
  const a = sha256(Buffer.from('a'))
  const b = sha256(Buffer.from('b'))
  assert.deepEqual(assertRefsPresent([a], [objectRelOf(a)]), { checked: 1 })
  assert.throws(() => assertRefsPresent([a, b], [objectRelOf(a)]), (e) => {
    assert.equal(e.code, 'SNAPSHOT_CORRUPT')
    assert.deepEqual(e.details.missing, [b])
    assert.equal(e.details.missingCount, 1)
    assert.equal(e.details.checked, 2)
    return true
  })
})

test('attachments: 真 fs 端到端 —— 本机∪远端齐全通过；远端对象消失则硬失败', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-feature-')
  const ctx = caps({ home, tree })
  const local = Buffer.from('本机对象')
  const remoteOnly = Buffer.from('只有远端有的对象')
  const localRel = objectRelOf(sha256(local))
  const remoteRel = objectRelOf(sha256(remoteOnly))
  await ctx.writeLocal(localRel, local)
  await ctx.writeTree(remoteRel, remoteOnly)

  const texts = [
    `{"attachmentId":"${sha256(local)}"}`,
    `{"path":"${remoteRel}"}`,
  ]
  // 正常路径：本机有 + 远端有 → 通过
  assert.deepEqual(await checkReferences({ ...ctx, texts }), { checked: 2 })

  // 远端对象消失（既不在本机也不在工作树）→ 必须硬失败，绝不静默跳过
  await rm(join(tree, remoteRel))
  await assert.rejects(() => checkReferences({ ...ctx, texts }), (e) => {
    assert.equal(e.code, 'SNAPSHOT_CORRUPT')
    assert.deepEqual(e.details.missing, [sha256(remoteOnly)])
    return true
  })

  // knownObjects 吃掉两种 list 形态，且只收合法对象路径
  await ctx.writeLocal('attachments/v1/tmp/junk', Buffer.from('tmp 不是对象'))
  assert.deepEqual([...(await knownObjects(ctx))].sort(), [localRel])
})

test('attachments: knownObjects 能力缺失 → BAD_INPUT（绝不静默当"没有对象"）', async () => {
  await rejectsCode(() => knownObjects({}), 'BAD_INPUT')
  await rejectsCode(() => knownObjects({ listLocal: async () => [] }), 'BAD_INPUT')
})

/* ────────────────────── ③ fork 命名与纯规划 ────────────────────── */

test('forks: 命名符合 FORK_NAME_RE，且戳/设备由注入值决定（确定性）', () => {
  const rel = 'sessions/--Users-me-proj--/session-abc/session.v4.jsonl.zstd'
  const fork = localForkRel(rel, DEV, NOW)
  assert.equal(fork, `${rel}.remote-fork-${STAMP}-${DEV}`)
  assert.match(fork, FORK_NAME_RE)
  assert.equal(isForkRel(fork), true)
  assert.equal(isForkRel(rel), false)
  // 设备名超 8 位 → 截断（与 keepboth.forkName 同口径，绝不另起一套命名）
  assert.equal(localForkRel(rel, `${DEV}eeee`, NOW), `${rel}.remote-fork-${STAMP}-${DEV}`)
  // index.mjs 的兜底 deviceId 'unknown' 只有 7 位 → 严格 RE 失配；但**绝不能被拒绝落地**，
  // 否则正是本模块要防的"远端版本在本机看不到"。
  const fallback = localForkRel(rel, 'unknown', NOW)
  assert.equal(FORK_NAME_RE.test(fallback), false)
  assert.equal(isForkRel(fallback), true)
  // 越界路径连命名都不允许
  assert.throws(() => localForkRel('../escape', DEV, NOW), (e) => e.code === 'PATH_UNSAFE')
  assert.throws(() => localForkRel('/abs/path', DEV, NOW), (e) => e.code === 'PATH_UNSAFE')
})

test('forks: planForkLanding 纯规划 —— 已存在则跳过、非 fork/越界一律拒绝', () => {
  const a = `sessions/x/session.v4.jsonl.zstd.remote-fork-${STAMP}-${DEV}`
  const b = `AGENTS.md.remote-fork-${STAMP}-${DEV}`
  const plan = planForkLanding(
    [a, b, 'sessions/x/session.v4.jsonl.zstd', '../escape.remote-fork-20260102030405-dev12345', '/abs.remote-fork-20260102030405-dev12345', a],
    [b],
  )
  assert.deepEqual(plan.land, [a])       // 去重后只剩 a
  assert.deepEqual(plan.skip, [b])       // b 本机已有 → 绝不覆盖
  assert.deepEqual(plan.reject.sort(), [
    '../escape.remote-fork-20260102030405-dev12345',
    '/abs.remote-fork-20260102030405-dev12345',
    'sessions/x/session.v4.jsonl.zstd',
  ].sort())
  assert.deepEqual(planForkLanding([], []), { land: [], skip: [], reject: [] })
})

/* ────────────────────── ④ fork 落本机（真 fs） ────────────────────── */

test('forks: landForks 真 fs —— fork 落到本机同目录，内容与工作树一致', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-feature-')
  const ctx = caps({ home, tree })
  const rel = `sessions/--Users-me-proj--/session-abc/session.v4.jsonl.zstd.remote-fork-${STAMP}-${DEV}`
  const payload = Buffer.from('远端会话版本（zstd 二进制占位）')
  await ctx.writeTree(rel, payload)

  const r = await landForks(ctx, [rel])
  assert.deepEqual(r, { landed: [rel], skipped: [], rejected: [], missing: [] })
  assert.deepEqual(await readFile(join(home, rel)), payload) // 真的落到本机
  assert.match(r.landed[0], FORK_NAME_RE)                    // 命名契约成立

  // 幂等：再跑一次不重写（全部 skipped）
  const again = await landForks(ctx, [rel])
  assert.deepEqual(again.landed, [])
  assert.deepEqual(again.skipped, [rel])
})

test('forks: 绝不覆盖本机已存在的文件（即使内容不同）', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-feature-')
  const ctx = caps({ home, tree })
  const rel = `AGENTS.md.remote-fork-${STAMP}-${DEV}`
  await ctx.writeTree(rel, Buffer.from('远端版本'))
  await ctx.writeLocal(rel, Buffer.from('本机已存在（用户可能改过）'))

  const r = await landForks(ctx, [rel])
  assert.deepEqual(r.landed, [])
  assert.deepEqual(r.skipped, [rel])
  assert.equal((await readFile(join(home, rel))).toString(), '本机已存在（用户可能改过）')
})

test('forks: 工作树读不到内容 → 报 missing（绝不假装成功）；非 fork 路径拒绝且不落盘', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-feature-')
  const ctx = caps({ home, tree })
  const gone = `sessions/x/session.v4.jsonl.zstd.remote-fork-${STAMP}-${DEV}`
  const plain = 'sessions/x/session.v4.jsonl.zstd'
  await ctx.writeTree(plain, Buffer.from('普通会话，不是 fork'))

  const r = await landForks(ctx, [gone, plain])
  assert.deepEqual(r.missing, [gone])
  assert.deepEqual(r.rejected, [plain])
  assert.deepEqual(r.landed, [])
  assert.equal(await exists(join(home, plain)), false) // 拒绝 = 一个字节都不写
})

test('forks: 越界路径被拒绝，本机目录外不产生任何文件', async (t) => {
  const { root, home, tree } = await tmpHomeTree(t, 'omnisync-feature-')
  const ctx = caps({ home, tree })
  const escape = `../escape.remote-fork-${STAMP}-${DEV}`
  const escapedAbs = join(root, `escape.remote-fork-${STAMP}-${DEV}`)

  const r = await landForks(ctx, [escape])
  assert.deepEqual(r.rejected, [escape])
  assert.deepEqual(r.landed, [])
  // 两个独立防线：assertSafeRel 拒绝 + 写入路径不含分隔符。目录外必须零字节。
  assert.equal(await exists(escapedAbs), false)
  assert.equal(await exists(join(home, '..', 'escape')), false)
})

test('forks: landForks 能力缺失 → BAD_INPUT', async () => {
  await rejectsCode(() => landForks({}, []), 'BAD_INPUT')
  await rejectsCode(() => landForks({ readTree: async () => null }, []), 'BAD_INPUT')
})

/* ── Lead 复核补测：路径逃逸全形态（含 UNC —— 交付时漏放行的那一档）── */

test('forks: 落本机路径必须挡住全部逃逸形态（UNC 是交付时漏的那档）', async () => {
  const { planForkLanding } = await import('../lib/forks.mjs')
  const fork = (p) => `${p}.remote-fork-20261004120000-5fc734cb`
  const escapes = [
    '/etc/passwd',            // posix 绝对
    'C:\\Windows\\x',          // 盘符
    '../../x',                // 上跳
    '\\\\server\\share\\x',     // UNC：不以 / 开头、非盘符 → 曾漏放行，Windows 上会写网络共享
    '//server/share/x',       // 双斜杠
    '\\/server/x',            // 混合双分隔符
    'a/../../x',              // 中段上跳
  ]
  for (const p of escapes) {
    const r = planForkLanding([fork(p)], [])
    assert.equal(r.land.length, 0, `${p} 必须被拒绝，实际被放行落地`)
    assert.equal(r.reject.length, 1, `${p} 应进 reject 组`)
  }
  // 正常相对路径必须仍能落地（别把闸门做过头）。
  const ok = planForkLanding([fork('sessions/p/s/x.jsonl'), fork('AGENTS.md')], [])
  assert.equal(ok.land.length, 2)
  assert.deepEqual(ok.reject, [])
})
