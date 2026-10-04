// lib/workspace.mjs — 本机 $DSH_HOME 文件系统适配层（引擎的 fs deps 实现）。
//
// 边界：所有路径都经 assertRelPath + resolveLivePath 收口（越界即响亮拒绝）。三条与 DSH
// 官方语义对齐的细节：① **原子写**（临时文件 + rename —— DSH 的 chokidar 靠 rename 判完整
// 落盘，半截文件会让随后的 DSH 写全部失败，实测 R12/E3）；② **0600**（git 不保存权限位，
// clone 出来是 0644，而 DSH 的 assertOwnerOnly 会让凭据插件整个挂掉，实测 R14/E8）；
// ③ 宿主私有产物既不复制也不删除（跨机传播即事故）。

import { randomBytes } from 'node:crypto'
import { HOST_ARTIFACT_NAME_RE, PRUNE_DIR_SET } from './constants.mjs'
import { resolveLivePath, assertRelPath } from './paths.mjs'
import { isExternalRel, externalRels, EXTERNAL_PREFIX } from './sections.mjs'
import { pathUnsafe } from './errors.mjs'
import { existsSync, statSync } from 'node:fs'

/**
 * 递归遍历一个根目录。
 *
 * ★ 目录级剪枝是性能刚需：本机 ~/.dsh 有 29431 个文件 / 1.5GB（node_modules 18316、
 *   agy-accounts 10867），逐文件 ignore 会照样 stat 它们，必须在下潜前剪掉。
 * @param {string} root - 绝对根。
 * @param {object} [opts] - { ignore?, pruneDir? }；pruneDir(rel) 为 true 则整棵子树跳过。
 * @returns {Promise<Array<{rel, abs, size, mtimeMs, isFile}>>}
 */
export async function walk(root, opts = {}) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const out = []
  const ignore = opts.ignore ?? ((rel) => HOST_ARTIFACT_NAME_RE.test(path.basename(rel)))
  const pruneDir = opts.pruneDir ?? ((rel) => PRUNE_DIR_SET.has(path.basename(rel)))
  const visit = async (dir, prefix) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (ignore(rel)) continue
      if (e.isDirectory() && pruneDir(rel)) continue // 剪枝：不 stat、不下潜
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        await visit(abs, rel)
        continue
      }
      // 符号链接解引用（skills 目录可能是链接；跨机不能指望 target 存在）。
      let st
      try { st = await fs.stat(abs) } catch { continue }
      if (!st.isFile()) continue
      out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs, isFile: true })
    }
  }
  await visit(root, '')
  return out
}

