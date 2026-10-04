// lib/apply.mjs — 工作树 ⇄ 本机的落盘（push 物化 / pull 落地），都建立在 workspace.mjs
// 的原子写 + 0600 之上。会话走 sessions.mjs 的镜像分支，不在这里。

import { seal, open as openVault, restoreText, VAULT_FILE } from './vault.mjs'
import { rebindText, needsRebind } from './rebind.mjs'
import { isSessionPath } from './sessions.mjs'
import { isObjectRel, verifyObjectData } from './attachments.mjs'
import { HOST_ARTIFACT_NAME_RE, NEVER_SYNC } from './constants.mjs'
import { SECTION_BY_ID } from './sections.mjs'
import { assertRelPath } from './paths.mjs'
import { decryptFailed } from './errors.mjs'

/** 不进通道的本机路径（工作树/备份/凭据脚本自身）。 */
const SELF_RE = /^omnisync\//

/**
 * 密文袋里的整文件秘密是否允许落本机。三重校验缺一都是越界写入面。
 *
 * 必须校验的理由：`secrets.enc.json` 是**远端内容** —— 旧版本插件、被篡改的仓库、共享
 * 口令的另一台机器都能决定袋里的 `rel`。不允许时**跳过**而非抛错：抛错会让远端单方面
 * 卡死本机的 pull，且此处已过解密、再抛就落在"树文件已写"之后 = 半应用。
 * @param {string} rel - 袋里的条目键。
 * @param {(rel: string) => string|null} sectionOf
 */
function secretTargetAllowed(rel, sectionOf) {
  if (typeof rel !== 'string' || rel.length === 0) return false
  if (NEVER_SYNC.includes(rel)) return false // 安全边界不是偏好
  if (sectionOf(rel) === null) return false // 注册表之外 = 默认拒绝
  try {
    assertRelPath(rel)
  } catch {
    return false // 穿越 / 绝对路径 / NUL / 盘符
  }
  return true
}

/** 袋必须是合法 JSON：损坏/截断（含 git 冲突标记）与解密失败同口径，裸 SyntaxError 无 code。 */
function parseBag(raw) {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw decryptFailed(`${VAULT_FILE} is not valid JSON`)
  }
}

/**
 * 本机 → 工作树（含 vault 封包）。
 * @param {object} ctx - { walk, read, writeTree, removeTree, listTree, sectionOf, secretGroupOf, passphrase, vars?, logger? }
 * @returns {Promise<{changed: number, skipped: number}>}
 */
export async function applyToWorktree(ctx) {
  const files = []
  for (const f of await ctx.walk()) {
    if (SELF_RE.test(f.rel) || HOST_ARTIFACT_NAME_RE.test(f.rel.split('/').pop())) continue
    if (isSessionPath(f.rel)) continue // 会话走 mirrorSessions
    const section = ctx.sectionOf(f.rel)
    if (section === null) continue // 注册表之外 = 默认拒绝
    const raw = await ctx.read(f.rel)
    if (raw === null) continue
    // 含本机绝对路径的分区先模板化：通道内只存模板形态，跨机才有意义。
    const data = needsRebind(section) ? rebindText(raw, 'templatize', ctx.vars ?? {}) : raw
    // secretGroup 必须**三态**（vault.seal 靠它区分"无密级"与"组关闭"）：
    // undefined = 无密级→明文可同步；null = 组被关掉→只留本机，绝不降级成明文；'<group>' = 进袋。
    const declared = SECTION_BY_ID.get(section)?.secretGroup
    const secretGroup = declared === undefined ? undefined : (ctx.secretGroupOf(section) ?? null)
    files.push({ rel: f.rel, section, secretGroup, data })
  }

  const { plain, bag, skipped } = seal(files, ctx.passphrase ?? '')
  let changed = 0
  const wanted = new Set()
  for (const f of plain) {
    wanted.add(f.rel)
    if (await ctx.writeTree(f.rel, f.data)) changed += 1
  }
  if (bag !== null) {
    wanted.add(VAULT_FILE) // 没有秘密时不写袋，避免空文件噪声
    if (await ctx.writeTree(VAULT_FILE, Buffer.from(JSON.stringify(bag), 'utf8'))) changed += 1
  } else if ((ctx.passphrase ?? '') === '') {
    // 无口令时秘密文件全被跳过、bag 必为 null，但工作树里可能已有上一轮的袋。
    // 删它就是毁掉云端的唯一副本（本机明文可能早已不在），故留在 wanted 里不删；
    // 口令回来后的下一轮会用新袋覆盖它。"有口令但确实没有秘密"仍会正常删除。
    wanted.add(VAULT_FILE)
  }
  for (const rel of await ctx.listTree()) {
    if (rel.startsWith('.git/') || wanted.has(rel)) continue // 本机没有的不该留在快照里
    if (await ctx.removeTree(rel)) changed += 1
  }
  return { changed, skipped: skipped.length }
}

