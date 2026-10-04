// lib/paths.mjs — 路径工具（零 DSH 依赖，纯函数 + node:path）。不读盘。
//
// 三个职责：① 断言（任何要拼进仓库或写盘的相对路径先过 assertRelPath）；
// ② 模板化（机器绝对路径 ⇄ 占位符，跨机快照的核心）；③ 平台映射（命令路径 + 会话目录键）。

import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { pathUnsafe } from './errors.mjs'

/** 占位符（templatize 的替换顺序即此：长前缀优先）。 */
const DSH_HOME_TOKEN = '${DSH_HOME}'
const HOME_TOKEN = '${HOME}'

/** 命令名 → 各平台首选绝对路径。与 PoC（tools/dsh-sync.mjs:107-114）同表，保证两代工具互操作。 */
/**
 * 用户家目录 —— **唯一来源**，不要在别处再读 `process.env.HOME`。
 *
 * ★ Windows 上 `HOME` 通常**未设置**（用的是 `USERPROFILE`）。早先 `index.mjs` 写
 *   `${process.env.HOME ?? ''}/.dsh`，在 Windows 上会推出 `/.dsh`（当前盘根下的目录）
 *   —— 于是插件读写的是一个**完全错误的位置**，而且不报错。`os.homedir()` 由 Node
 *   按平台自行判定（posix 取 HOME、Windows 取 USERPROFILE），是最后的兜底。
 * @returns {string} 家目录绝对路径（拿不到时返回空串，调用方据此判"不可用"）。
 */
export function userHome() {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir() ?? ''
}

const COMMAND_MAP = Object.freeze({
  npx: { darwin: '/opt/homebrew/bin/npx', linux: '/usr/local/bin/npx', win32: '{APPDATA}\\npm\\npx.cmd' },
  uvx: { darwin: '{HOME}/.local/bin/uvx', linux: '{HOME}/.local/bin/uvx', win32: '{HOME}\\.local\\bin\\uvx.exe' },
  node: { darwin: '/opt/homebrew/bin/node', linux: '/usr/local/bin/node', win32: '{PROGRAMFILES}\\nodejs\\node.exe' },
  python3: { darwin: '/opt/homebrew/bin/python3', linux: '/usr/bin/python3', win32: '{LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe' },
  pnpm: { darwin: '/opt/homebrew/bin/pnpm', linux: '/usr/local/bin/pnpm', win32: '{APPDATA}\\npm\\pnpm.cmd' },
})

/** 展开路径模板里的环境占位符（home 已知的前提下）。 */
function expandTemplate(tpl, home) {
  const text = String(tpl)
  // ★ 分隔符风格必须跟模板走：Windows 模板里塞进 posix home 会产出
  //   `/Users/x\.local\bin\uvx.exe` 这种两边都不认的路径（实测踩到）。
  const win = text.includes('\\')
  const h = win ? toWindows(home) : toPosix(home)
  const under = (...parts) => (win ? [h, ...parts].join('\\') : join(h, ...parts))
  return text
    .replaceAll('{HOME}', h)
    .replaceAll('{APPDATA}', under('AppData', 'Roaming'))
    .replaceAll('{LOCALAPPDATA}', under('AppData', 'Local'))
    .replaceAll('{PROGRAMFILES}', 'C:\\Program Files')
}

/** posix → Windows 分隔符（只改分隔符，不动盘符）。 */
function toWindows(path) {
  return String(path).replaceAll('/', '\\')
}

/** 平台归一：未知平台按 linux 处理 —— 保守，不猜 macOS 的 homebrew 布局。 */
function normPlatform(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux'
}

/** 某命令在指定平台的候选绝对路径（找不到返回 null，绝不抛错）。 */
export function platformCommand(name, home, platform = process.platform) {
  const table = COMMAND_MAP[name]
  if (table === undefined) return null
  const tpl = table[normPlatform(platform)]
  return tpl === undefined ? null : expandTemplate(tpl, home)
}

/** 路径分隔符归一为 posix（跨平台比较用）。 */
function toPosix(p) {
  return String(p).replaceAll('\\', '/')
}

/** posix → 平台分隔符（写盘用）。 */
function fromPosix(p) {
  return sep === '/' ? String(p) : String(p).replaceAll('/', sep)
}

/** 去尾部分隔符（根路径除外）。 */
function stripTrailing(p) {
  return p.length > 1 && (p.endsWith('/') || p.endsWith('\\')) ? p.slice(0, -1) : p
}

