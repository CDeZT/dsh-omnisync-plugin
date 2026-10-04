// lib/crypto.mjs — 密文载荷引擎：scrypt 口令派生 + AES-256-GCM 认证加密。
//
// 纯函数层：只用 node:crypto，不碰 env/时钟/文件。**绝不部分落盘** —— 全程内存操作，
// 解密失败在 d.final() 处 throw，调用方永远拿不到半截 Buffer，收到 throw 就必须放弃写盘。
// bag 共享一次 kdf 派生：scrypt(N=32768) 单次约百毫秒，n 条目从 O(n·kdf) 降到 O(1·kdf + n·aes)；
// GCM 的安全前提"同 key 不重用 iv"由每条目独立随机 iv 保证。
// 错误面：解密侧唯一出口是 decryptFailed（code=DECRYPT_FAILED），口令错/tag 不匹配/信封损坏
// 统一收敛，不泄露可区分的失败方向。

import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync,
} from 'node:crypto'
import { decryptFailed, badInput } from './errors.mjs'

/* KDF 参数（调参只改这里）：N=32768≈64MB 内存、百毫秒级，抗 GPU 爆破；maxmem 仅为容纳该 N。
 * salt 16B、GCM IV 12B（NIST 推荐）、keylen=32 匹配 AES-256。 */
export const KDF = Object.freeze({
  NAME: 'scrypt',
  N: 32768,
  R: 8,
  P: 1,
  KEYLEN: 32,
  SALT_BYTES: 16,
  IV_BYTES: 12,
  MAXMEM: 256 * 1024 * 1024,
})

const ALG = 'aes-256-gcm'
const V1 = 1

/** 信封头（v/alg/kdf）：单条与 bag 共用同一形状，bag 多一层 items。 */
function envelopeHead(salt, extra) {
  return {
    v: V1, alg: ALG, ...(extra ?? {}),
    kdf: { name: KDF.NAME, N: KDF.N, r: KDF.R, p: KDF.P, keylen: KDF.KEYLEN, salt: salt.toString('base64') },
  }
}

/** 口令 + 盐 → 32B 主密钥（唯一派生面）。 */
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KDF.KEYLEN, { N: KDF.N, r: KDF.R, p: KDF.P, maxmem: KDF.MAXMEM })
}

/** 按**信封里的** kdf 参数派生：必须信信封，否则升级参数后旧密文解不开。 */
function deriveFromEnvelope(kdf, passphrase) {
  if (kdf == null || kdf.name !== KDF.NAME || !Number.isInteger(kdf.keylen) || typeof kdf.salt !== 'string') {
    throw decryptFailed('bad kdf block (name/keylen/salt)')
  }
  try {
    return scryptSync(passphrase, Buffer.from(kdf.salt, 'base64'), kdf.keylen, {
      N: kdf.N, r: kdf.r, p: kdf.p, maxmem: KDF.MAXMEM,
    })
  } catch {
    throw decryptFailed('bad kdf params or salt encoding')
  }
}

/** AES-256-GCM 加密（不生成 salt，供 bag 共享派生复用）。 */
function seal(buf, key) {
  const iv = randomBytes(KDF.IV_BYTES)
  const c = createCipheriv(ALG, key, iv)
  const data = Buffer.concat([c.update(buf), c.final()])
  const tag = c.getAuthTag() // 认证标签必须在 final() 之后读，顺序不可颠倒
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') }
}

/** seal 的镜像：要么完整明文、要么异常，无中间产物。 */
function open(sealed, key) {
  const d = createDecipheriv(ALG, key, Buffer.from(sealed.iv, 'base64'))
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()])
}

/** 口令形态与信封版本/算法头校验（单条与 bag 共用）。 */
function assertEnvelope(env, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw decryptFailed('missing or empty passphrase')
  if (env == null || typeof env !== 'object') throw decryptFailed('envelope missing or not an object')
  if (env.v !== V1 || env.alg !== ALG) throw decryptFailed(`unsupported envelope v=${env.v} alg=${env.alg}`)
}

/** 项级解密：口令错 / tag 不匹配 / base64 非法收敛到同一个错误，不泄露失败方向。 */
function openItem(item, key, what) {
  if (typeof item?.iv !== 'string' || typeof item?.tag !== 'string' || typeof item?.data !== 'string') {
    throw decryptFailed(`${what} missing iv/tag/data`)
  }
  try {
    return open(item, key)
  } catch {
    throw decryptFailed('bad passphrase or auth tag mismatch')
  }
}

/**
 * 加密一组条目 → bag（共享一次 kdf 派生，条目各自随机 iv）。
 * @param {Array<{plain: Buffer}>} items - plain 为明文 Buffer，其余键原样透传。
 * @param {string} passphrase
 */
export function encryptBag(items, passphrase) {
  if (!Array.isArray(items)) throw badInput('encryptBag expects an array of items')
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw badInput('passphrase must be a non-empty string')
  const salt = randomBytes(KDF.SALT_BYTES)
  const key = deriveKey(passphrase, salt)
  const sealedItems = items.map((item) => {
    if (item == null || !Buffer.isBuffer(item.plain)) throw badInput('every bag item needs a Buffer at .plain')
    const { plain, ...rest } = item
    return { ...rest, ...seal(plain, key) }
  })
  return envelopeHead(salt, { items: sealedItems })
}

/**
 * 解密 bag → items（每项明文挂回 .plain，其余键透传）。任一条目失败即整体 throw，
 * 不存在"一半解开一半坏"的中间产物。
 * @param {object} bag - encryptBag 的输出。
 * @param {string} passphrase
 */
export function decryptBag(bag, passphrase) {
  assertEnvelope(bag, passphrase)
  if (!Array.isArray(bag.items)) throw decryptFailed('bag.items missing or not an array')
  const key = deriveFromEnvelope(bag.kdf, passphrase)
  return bag.items.map((item, index) => ({ ...item, plain: openItem(item, key, `item #${index}`) }))
}
