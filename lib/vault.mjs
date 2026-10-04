// lib/vault.mjs — 密文载荷：在「本机 ⇄ 工作树」的边界上做加解密。
//
// 密文条目进 `secrets.enc.json`，明文条目原样进工作树；藏在明文里的秘密（MCP 内嵌 key）
// 用占位符就地替换。铁律：**组关闭 ≠ 明文上传** —— 关闭的组根本不进工作树（只留本机）。

import { encryptBag, decryptBag } from './crypto.mjs'
import { extractSecrets, restoreSecrets } from './secrets.mjs'
import { decryptFailed } from './errors.mjs'

export const VAULT_FILE = 'secrets.enc.json'

/** 秘密藏在明文字段里、需要就地挖出的文本类分区。 */
const TEXT_SECTIONS = new Set(['home-patch', 'profile-patch'])

/** 封包：秘密收进密文袋，返回可写进工作树的明文部分。
 *  `secretGroup` 是**三态**，判错就是安全事故（关掉加密 ≠ 明文上传）：`undefined` = 无密级
 *  （如 AGENTS.md）→ 明文可同步；`null` = 声明了密级但用户关掉了该组 → **整份跳过，只留本机**；
 *  `'<group>'` = 该组开着 → 占位符进明文、原值进袋。早先只判 `!= null`，于是"组关闭"被当成
 *  "无密级"，凭据/.env/secrets/ 会原样明文写进工作树并提交上云。passphrase 为空 = 一律跳过。 */
export function seal(files, passphrase) {
  const plain = []
  const secretItems = []
  const skipped = []

  for (const f of files) {
    const declaresSecret = f.secretGroup !== undefined
    const enabled = typeof f.secretGroup === 'string' && f.secretGroup.length > 0
    const isText = TEXT_SECTIONS.has(f.section)
    if (!declaresSecret && !isText) { plain.push(f); continue }
    // 组关闭（或密级值异常）→ 只留本机。fail closed，绝不降级成明文分支。
    if (declaresSecret && !enabled) { skipped.push(f.rel); continue }
    if (passphrase === '') { skipped.push(f.rel); continue }

    if (isText) {
      const { text, found } = extractSecrets(f.data.toString('utf8'))
      if (found.length === 0) { plain.push(f); continue }
      plain.push({ ...f, data: Buffer.from(text, 'utf8') })
      for (const item of found) secretItems.push({ rel: `${f.rel}#${item.placeholder}`, plain: Buffer.from(item.value, 'utf8') })
      continue
    }
    secretItems.push({ rel: f.rel, plain: f.data })
  }

  const bag = secretItems.length === 0 ? null : encryptBag(secretItems, passphrase)
  return { plain, bag, skipped }
}

/**
 * 开包：密文袋 → { rel → 明文 Buffer }（文本分区的 key 是 `rel#placeholder`）。
 * @param {object|null} bag
 * @param {string} passphrase
 * @returns {Promise<Map<string, Buffer>>}
 * @throws {SyncError} DECRYPT_FAILED（口令错/损坏/有袋无口令）—— 失败即不写盘。
 */
export async function open(bag, passphrase) {
  const map = new Map()
  if (bag === null || bag === undefined) return map
  // 有袋无口令与"口令错"同口径：带 code 才能被 UI 路由，也才会走 errors.mjs 的兜底脱敏。
  if (passphrase === '') throw decryptFailed('secrets.enc.json present but no passphrase configured')
  for (const item of decryptBag(bag, passphrase)) {
    map.set(item.rel, item.plain)
  }
  return map
}

/** 把袋里的文本秘密回填进明文文本（导入方向）。 */
export function restoreText(rel, data, opened) {
  const found = []
  for (const [key, value] of opened) {
    const prefix = `${rel}#`
    if (key.startsWith(prefix)) found.push({ placeholder: key.slice(prefix.length), value: value.toString('utf8') })
  }
  if (found.length === 0) return data
  return Buffer.from(restoreSecrets(data.toString('utf8'), found), 'utf8')
}
