// test/audit-attach.test.mjs — 附件引用完整性：zstd 多帧、真实引用形态、写入校验。
//
// 全部真跑：真 zstd 压缩帧、真 sha256、真文件系统。I/O 经 ctx 注入（模块零直接 I/O）。
//
// 断言都来自**实地取证**（取证记录见 lib/attachments.mjs 与 lib/zstd.mjs 头部注释），
// 不是按约定推断的形态：
//   ① 会话是**多帧拼接** zstd（实测 72 文件 / 15441 帧）—— Node 的 zstdDecompressSync
//      只解第一帧且**不报错**：34.4MB 只拿到 0.02MB（漏检 99.988%）。
//   ② 真实引用形态是 `"attachmentId":"sha256:<64hex>"`（DSH 文档：相同字节去重为一个
//      对象和**一个 `sha256:` 标识符**；生产者源码 `sha256:${String(ref.attachmentId)}`）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  OBJECT_ROOT, objectRelOf, extractRefs, extractRefsStrict, checkReferences, putObject,
} from '../lib/attachments.mjs'
import { decompressZstd, decompressZstdText, frameRanges, isZstd } from '../lib/zstd.mjs'
import { tmpHomeTree, readMaybe, caps, rejectsCode } from './helpers.mjs'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/* ══════════════ 第 1 轮：多帧 zstd（会话真实形态） ══════════════ */

test('zstd: 多帧拼接必须整体解压（单帧 API 只给第一帧 = 静默漏检）', () => {
  const f1 = zstdCompressSync(Buffer.from('{"type":"session"}\n'))
  const f2 = zstdCompressSync(Buffer.from('{"type":"tool/result"}\n'))
  const f3 = zstdCompressSync(Buffer.from('{"type":"agent/inbox/spliced"}\n'))
  const multi = Buffer.concat([f1, f2, f3])

  // 先证明"bug 真实存在"：Node 自带的单帧 API 只返回第一帧，且**不抛错**。
  assert.equal(zstdDecompressSync(multi).toString(), '{"type":"session"}\n')

  assert.equal(decompressZstdText(multi), '{"type":"session"}\n{"type":"tool/result"}\n{"type":"agent/inbox/spliced"}\n')
  assert.equal(frameRanges(multi).length, 3)
})

test('zstd: 可跳过帧（skippable）不得让整份内容变空', () => {
  const skip = Buffer.concat([
    Buffer.from([0x50, 0x2a, 0x4d, 0x18]), Buffer.from([4, 0, 0, 0]), Buffer.from('ABCD'),
  ])
  const f1 = zstdCompressSync(Buffer.from('hello'))
  // 单帧 API 遇到前导 skippable 帧直接返回空 —— "整份会话读不出来"的极端形态。
  assert.equal(zstdDecompressSync(Buffer.concat([skip, f1])).toString(), '')
  assert.equal(decompressZstdText(Buffer.concat([skip, f1])), 'hello')
})

test('zstd: 单帧、空输入、非 zstd 输入的边界', () => {
  assert.equal(decompressZstdText(zstdCompressSync(Buffer.from('单帧'))), '单帧')
  assert.equal(decompressZstd(Buffer.alloc(0)).length, 0)
  assert.equal(decompressZstd(null).length, 0)
  assert.equal(decompressZstdText('not zstd at all'), 'not zstd at all') // 未压缩原样返回，不炸
  assert.equal(isZstd(zstdCompressSync(Buffer.from('x'))), true)
  assert.equal(isZstd(Buffer.from('plain')), false)
})

test('zstd: 截断的尾帧不得吞掉前面已完整的帧', () => {
  const f1 = zstdCompressSync(Buffer.from('完整第一帧'))
  const f2 = zstdCompressSync(Buffer.from('会被截断的第二帧'))
  const truncated = Buffer.concat([f1, f2.subarray(0, Math.floor(f2.length / 2))])
  // 会话是追加型，断电留下半帧是真实场景：已完整的帧必须照常可读。
  assert.equal(decompressZstdText(truncated), '完整第一帧')
})

test('zstd: 真实会话形状 —— 多帧 JSONL 每一行都可见（引用不被漏掉）', () => {
  const hash = sha256(Buffer.from('附件字节'))
  const lines = [
    '{"type":"session","version":4,"id":"ef6efbf2"}',
    '{"type":"tool/result","content":[{"type":"text","text":"ok"}]}',
    `see attachment://${hash} for details`, // 用旧形态：本测试只验证 zstd 可见性
  ]
  // 每个 append 一帧 —— 复刻 DSH 的追加式写入。
  const multi = Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(l + '\n'))))

  const text = decompressZstdText(multi)
  assert.equal(text.split('\n').filter(Boolean).length, 3)
  assert.deepEqual(extractRefs(text), [hash]) // 引用必须可见
})

