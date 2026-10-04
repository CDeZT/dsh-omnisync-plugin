// lib/backend-folder.mjs — 文件夹后端：把「网盘目录」当 git remote（零新增合并逻辑）。
//
// 网盘目录**不是网络协议**：`git push <本地绝对路径>` 是本地文件操作，不需要认证/网络/
// 新传输层，三方合并、非 FF 检测、墓碑、fork 全部原样复用 GitBackend。本模块只管三件事：
// 准备目录、探测可用性、报告冲突副本。每条检查都由网盘的一条物理事实逼出来：
//   ① 最终一致 → 目录可能在同步中途被读，每轮同步前探测，不能写就响亮拒绝；
//   ② 冲突副本 → 两端同改一个文件时云盘不合并只留两份。裸仓 objects/ 内容寻址天然可合并，
//      **refs/ 与 HEAD 才是唯一可变**的 → 副本高发区，必须报告、绝不静默忽略；
//   ③ 驱逐占位 → iCloud「优化存储」把文件抽成 `.icloud`（内容不在本地）→ 必须拒绝。
//
// 接线：`prepareFolderRemote(dir, {run})` 一次 → `assertFolderUsable(dir)` 每轮 → 
//       `new GitBackend(makeFolderBackendDeps({...}))`（remote 从 URL 换成该目录绝对路径）。

import { access, readdir, stat } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import path from 'node:path'
import { ERROR_CODES, SyncError, badInput, gitFailed } from './errors.mjs'

/** 裸仓结构标记（保守判定：非空目录若无这些标记，一律拒绝碰它）。 */
const BARE_MARKERS = ['HEAD', 'objects', 'refs']
/** 空目录判定时忽略的宿主噪声（iCloud 撒 .DS_Store，Windows 撒 desktop.ini）。 */
const NOISE = new Set(['.DS_Store', 'desktop.ini'])
/** 云盘「正在下载」的临时后缀 —— 见到即拒绝（读到半截 pack 会污染本地仓）。 */
const PARTIAL_RE = /\.(?:part|crdownload|download|filepart|partial|tmp)$/iu
/** 冲突副本残余：iCloud ` 2`/` (2)`、Dropbox ` (A's conflicted copy 日期)`、通用 `.conflict-*`。
 *  OneDrive 重复文件夹命名不透明，只保守匹配前两类 —— 宁可漏报，也不误报让用户删错目录。 */
export const CONFLICT_SUFFIX_RE = /^(?: \d+| \(\d+\)| \([^()]*conflicted copy[^()]*\)|\.conflict(?:ed)?(?:[-. ].*)?)(?:\.[\w.-]+)?$/iu

/** BACKEND_UNSUPPORTED 工厂（errors.mjs 有此码但未给工厂；不改别人的文件，本地补）。 */
const backendUnsupported = (what, details) => new SyncError(ERROR_CODES.BACKEND_UNSUPPORTED, `folder backend: ${what}`, details)

/** 只读 stat（不存在返回 null）。★ 跟随符号链接：云盘根常是链接，用 lstat 会误判合法挂载点。 */
const statMaybe = async (abs) => { try { return await stat(abs) } catch { return null } }

/** 裸仓结构判定（纯 fs、不启子进程：探测必须在任何 git 动作之前就能下结论）。 */
const looksBare = async (dir) => (await Promise.all(BARE_MARKERS.map((n) => statMaybe(path.join(dir, n))))).every((st) => st !== null)

/** a 是否等于 b 或在 b 之内（带 path.sep 收口，避免 /repo 误吞 /repo2）。 */
function within(a, b) { return a === b || a.startsWith(b + path.sep) }

/**
 * 可用性探测：现在能不能安全读写这个网盘目录？不抛错（调用方可能只想提示用户）。
 * code: NOT_MOUNTED / NOT_A_DIR / READ_ONLY / UNREADABLE / EVICTED / SYNCING / LOCKED / NOT_BARE。
 * @returns {Promise<{ok: boolean, dir: string, code?: string, reason?: string, entries?: string[]}>}
 */