/**
 * 一轮"写前备份"闸门（README:74 的承诺）。三条刻意的性质：懒创建目录（本轮无改动就不产生
 * 空目录）、只备份会被改动的文件（调用点都在幂等检查之后）、失败不阻断（备份是后悔药，
 * 不是同步的前置条件）。保留份数由 backupFile 内部的 pruneBackups 闭合。
 * @param {object} ctx - { backupDir?, backupFile?, logger? }
 * @returns {(rel: string) => Promise<void>}
 */
function makeBackupGate(ctx) {
  let dir
  let warned = false
  return async (rel) => {
    if (typeof ctx.backupFile !== 'function' || typeof ctx.backupDir !== 'function') return // 未接线
    try {
      dir ??= await ctx.backupDir('pull')
      await ctx.backupFile(rel, dir)
    } catch (err) {
      if (!warned) {
        warned = true
        ctx.logger?.warn?.(`backup failed, continuing without it: ${err?.message ?? err}`)
      }
    }
  }
}

/**
 * 工作树 → 本机（含 vault 开包与文本回填）。
 * @param {object} ctx - 同 applyToWorktree，另加 { readTree, writeLocal, readLocal?, backupDir?, backupFile? }
 * @returns {Promise<number>} 写入本机的文件数。
 */
export async function applyToLocal(ctx) {
  const bagRaw = await ctx.readTree(VAULT_FILE)
  let opened = new Map()
  if (bagRaw !== null) {
    opened = await openVault(parseBag(bagRaw), ctx.passphrase ?? '')
  }
  const backup = makeBackupGate(ctx)

  let written = 0
  for (const rel of await ctx.listTree()) {
    if (rel.startsWith('.git/') || rel === VAULT_FILE || HOST_ARTIFACT_NAME_RE.test(rel.split('/').pop())) continue
    if (isSessionPath(rel)) continue
    if (ctx.sectionOf(rel) === null) continue
    const raw = await ctx.readTree(rel)
    if (raw === null) continue
    const restored = restoreText(rel, raw, opened)
    // 模板 → 本机绝对路径（工作区 path 必须落在目标机的真实目录上）。
    const data = needsRebind(ctx.sectionOf(rel)) ? rebindText(restored, 'detemplatize', ctx.vars ?? {}) : restored
    // 幂等：内容一致就跳过。否则每轮都重写全部本机文件，触发 DSH 的 chokidar 热重载、
    // 放大回声窗口，且 pulled 计数永远虚高。
    if (ctx.readLocal !== undefined) {
      const current = await ctx.readLocal(rel)
      if (current !== null && current.equals(data)) continue
    }
    // 内容寻址对象：**写之前**校验文件名 == sha256(内容)。对象是云端唯一副本（本机删掉、
    // 远端被覆盖就永久损坏），宁可拒绝落地也不能把坏内容写成"看起来合法"的对象路径。
    if (isObjectRel(rel)) verifyObjectData(rel, data)
    await backup(rel) // 写前备份（此刻磁盘上还是旧内容）
    if (await ctx.writeLocal(rel, data)) written += 1
  }
  // 整文件秘密：袋里有、工作树没有 → 直接落本机。键含 `#` 的是文本分区占位符
  // （已由上面的 restoreText 就地回填），不是文件。
  for (const [key, value] of opened) {
    if (key.includes('#')) continue
    if (!secretTargetAllowed(key, ctx.sectionOf)) {
      // 绝不静默：袋里有、但不能落本机的条目要说出来（旧版残留 / 被篡改 / 注册表改名）。
      ctx.logger?.warn?.(`vault entry skipped (unsafe or unregistered): ${key}`)
      continue
    }
    // 幂等同上：秘密文件同样会触发 chokidar 热重载，没有这道闸每轮都会重写全部凭据/.env/secrets。
    if (ctx.readLocal !== undefined) {
      const current = await ctx.readLocal(key)
      if (current !== null && current.equals(value)) continue
    }
    await backup(key) // 写前备份（此刻磁盘上还是旧内容）
    if (await ctx.writeLocal(key, value)) written += 1
  }
  return written
}

/** 工作区目录自动创建（新机器上 workspace.json 里 path 指向的目录往往还不存在）。 */
export async function ensureWorkspaceDirs(ctx) {
  const raw = await ctx.readLocal('storages/workspace.json')
  if (raw === null) return []
  let doc
  try { doc = JSON.parse(raw.toString('utf8')) } catch { return [] }
  const paths = Object.values(doc?.tables?.workspaces ?? {})
    .map((w) => w?.path)
    .filter((p) => typeof p === 'string' && p.length > 0)
  const created = []
  for (const dir of paths) {
    if (await ctx.exists(dir)) continue
    if (await ctx.mkdir(dir)) created.push(dir)
  }
  return created
}
