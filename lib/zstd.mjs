// lib/zstd.mjs — 多帧 zstd 解压（零依赖，只用 node:zlib 的单帧原语）。
//
// 为什么需要：DSH 会话是**追加式**写入，每次 append 产生一个独立 zstd 帧，所以
// `session.v4.jsonl.zstd` 实际是多帧拼接（实测 72 个文件 15112 帧，单文件最多 3073 帧）。
// 而 Node 的 `zstdDecompressSync` / `createZstdDecompress` **只解第一帧就停下且不报错**
// （实测确认）：33.7MB 语料只解出 20KB，每个文件仅剩开头那行 —— 于是任何"扫会话找引用"
// 的检查都会静默漏检。所以这里自己按帧格式逐帧定位边界，再交给单帧原语解、拼接。
// 帧解析失败（尾帧写了一半 / 非 zstd 字节）只丢那一帧，绝不牵连已完整的帧。

import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528 // zstd 帧魔数（小端读作 uint32）
const SKIP_LO = 0x184d2a50 // 可跳过帧 0x184D2A50..0x184D2A5F（预留/元数据）
const SKIP_HI = 0x184d2a5f

/** 是否为 zstd 帧字节（含可跳过帧）。 */
export function isZstd(buf) {
  const b = asBuffer(buf)
  if (b === null || b.length < 4) return false
  const m = b.readUInt32LE(0)
  return m === MAGIC || (m >= SKIP_LO && m <= SKIP_HI)
}

/**
 * 定位所有帧的 [start, end) 区间。
 *
 * 逐块推进而不是"找下一个魔数"：压缩块内部完全可能恰好出现魔数字节，按魔数切会把一个帧
 * 劈成两半。块头自带长度，走完 `last_block` 才是帧尾。
 * @returns {Array<[number, number]>} 帧区间（含可跳过帧；调用方自行过滤）。
 */
export function frameRanges(input) {
  const buf = asBuffer(input)
  const out = []
  if (buf === null) return out
  let i = 0
  while (i + 4 <= buf.length) {
    const m = buf.readUInt32LE(i)
    if (m >= SKIP_LO && m <= SKIP_HI) {
      if (i + 8 > buf.length) break
      const size = buf.readUInt32LE(i + 4)
      out.push([i, i + 8 + size])
      i += 8 + size
      continue
    }
    if (m !== MAGIC) { i += 1; continue } // 同步到下一个魔数
    const end = frameEnd(buf, i)
    if (end < 0) { i += 4; continue } // 坏帧：跳过魔数重同步
    out.push([i, end])
    i = end
  }
  return out
}

/** 走完一个帧，返回帧尾偏移；解析不下去返回 -1。
 *  帧布局：魔数(4) + Frame_Header_Descriptor(1) + [Window_Descriptor] + [Dictionary_ID] +
 *  [Frame_Content_Size] + 若干块 + [Content_Checksum]。 */
function frameEnd(buf, start) {
  let p = start + 4
  if (p >= buf.length) return -1
  const fhd = buf[p]; p += 1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const didFlag = fhd & 3
  if (!singleSegment) p += 1 // Window_Descriptor
  p += didFlag === 0 ? 0 : didFlag === 1 ? 1 : didFlag === 2 ? 2 : 4
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8

  let last = 0
  while (!last) {
    if (p + 3 > buf.length) return -1
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16); p += 3
    last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >> 3
    if (type === 3) return -1 // 保留块类型 = 流损坏
    p += type === 1 ? 1 : size // RLE 块体只有 1 字节，Raw/Compressed 是 size
    if (p > buf.length) return -1
  }
  if (checksum) p += 4
  return p > buf.length ? -1 : p
}

/** 多帧解压（拼接所有帧）。没有帧魔数 → 视为**未压缩**原样返回（调用方无需先判断）；
 *  有魔数但一帧都没解出来 → 返回空，绝不把压缩字节冒充文本。 */
export function decompressZstd(input) {
  const buf = asBuffer(input)
  if (buf === null || buf.length === 0) return Buffer.alloc(0)
  const ranges = frameRanges(buf)
  if (ranges.length === 0) return buf // 未压缩，原样
  const parts = []
  for (const [s, e] of ranges) {
    const slice = buf.subarray(s, e)
    if (slice.readUInt32LE(0) !== MAGIC) continue // 可跳过帧：无载荷
    try { parts.push(zstdDecompressSync(slice)) } catch { /* 坏帧/半帧：只丢这一帧 */ }
  }
  return Buffer.concat(parts)
}

/** 多帧解压为 UTF-8 文本（未压缩输入原样返回）。 */
export function decompressZstdText(input) {
  return decompressZstd(input).toString('utf8')
}

/** 统一转 Buffer；字符串按 UTF-8。null/undefined → null。 */
function asBuffer(input) {
  if (input === null || input === undefined) return null
  if (Buffer.isBuffer(input)) return input
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return null
}