test('zstd: checkReferences 能吃 .jsonl.zstd 压缩块（zstd 感知，无需调用方先解压）', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const data = Buffer.from('远端对象字节')
  const hash = sha256(data)
  await mkdir(join(tree, `${OBJECT_ROOT}/${hash.slice(0, 2)}`), { recursive: true })
  await writeFile(join(tree, objectRelOf(hash)), data)

  // 引用落在**第二帧**：只解第一帧的实现必然漏掉它（这正是实测的漏检形态）。
  const session = Buffer.concat([
    zstdCompressSync(Buffer.from('{"type":"session"}\n')),
    zstdCompressSync(Buffer.from(`see attachment://${hash} for details\n`)),
  ])
  assert.deepEqual(
    await checkReferences({ ...ctx, blobs: [{ rel: 'sessions/x/session.v4.jsonl.zstd', data: session }] }),
    { checked: 1 })
})

/* ══════════════ 第 2 轮：实测真实引用形态（sha256: 标识符） ══════════════ */

// 下面几行是从真实会话里**逐字抄下来**的取证样本（不是按约定编的）：
//   GROUND_TRUTH_LINE —— session-705931f6…/session.v4.jsonl.zstd 里实测**唯一**一条真实
//     附件引用（该 object 就在本机，sha256 与路径一致）。
//   PROSE_PATH —— 审计报告/README 提到对象**路径**的散文（实测 281 处，无一为机器引用）。
//   PROSE_SCHEME —— `attachment://` 出现在任务描述里被会话回显（实测 81 处，全是自指噪声）。
const GROUND_TRUTH_LINE = '{"type":"image","attachment":{"attachmentId":"sha256:a1ef11fa9a2ea34372f8e1066936fd9caf176c08312563280a924ca74e2c9628","mediaType":"image/jpeg","bytes":299316,"width":1280,"height":1080,"name":"字幕效果验证.jpg"}}'
const GROUND_TRUTH_HASH = 'a1ef11fa9a2ea34372f8e1066936fd9caf176c08312563280a924ca74e2c9628'
const PROSE_PATH = '| `attachments/v1/objects/` | 内容寻址附件 blob（会话图片等） | 可选：随会话同步则必须带上 |'
const PROSE_SCHEME = '三种形态（对象路径 / `attachment://` / JSON `attachment*` 键）是按合理约定写的'

test('extractRefs: 实测真实形态 attachmentId:"sha256:<hash>" 必须命中（此前完全漏检）', () => {
  // 修复前 extractRefs 对这种形态返回 [] —— 形态推断错了 = 整个检查形同虚设。
  assert.deepEqual(extractRefs(GROUND_TRUTH_LINE), [GROUND_TRUTH_HASH])
})

test('extractRefs: sha256: 标识符大小写归一化，多个引用去重排序', () => {
  const a = sha256(Buffer.from('a'))
  const b = sha256(Buffer.from('b'))
  const text = [
    `{"attachmentId":"sha256:${a.toUpperCase()}"}`,
    `{"attachment":{"attachmentId":"sha256:${b}"}}`,
    `{"attachmentId":"sha256:${a}"}`, // 重复
  ].join('\n')
  assert.deepEqual(extractRefs(text), [a, b].sort())
})

test('extractRefsStrict: 只认生产者形态 —— 散文里的对象路径不算引用（防硬失败 DoS）', () => {
  // 缺引用是硬失败（长退避 = 同步卡死）。散文误报 → 永久卡死，故硬失败路径用窄版。
  assert.deepEqual(extractRefsStrict(PROSE_PATH), [])
  assert.deepEqual(extractRefsStrict(PROSE_SCHEME), [])
  assert.deepEqual(extractRefsStrict(`{"doc_id":"${sha256(Buffer.from('doc'))}"}`), [])
  assert.deepEqual(extractRefsStrict(GROUND_TRUTH_LINE), [GROUND_TRUTH_HASH]) // 真实形态照样命中
})

test('extractRefs: 宽版仍兼容三种旧形态（不破坏既有行为）', () => {
  const a = sha256(Buffer.from('a'))
  const b = sha256(Buffer.from('b'))
  const c = sha256(Buffer.from('c'))
  const text = [
    `{"content":[{"type":"file","path":"${OBJECT_ROOT}/${a.slice(0, 2)}/${a}"}]}`,
    `see attachment://${b} for details`,
    `{"attachmentId":"${c.toUpperCase()}"}`,
    `{"doc_id":"${sha256(Buffer.from('doc')).toLowerCase()}"}`, // 裸 hash 不算
  ].join('\n')
  assert.deepEqual(extractRefs(text), [a, b, c].sort())
  assert.deepEqual(extractRefs(''), [])
  assert.deepEqual(extractRefs(null), [])
})