export async function probeFolderRemote(dir) {
  const abs = path.resolve(dir)
  const st = await statMaybe(abs)
  if (st === null) return { ok: false, code: 'NOT_MOUNTED', reason: `cloud directory not mounted: ${abs}`, dir: abs }
  if (!st.isDirectory()) return { ok: false, code: 'NOT_A_DIR', reason: `not a directory: ${abs}`, dir: abs }
  try { await access(abs, FS.W_OK) } catch { return { ok: false, code: 'READ_ONLY', reason: `not writable (read-only mount / quota / permissions): ${abs}`, dir: abs } }
  let names
  try { names = await readdir(abs) } catch (error) { return { ok: false, code: 'UNREADABLE', reason: `readdir failed (${error?.code ?? error}): ${abs}`, dir: abs } }
  const evicted = names.filter((n) => n.endsWith('.icloud'))
  if (evicted.length > 0) return { ok: false, code: 'EVICTED', reason: `content evicted to cloud, not local (${evicted[0]}) — disable "optimize storage" or force download: ${abs}`, dir: abs, entries: evicted.slice(0, 5) }
  const partial = names.filter((n) => PARTIAL_RE.test(n))
  if (partial.length > 0) return { ok: false, code: 'SYNCING', reason: `sync client mid-download (${partial[0]}) — retry later: ${abs}`, dir: abs, entries: partial.slice(0, 5) }
  // 顶层 *.lock 只来自 git 自己的 ref/config 更新：要么有进程正在写（跨进程单飞），
  // 要么云盘把崩溃残留同步过来了（陈旧锁会让后续 push 全失败且原因难懂）。
  const locks = names.filter((n) => n.endsWith('.lock'))
  if (locks.length > 0) return { ok: false, code: 'LOCKED', reason: `stale or in-flight git lock (${locks[0]}) — another process is syncing, or delete it if no git is running: ${abs}`, dir: abs, entries: locks.slice(0, 5) }
  if (!(await looksBare(abs))) {
    const data = names.filter((n) => !NOISE.has(n))
    const why = data.length === 0 ? 'no bare repo yet — run prepareFolderRemote first' : 'holds data but is not a bare repo (refusing to touch)'
    return { ok: false, code: 'NOT_BARE', reason: `${why}: ${abs}`, dir: abs, entries: data.slice(0, 5) }
  }
  return { ok: true, dir: abs }
}

/** 探测 + 响亮拒绝（同步循环的单一入口；不能写就抛，绝不"尽力而为"）。 */
export async function assertFolderUsable(dir) {
  const probe = await probeFolderRemote(dir)
  if (!probe.ok) throw backendUnsupported(`${probe.code}: ${probe.reason}`, { dir: probe.dir, code: probe.code, entries: probe.entries })
  return probe
}

/**
 * 校验/准备网盘裸仓（幂等）。**绝不覆盖用户数据**：目录存在但不是裸仓 → 响亮拒绝。
 * @param {string} dir - 网盘里的裸仓目录（绝对路径）。
 * @param {object} opts - { run, branch?, allowInit?, signal? }；run 即 GitBackend 的 git runner。
 * @returns {Promise<{dir: string, created: boolean}>}
 */