/**
 * 断言仓库相对路径安全。拒绝：空串、绝对路径、`..` 段、NUL、盘符。
 * @param {unknown} rel - 待校验路径（posix 形态）。
 * @returns {string} 原样返回（便于链式使用）。
 * @throws {SyncError} code=PATH_UNSAFE。
 */
export function assertRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw pathUnsafe('assert', rel)
  if (rel.includes('\0')) throw pathUnsafe('assert', rel)
  const posix = toPosix(rel)
  if (posix.startsWith('/')) throw pathUnsafe('assert', rel)
  if (/^[A-Za-z]:/u.test(posix)) throw pathUnsafe('assert', rel)
  for (const seg of posix.split('/')) {
    if (seg === '..' ) throw pathUnsafe('assert', rel)
  }
  return rel
}

/** 前缀包含检查（段边界安全）：`/a/bc` 不在 `/a/b` 内 —— 必须比到分隔符，不能只看字符串前缀。 */
export function isWithin(parent, child) {
  const p = stripTrailing(toPosix(parent))
  const c = stripTrailing(toPosix(child))
  if (p === c) return true
  return c.startsWith(p + '/')
}

/**
 * 机器绝对路径 → 占位符文本（跨机快照的前提）。
 * @param {string} text - 任意文本（配置内容）。
 * @param {string} home
 * @param {string} dshHome
 * @returns {string}
 */
export function templatize(text, home, dshHome) {
  if (typeof text !== 'string') return text
  let out = text
  // ① 命令绝对路径 → ${CMD:name} 必须**最先**做：{APPDATA}/{HOME} 模板展开后本身就落在
  //    home 之下（Windows 的 npx/pnpm、各平台的 uvx），先替换 home 这些字面量就永远匹配
  //    不上，${CMD:} 对它们形同虚设（实测会退化成 `${HOME}\AppData\...\npx.cmd`，
  //    跨平台还原成两边都不认的路径）。
  for (const [name, table] of Object.entries(COMMAND_MAP)) {
    for (const tpl of Object.values(table)) {
      const resolved = expandTemplate(tpl, home)
      if (resolved && out.includes(resolved)) out = out.split(resolved).join(`\${CMD:${name}}`)
    }
  }
  // ② $DSH_HOME 必须先于 ${HOME}：否则 /Users/x/.dsh 被 /Users/x 先吃掉，语义丢失。
  if (dshHome) {
    out = out.split(toPosix(dshHome)).join(DSH_HOME_TOKEN)
    out = out.split(dshHome).join(DSH_HOME_TOKEN)
  }
  if (home) {
    out = out.split(toPosix(home)).join(HOME_TOKEN)
    out = out.split(home).join(HOME_TOKEN)
  }
  return out
}

/**
 * 占位符文本 → 目标机路径（templatize 的逆；命令路径按 platform 选）。
 * @param {string} text
 * @param {string} home
 * @param {string} dshHome
 * @param {string} [platform]
 * @returns {string}
 */
export function detemplatize(text, home, dshHome, platform = process.platform) {
  if (typeof text !== 'string') return text
  let out = text
  out = out.split(DSH_HOME_TOKEN).join(dshHome)
  out = out.split(HOME_TOKEN).join(home)
  for (const name of Object.keys(COMMAND_MAP)) {
    const resolved = platformCommand(name, home, platform)
    if (resolved === null) continue
    out = out.split(`\${CMD:${name}}`).join(resolved)
  }
  return out
}

/**
 * 仓库相对路径 → 本机绝对路径（越界断言）。
 * @throws {SyncError} code=PATH_UNSAFE（rel 越界时）。
 */
export function resolveLivePath(rel, root) {
  assertRelPath(rel)
  const abs = join(root, fromPosix(rel))
  if (!isWithin(root, abs)) throw pathUnsafe('resolve', rel)
  return abs
}

/** 单路径段编码（官方 dsh-session-persistence-jsonl:853 语义逐字复刻）。
 *  安全字符保留字面，其余（含 `~`）转 `~XXXX`，`.`/`..` 特判防穿越。
 *  @throws {Error} 空串（与官方一致：调用方 bug，不是数据问题）。 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** 项目目录键（官方 projectKey:875 语义逐字复刻：分隔符折叠为单 `-`、非安全字符 `~XXXX`、
 *  去前导 `-`、截 251、`--…--` 包裹）。有损但人可读 —— 这正是官方设计意图。
 *  @throws {Error} 空串（调用方 bug）。 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}