test('端到端：真实形态落在 .zstd 第二帧 → 引用可见且对象在册（checked=1）', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const data = Buffer.from('字幕效果验证.jpg 的字节')
  const hash = sha256(data)
  await mkdir(join(tree, `${OBJECT_ROOT}/${hash.slice(0, 2)}`), { recursive: true })
  await writeFile(join(tree, objectRelOf(hash)), data)

  const session = Buffer.concat([
    zstdCompressSync(Buffer.from('{"type":"session","version":4}\n')),
    zstdCompressSync(Buffer.from(`{"type":"image","attachment":{"attachmentId":"sha256:${hash}","bytes":${data.length}}}\n`)),
  ])
  assert.deepEqual(
    await checkReferences({ ...ctx, strict: true, blobs: [{ rel: 'sessions/x/session.v4.jsonl.zstd', data: session }] }),
    { checked: 1 })

  // 对象在两边都消失 → 硬失败（附件绝不能静默丢）。
  await rm(join(tree, objectRelOf(hash)))
  await assert.rejects(
    () => checkReferences({ ...ctx, strict: true, blobs: [{ rel: 'sessions/x/session.v4.jsonl.zstd', data: session }] }),
    (e) => e.code === 'SNAPSHOT_CORRUPT' && e.details.missingCount === 1)
})

/* ══════════════ 第 3 轮：写入路径必须过校验（verifyObjectData 接线） ══════════════ */

test('putObject: 内容与路径不符 → SNAPSHOT_CORRUPT，且一个字节都不写', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const good = Buffer.from('真身字节')
  const rel = objectRelOf(sha256(good))
  const tampered = Buffer.from('被篡改的字节')

  await assert.rejects(() => putObject(ctx, rel, tampered),
    (e) => e.code === 'SNAPSHOT_CORRUPT' && e.details.expected === sha256(good))
  // 绝不半写：本机与工作树都必须干净（写坏了 = 污染云端唯一副本）。
  assert.equal(await readMaybe(join(home, rel)), null)
  assert.equal(await readMaybe(join(tree, rel)), null)
})

test('putObject: 校验通过才写，本机与工作树都落，返回 hash', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const data = Buffer.from('正常对象字节')
  const hash = sha256(data)
  const rel = objectRelOf(hash)

  assert.deepEqual(await putObject(ctx, rel, data), { hash, written: 2 })
  assert.deepEqual(await readMaybe(join(home, rel)), data)
  assert.deepEqual(await readMaybe(join(tree, rel)), data)
})

test('putObject: 幂等 —— 已存在同内容不重写（避免 chokidar 热重载回声）', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const data = Buffer.from('幂等对象')
  const rel = objectRelOf(sha256(data))

  assert.equal((await putObject(ctx, rel, data)).written, 2)
  assert.equal((await putObject(ctx, rel, data)).written, 0) // 第二次一个都不写
})

test('putObject: 目标已存在但内容不同 → 硬失败（碰撞/损坏，绝不覆盖掩盖）', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const data = Buffer.from('新字节')
  const rel = objectRelOf(sha256(data))
  // 预先塞进一个与路径哈希不符的对象（模拟磁盘损坏 / 哈希碰撞）。
  await mkdir(join(home, `${OBJECT_ROOT}/${rel.split('/')[3]}`), { recursive: true })
  await writeFile(join(home, rel), Buffer.from('坏掉的旧内容'))

  await rejectsCode(() => putObject(ctx, rel, data), 'SNAPSHOT_CORRUPT')
  // 坏对象保持原样：静默覆盖会把"碰撞"这一安全事件掩盖掉。
  assert.deepEqual(await readMaybe(join(home, rel)), Buffer.from('坏掉的旧内容'))
})

test('putObject: 非法路径 / 缺写入能力 → BAD_INPUT', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  await rejectsCode(() => putObject(ctx, 'not/an/object', Buffer.from('x')), 'BAD_INPUT')
  await assert.rejects(() => putObject({}, objectRelOf(sha256(Buffer.from('x'))), Buffer.from('x')),
    (e) => e.code === 'BAD_INPUT')
})

test('putObject: 任一落点冲突时绝不半写（第二个落点坏 → 第一个也不能被写）', async (t) => {
  const { home, tree } = await tmpHomeTree(t, 'omnisync-attach-')
  const ctx = caps({ home, tree })
  const data = Buffer.from('要写的字节')
  const rel = objectRelOf(sha256(data))
  // 只有**工作树**里预先存在坏对象；本机是干净的。
  await mkdir(join(tree, `${OBJECT_ROOT}/${rel.split('/')[3]}`), { recursive: true })
  await writeFile(join(tree, rel), Buffer.from('工作树里的坏内容'))

  await rejectsCode(() => putObject(ctx, rel, data), 'SNAPSHOT_CORRUPT')
  // 冲突必须在**任何写入之前**就查出来：本机不得被写（否则就是"半应用"）。
  assert.equal(await readMaybe(join(home, rel)), null)
})