export async function prepareFolderRemote(dir, opts) {
  if (typeof opts?.run !== 'function') throw badInput('prepareFolderRemote needs a git runner (opts.run)')
  const abs = path.resolve(dir)
  const parent = path.dirname(abs)
  const parentSt = await statMaybe(parent)
  if (parentSt === null || !parentSt.isDirectory()) {
    // ★ 绝不替用户创建云盘根：云盘未挂载时 mkdir 出来的是一个**本地**目录，看着像成功、
    //   实际永远不同步 —— 静默的假成功比报错危险得多。
    throw backendUnsupported(`cloud root not mounted: ${parent}`, { dir: abs, parent })
  }
  const existing = await statMaybe(abs)
  if (existing !== null) {
    if (!existing.isDirectory()) throw backendUnsupported(`refusing to replace a file with a bare repo: ${abs}`, { dir: abs })
    if (await looksBare(abs)) return { dir: abs, created: false }
    const data = (await readdir(abs)).filter((n) => !NOISE.has(n))
    if (data.length > 0) {
      throw backendUnsupported(`refusing to initialize over existing data (${data.length} entries, not a bare repo): ${abs}`, { dir: abs, entries: data.slice(0, 5) })
    }
  }
  // 空目录或不存在 → git init --bare（git 自己会建目录，省掉一次 mkdir 竞态）。
  // allowInit:false 时拒绝创建：云盘客户端尚未把对端裸仓同步下来时抢建空仓 = 与对端分叉。
  if (opts.allowInit === false) throw backendUnsupported(`cloud repo not initialized yet, refusing to create it (allowInit=false): ${abs}`, { dir: abs })
  const args = ['init', '--bare', ...(opts.branch === undefined ? [] : ['-b', opts.branch]), abs]
  const result = await opts.run(args, { cwd: parent, signal: opts.signal })
  if (result.code !== 0) throw gitFailed('init', String(result.stderr ?? '').trim().split('\n').slice(-2).join(' | ') || `exit ${result.code}`)
  if (!(await looksBare(abs))) throw backendUnsupported(`git init --bare produced no bare repo: ${abs}`, { dir: abs })
  return { dir: abs, created: true }
}

/** 报告同目录下的云盘「冲突副本」。**只报告、绝不删除**：副本里可能是对端唯一的一份数据。 */
export async function findConflictCopies(dir) {
  const abs = path.resolve(dir)
  const parent = path.dirname(abs)
  const base = path.basename(abs)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  let names
  try { names = await readdir(parent) } catch { return [] }
  const out = []
  for (const name of names) {
    if (name === base || !name.startsWith(stem)) continue
    const rest = name.slice(stem.length)
    if (!CONFLICT_SUFFIX_RE.test(rest)) continue
    const kind = /^ \d+/u.test(rest) ? 'numbered' : (/conflicted copy/iu.test(rest) ? 'conflicted-copy' : 'conflict-suffix')
    out.push({ name, path: path.join(parent, name), kind })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 拼 GitBackend 的 deps：**与 GitHub 后端的唯一区别是 remote 从 URL 换成本地绝对路径**。 */
export function makeFolderBackendDeps(opts) {
  if (typeof opts?.run !== 'function') throw badInput('makeFolderBackendDeps needs a git runner (opts.run)')
  // 相对路径按进程 cwd 解析 —— 对一个「云盘绝对位置」而言这是静默走错目录，必须拒绝。
  if (!path.isAbsolute(opts.repoDir ?? '')) throw badInput(`folder backend repoDir must be absolute (got ${JSON.stringify(opts.repoDir)})`)
  if (!path.isAbsolute(opts.remoteDir ?? '')) throw badInput(`folder backend remoteDir must be absolute (got ${JSON.stringify(opts.remoteDir)})`)
  const repoDir = path.resolve(opts.repoDir)
  const remote = path.resolve(opts.remoteDir)
  // 互相嵌套 = 工作树 add -A 会把裸仓（或反过来）提交进历史，两边一起烂。
  if (within(remote, repoDir) || within(repoDir, remote)) throw backendUnsupported(`worktree and cloud repo must not nest (repoDir=${repoDir}, remoteDir=${remote})`, { repoDir, remoteDir: remote })
  return { repoDir, remote, branch: opts.branch, commitName: opts.commitName, commitEmail: opts.commitEmail, timeoutMs: opts.timeoutMs, run: opts.run }
}
