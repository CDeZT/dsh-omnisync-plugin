// lib/attachments.mjs — 附件内容寻址的完整性（零直接 I/O，能力经 ctx 注入）。
//
// blob 合并器只保证「同路径同内容」，而对象不可变（路径 = sha256(content)）。真实风险不是
// 「两边改了同一对象」而是**引用悬空**：会话/消息引用了某 hash，对象却既不在本机也不在远端。
// 静默跳过 = 附件永久丢失且无人知晓 → 必须硬失败（SNAPSHOT_CORRUPT，引擎据此长退避）。
//
// 实地取证（2026-10，本机真实语料）：**唯一真实引用形态是 `"attachmentId":"sha256:<64hex>"`
// 的 JSON 键**（生产者源码 `sha256:${String(ref.attachmentId)}`）。上一轮推断的
// `attachment://<hex>` 与「裸 hash」形态在真实语料里 0 命中；「对象路径」形态 281 处**全是
// 散文**（审计报告/README/find 输出）。非会话状态文件（257 个）零附件引用 → 引用只在会话里。

import { createHash } from 'node:crypto'
import { badInput, SyncError, ERROR_CODES } from './errors.mjs'
import { decompressZstdText, isZstd } from './zstd.mjs'

/** 分区根（必须与 sections.mjs 的 attachments 条目一致）。 */
export const OBJECT_ROOT = 'attachments/v1/objects'

/** 对象文件名 = 完整 sha256（64 位 hex）；目录 = 前 2 位。 */
const HASH_RE = /^[0-9a-f]{64}$/u
const OBJECT_REL_RE = /^attachments\/v1\/objects\/([0-9a-f]{2})\/([0-9a-f]{64})$/iu

/** 引用形态（宽版并集，**实测校准**）：对象路径与 `attachment://` 保留只为兼容（实测全是
 *  散文），JSON 键的裸 hash 或 `sha256:<hash>` 两种都收。**不收裸 hash**：会话里 64 位 hex
 *  也可能是 doc_id/校验和，误判会拿假警报卡死同步。 */
const REF_PATTERNS = Object.freeze([
  /attachments\/v1\/objects\/[0-9a-f]{2}\/([0-9a-f]{64})/giu,
  /attachment:\/\/(?:sha256:)?([0-9a-f]{64})/giu,
  /"(?:attachment|attachmentId|attachmentHash|objectHash)"\s*:\s*"(?:sha256:)?([0-9a-f]{64})"/giu,
])

/** 只认实测存在的生产者形态。 */
const STRICT_REF_PATTERNS = Object.freeze([
  /"(?:attachment|attachmentId|attachmentHash|objectHash)"\s*:\s*"sha256:([0-9a-f]{64})"/giu,
])

/** 对象路径 → hash；前缀与 hash 前 2 位不符（损坏/碰撞）返回 null。 */
export function hashOfObjectRel(rel) {
  const m = OBJECT_REL_RE.exec(String(rel ?? ''))
  if (m === null) return null
  const hash = m[2].toLowerCase()
  return m[1].toLowerCase() === hash.slice(0, 2) ? hash : null
}

export function isObjectRel(rel) {
  return hashOfObjectRel(rel) !== null
}

/** hash → 规范对象路径；hash 非法立即拒绝（绝不用坏 hash 拼路径）。 */
export function objectRelOf(hash) {
  const h = typeof hash === 'string' ? hash.toLowerCase() : ''
  if (!HASH_RE.test(h)) throw badInput(`attachment hash must be 64 hex chars, got: ${String(hash)}`)
  return `${OBJECT_ROOT}/${h.slice(0, 2)}/${h}`
}

/** 校验对象字节与路径哈希一致 —— 不可变对象的唯一保障。
 *  @throws {SyncError} SNAPSHOT_CORRUPT：内容 ≠ 路径 = 损坏或碰撞，绝不扩散。 */
export function verifyObjectData(rel, data) {
  const hash = hashOfObjectRel(rel)
  if (hash === null) throw badInput(`not a content-addressed object path: ${rel}`)
  if (data === null || data === undefined) throw badInput(`object ${rel} has no data`)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== hash) {
    throw new SyncError(ERROR_CODES.SNAPSHOT_CORRUPT,
      `attachment object ${rel} does not match its path hash (expected ${hash}, got ${actual})`,
      { rel, expected: hash, actual })
  }
  return hash
}

/** 从**已解压**文本抽取被引用的 hash（去重 + 排序 → 确定性）。 */
export function extractRefs(text) {
  return matchRefs(text, REF_PATTERNS)
}

/** 只认实测存在形态（`attachmentId:"sha256:<hash>"`）。
 *
 *  为什么要有窄版：宽版里的「对象路径」与 `attachment://` 实测全是散文（281 处、无一为
 *  机器引用），而缺引用是**硬失败** → 散文误报 = 同步永久卡死。硬失败路径用本函数，
 *  宽版留给"宁可多报"的诊断场景。 */
export function extractRefsStrict(text) {
  return matchRefs(text, STRICT_REF_PATTERNS)
}

/** 共用的抽取内核（去重 + 排序）。 */
function matchRefs(text, patterns) {
  const s = typeof text === 'string' ? text : Buffer.isBuffer(text) ? text.toString('utf8') : ''
  const found = new Set()
  for (const re of patterns) for (const m of s.matchAll(re)) found.add(m[1].toLowerCase())
  return [...found].sort()
}