/** 原子写（临时文件 + rename），保证 chokidar 只看到完整文件。 */
export async function writeAtomic(abs, data, opts = {}) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const mode = opts.mode ?? 0o600
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 })
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.omnisync-tmp`
  await fs.writeFile(tmp, data, { mode, flag: 'wx' })
  await fs.rename(tmp, abs)
  // ★ 无条件 chmod：git/zip 不保存权限位，跨机落地必然是 0644，
  //   而 DSH 的 assertOwnerOnly 对 mode & 0o077 != 0 直接抛错。
  if (process.platform !== 'win32') {
    try { await fs.chmod(abs, mode) } catch { /* 权限位不支持的 FS（如某些网络盘）忽略 */ }
  }
}

/**
 * 构造引擎的 fs deps。
 * @param {object} opts - { dshHome, workTree?, backupRoot?, backupKeep?, remoteRelOf?, externalRoots?, git? }
 * @returns {object}
 */
export function makeFsDeps(opts) {
  const dshHome = opts.dshHome
  const workTree = opts.workTree ?? `${dshHome}/omnisync/repo`
  const backupRoot = opts.backupRoot ?? `${dshHome}/omnisync/backups`
  const mapRemote = opts.remoteRelOf ?? ((rel) => rel)
  const externalRoots = opts.externalRoots ?? {}

  const liveOf = (rel) => resolveLivePath(rel, dshHome)

  /** 外部根解析：`@userdata/keybindings.json` → `<userData>/keybindings.json`。keybindings 在
   *  Electron userData 下（不在 $DSH_HOME），用绝对路径注册的话按 $DSH_HOME 相对遍历的
   *  listLocal 永远命中不到（分区静默不可达）；虚拟前缀让"注册表/遍历/读写"说同一套相对路径。 */
  const externalLive = (rel) => {
    const root = externalRoots[EXTERNAL_PREFIX.slice(0, -1)]
    if (root === undefined) return null
    const tail = rel.slice(EXTERNAL_PREFIX.length)
    // 尾部仍要过段级校验（外部根不是越界写入的免罪牌）。
    // pathUnsafe(op, rel)：早先只传 1 个实参 → 消息里印出 `undefined`，排障看不出拒绝原因。
    if (tail === '' || tail.split('/').includes('..') || tail.startsWith('/')) throw pathUnsafe('external-root', rel)
    return `${root}/${tail}`
  }
  const remoteOf = (rel) => resolveLivePath(mapRemote(rel), workTree)

  const readMaybe = async (abs) => {
    const fs = await import('node:fs/promises')
    try { return await fs.readFile(abs) } catch { return null }
  }

  return {
    /** 本机全部文件（注册表分类前的原始清单）。 */
    listLocal: async (prefix) => {
      const all = await walk(dshHome, {
        // ★ 整个 omnisync/ 都是插件自己的工作区（repo/mirror/backups/askpass/token）：既不进
        //   通道，也不该每轮被 stat 一遍（镜像树是全部会话的副本，漏排它 = 每次同步白读一遍）。
        //   注意 omnisync-devices/ 不在其下（是 device-health 分区，必须留）。
        ignore: (rel) => rel.startsWith('omnisync/') || HOST_ARTIFACT_NAME_RE.test(rel.split('/').pop()),
      })
      // 外部根只探测注册表声明的那几个文件（userData 下有 Electron 缓存，整棵遍历不值当）。
      const external = []
      for (const rel of externalRels()) {
        const abs = externalLive(rel)
        if (abs !== null && existsSync(abs)) external.push({ rel, size: statSync(abs).size })
      }
      const merged = [...all, ...external]
      return prefix === '' ? merged : merged.filter((e) => e.rel === prefix || e.rel.startsWith(`${prefix}/`))
    },
    readLocal: async (rel) => {
      if (isExternalRel(rel)) return await readMaybe(externalLive(rel))
      assertRelPath(rel)
      return await readMaybe(liveOf(rel))
    },
    writeLocal: async (rel, buf, writeOpts = {}) => {
      if (isExternalRel(rel)) {
        await writeAtomic(externalLive(rel), buf, { mode: writeOpts.mode ?? 0o600 })
        return
      }
      assertRelPath(rel)
      await writeAtomic(liveOf(rel), buf, { mode: writeOpts.mode ?? 0o600 })
    },
    readRemote: async (rel) => await readMaybe(remoteOf(rel)),
    /* ── 工作树侧读写（锚定 workTree，与 dshHome 侧分离）── */
    listTree: async (prefix = '') => {
      const all = await walk(workTree, { ignore: (rel) => rel.startsWith('.git/') })
      return (prefix === '' ? all : all.filter((e) => e.rel.startsWith(prefix))).map((e) => e.rel)
    },
    readTree: async (rel) => {
      assertRelPath(rel)
      return await readMaybe(remoteOf(rel))
    },
    /** 写工作树；内容未变时返回 false（让调用方统计真实变更数）。 */
    writeTree: async (rel, data) => {
      assertRelPath(rel)
      const abs = remoteOf(rel)
      const existing = await readMaybe(abs)
      if (existing !== null && existing.equals(data)) return false
      await writeAtomic(abs, data, { mode: 0o644 })
      return true
    },
    removeTree: async (rel) => {
      assertRelPath(rel)
      const fs = await import('node:fs/promises')
      try { await fs.rm(remoteOf(rel)); return true } catch { return false }
    },
    /** 三方基线：git 合并基点里的内容（无基点 → null，退化为两方合并）。 */
    base: async (rel) => {
      const git = opts.git
      if (git === undefined) return null
      const remoteHead = await git.schedule(() => git.remoteHeadSha())
      const head = await git.schedule(() => git.headSha())
      if (remoteHead === undefined || head === undefined) return null
      const baseSha = await git.schedule(() => git.mergeBaseOf(head, remoteHead))
      if (baseSha === undefined) return null
      return await git.schedule(() => git.readBlob(baseSha, mapRemote(rel)))
    },
    backupDir: async (kind) => `${backupRoot}/${kind}-${Date.now()}`,
    /** 写前备份（返回备份路径；文件不存在则返回 null）。 */
    backupFile: async (rel, dir) => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const src = liveOf(rel)
      const buf = await readMaybe(src)
      if (buf === null) return null
      const dst = path.join(dir, rel)
      await fs.mkdir(path.dirname(dst), { recursive: true })
      await fs.writeFile(dst, buf)
      await pruneBackups(backupRoot, opts.backupKeep ?? 5)
      return dst
    },
  }
}

/** 备份目录环形清理（保留最近 keep 份）。 */
export async function pruneBackups(root, keep) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  let dirs
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return }
  if (dirs.length <= keep) return
  dirs.sort() // 名字含时间戳 → 字典序即时间序
  for (const name of dirs.slice(0, dirs.length - keep)) {
    await fs.rm(path.join(root, name), { recursive: true, force: true })
  }
}