/** 引用 → 已在已知集合 / 缺失（用 hash 反推规范路径，不信任传入路径的前缀）。 */
export function refStatus(refs, knownRels) {
  const known = knownRels instanceof Set ? knownRels : new Set(knownRels)
  const present = []
  const missing = []
  for (const hash of new Set(refs)) {
    if (known.has(objectRelOf(hash))) present.push(hash)
    else missing.push(hash)
  }
  return { present: present.sort(), missing: missing.sort() }
}

/** 引用完整性断言：缺任何一个对象 → 硬失败（绝不静默跳过）。
 *  @throws {SyncError} SNAPSHOT_CORRUPT。 */
export function assertRefsPresent(refs, knownRels) {
  const { present, missing } = refStatus(refs, knownRels)
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).map((h) => objectRelOf(h))
    throw new SyncError(ERROR_CODES.SNAPSHOT_CORRUPT,
      `${missing.length} attachment object(s) referenced but missing locally and remotely: ${sample.join(', ')}`,
      { missing, missingCount: missing.length, checked: present.length + missing.length })
  }
  return { checked: present.length }
}

/** 「本机 ∪ 工作树」已有的对象路径（listLocal/listTree 返回 `{rel}` 或字符串，两种都吃）。 */
export async function knownObjects(ctx) {
  if (typeof ctx?.listLocal !== 'function' || typeof ctx?.listTree !== 'function') {
    throw badInput('knownObjects needs ctx.listLocal and ctx.listTree')
  }
  const known = new Set()
  for (const list of [ctx.listLocal, ctx.listTree]) {
    for (const item of await list(OBJECT_ROOT)) {
      const rel = typeof item === 'string' ? item : item?.rel
      if (typeof rel === 'string' && isObjectRel(rel)) known.add(rel)
    }
  }
  return known
}

/** 压缩块 → 文本：`.zstd` 或 zstd 魔数则解压，否则按 UTF-8。
 *  会话文件就是**多帧** `.jsonl.zstd`；把压缩字节当文本喂进来，引用永远抽不到 → 检查形同虚设。 */
function blobText(blob) {
  const rel = typeof blob?.rel === 'string' ? blob.rel : ''
  const data = blob?.data
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data
  if (rel.endsWith('.zstd') || isZstd(data)) return decompressZstdText(data)
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
}

/** 端到端引用检查：抽取 → 已知集合 → 缺则硬失败。
 *  @param {object} ctx { listLocal, listTree, texts?, blobs?, strict? } —— texts 为已解压文本，
 *    blobs 为 `{rel, data}`（`.zstd` 自动解压，含多帧）。 */
export async function checkReferences(ctx) {
  const pick = ctx?.strict === true ? extractRefsStrict : extractRefs
  const refs = []
  for (const t of ctx?.texts ?? []) refs.push(...pick(t))
  for (const b of ctx?.blobs ?? []) refs.push(...pick(blobText(b)))
  return assertRefsPresent(refs, await knownObjects(ctx))
}

/** 写入一个内容寻址对象 —— **唯一的写入口**，先校验后落盘。
 *
 *  校验必须在写之前：对象不可变，一旦按坏内容写进去，污染的是"云端唯一副本"（本机删掉、
 *  远端又被覆盖就永久损坏且无人知晓）。三条刻意的性质：
 *    ① **绝不半写**：所有落点先全部体检，确认干净后才开始写；
 *    ② **幂等**：目标已是同内容 → 跳过（重写会触发 DSH 的 chokidar 热重载）；
 *    ③ **已存在但内容不同 → 硬失败**：路径即内容哈希，只可能是磁盘损坏或哈希碰撞，
 *       静默覆盖会把"碰撞"这一安全事件掩盖掉。
 *  @param {object} ctx - { writeLocal?, readLocal?, writeTree?, readTree? }（至少一个写能力）。
 *  @throws {SyncError} BAD_INPUT（路径非法/无写能力）、SNAPSHOT_CORRUPT（内容不符或冲突）。 */
export async function putObject(ctx, rel, data) {
  const hash = verifyObjectData(rel, data) // 先校验：失败则一个字节都不写
  const sinks = [
    { write: ctx?.writeLocal, read: ctx?.readLocal },
    { write: ctx?.writeTree, read: ctx?.readTree },
  ].filter((s) => typeof s.write === 'function')
  if (sinks.length === 0) throw badInput('putObject needs ctx.writeLocal or ctx.writeTree')

  // 阶段一：全部落点体检（只读）。冲突在这里就炸，保证阶段二不会半途中断。
  const todo = []
  for (const sink of sinks) {
    let current = null
    if (typeof sink.read === 'function') {
      current = await sink.read(rel)
      if (current !== null) {
        if (current.equals(data)) continue // 幂等：已是同内容
        throw new SyncError(ERROR_CODES.SNAPSHOT_CORRUPT,
          `object ${rel} already exists with different bytes (corruption or hash collision)`,
          { rel, expected: hash, actual: createHash('sha256').update(current).digest('hex') })
      }
    }
    todo.push(sink)
  }
  // 阶段二：写入（此处不再有可预期的失败）。
  let written = 0
  for (const sink of todo) if (await sink.write(rel, data)) written += 1
  return { hash, written }
}
