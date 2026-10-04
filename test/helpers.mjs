import { test } from 'node:test'
import { createRequire } from 'node:module'
// test/helpers.mjs — 19 个测试文件的共享底座（消除各自重写的 setup）。
//
// 为什么集中：这些 setup 原本在 19 个文件里各写一遍，改一处要改 19 处 —— 而且已经出过
// 一次事故：`makeFakeDomain` 的某份副本写成了 `get`(async) + `set`（真 API 是同步 `get` /
// 异步 `put` / **没有** `set`），于是测试全绿而真机炸 `table.set is not a function`。
// 假 stub 比没测试更危险，所以桩只留**一份**忠实副本，就在这里。

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { GitBackend } from '../lib/git.mjs'
import { sectionForPath, SECTION_BY_ID } from '../lib/sections.mjs'

const exec = promisify(execFile)

/* ───────────────────────── 临时目录 ───────────────────────── */

/** 一次性临时根，测试结束自动删（用 t.after，比 try/finally 少一层缩进）。 */
export async function tmpRoot(t, prefix = 'omni-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

/** 临时根 + 已建好的 `home` / `tree` 两棵树（apply 方向测试的通用起手式）。 */
export async function tmpHomeTree(t, prefix = 'omni-') {
  const root = await tmpRoot(t, prefix)
  const home = join(root, 'home')
  const tree = join(root, 'tree')
  await mkdir(home, { recursive: true })
  await mkdir(tree, { recursive: true })
  return { root, home, tree }
}

/* ───────────────────────── 真 git ───────────────────────── */

/**
 * 真 git runner（测试内直连系统 git；生产走 ctx.subprocess）。
 * `-c credential.helper=` 清空凭据助手：否则 CI 上会弹认证或挂住。
 * 失败**不抛**，转成 `{code, stdout, stderr}` —— 被测代码要自己判定非零退出。
 */
export function nativeGit({ timeoutMs = 30_000, encoding } = {}) {
  return async (args, opts = {}) => {
    try {
      const { stdout, stderr } = await exec('git', ['-c', 'credential.helper=', ...args], {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: opts.binary === true ? 'buffer' : (encoding ?? 'utf8'),
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) }
    }
  }
}

/** 直接跑一条 git 并要 stdout（搭台用；断言仍应走被测代码）。
 *  args 优先：多数调用点用 `-C <dir>` 自带工作目录，无需再传 cwd。 */
export async function gitOut(args, { cwd, env } = {}) {
  const opts = { cwd }
  // env 是**叠加**在父环境上的（与 DSH subprocess 同语义）—— 用于验证
  // "按 GIT_ENV_SCRUB 构造的 env 能不能被真 git 接受"。
  if (env !== undefined) opts.env = { ...process.env, ...env }
  return String((await exec('git', ['-c', 'credential.helper=', ...args], opts)).stdout).trim()
}

/** GitBackend 的标准测试构造（固定身份 + 真 runner）。 */
export function backendFor({ repoDir, remote, branch = 'main', run, ...rest }) {
  return new GitBackend({
    repoDir, remote, branch,
    commitName: 'omnisync-test', commitEmail: 'test@localhost',
    timeoutMs: 30_000,
    run: run ?? nativeGit(),
    ...rest,
  })
}


/** 断言以指定**领域错误码**拒绝。
 *
 *  为什么不用裸 `assert.rejects(fn)`：那只能证明"抛了"，证明不了"抛对了" ——
 *  错误码是 UI/日志的路由依据，锁住它才算真断言（约 20 处曾各写一遍谓词样板）。 */
export async function rejectsCode(fn, code, message) {
  await assert.rejects(fn, (e) => e.code === code, message ?? `应以 ${code} 拒绝`)
}

/* ───────────────────────── 文件系统 ───────────────────────── */

/** 读不到就 null（比 try/catch 更短，且不吞真实错误类型）。 */
export const readMaybe = (abs) => readFile(abs).catch(() => null)

/** 递归遍历 → 相对 posix 路径（对齐 workspace.mjs 的 walk 形态）。 */
async function walkRel(root, { skipGit = false } = {}) {
  const out = []
  const rec = async (dir, prefix) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (skipGit && e.name === '.git') continue
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (e.isDirectory()) await rec(join(dir, e.name), rel)
      else out.push(rel)
    }
  }
  await rec(root, '')
  return out
}

/** 在 abs 处写文件，自动建父目录。 */
export async function writeAt(abs, data, mode) {
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, data, { mode })
}

/** `sectionForPath` 的常用收敛形态（未分类 → null = 跳过）。 */
const defaultSectionOf = (rel, profile = 'desktop', vars) =>
  sectionForPath(rel, profile, vars)?.id ?? null

/**
 * 把 makeFsDeps 的能力包成 apply/sessions 要的 ctx 形状。
 * 只做**形状适配**，不含业务判断 —— 各测试仍可 overrides 覆盖任意字段。
 */
export function fsCtx(deps, overrides = {}) {
  const ctx = {
    walk: () => deps.listLocal(''),
    walkAll: () => deps.listLocal(''),
    read: (rel) => deps.readLocal(rel),
    readLocal: (rel) => deps.readLocal(rel),
    readTree: (rel) => deps.readTree(rel),
    listTree: () => deps.listTree(),
    writeTree: (rel, data) => deps.writeTree(rel, data),
    writeLocal: (rel, data) => deps.writeLocal(rel, data),
    removeTree: (rel) => deps.removeTree(rel),
    sectionOf: defaultSectionOf,
  }
  return { ...ctx, ...overrides }
}


/**
 * 密级三态判定（apply/vault 的核心语义，两处曾各写一份相同实现）：
 *   undefined = 该分区没有密级 → 明文可同步；
 *   null      = 声明了密级但用户关掉了该组 → 只留本机，**绝不降级成明文**；
 *   '<group>' = 进密文袋。
 * @param {Record<string, boolean>} groups - 各秘密组的开关状态。
 */
export function secretGroupOf(groups) {
  return (sectionId) => {
    const g = SECTION_BY_ID.get(sectionId)?.secretGroup
    return g === undefined || groups[g] === false ? null : g
  }
}

/* ───────────────────────── 注入能力（真 fs 上的 ctx） ───────────────────────── */

/**
 * 真文件系统上的最小 ctx（listLocal 返回 `{rel}` walk 形态，listTree 返回字符串）。
 * 写入**幂等**：内容一致返回 false（不重写）—— 断言 written 计数的测试依赖这一点。
 */
export function caps({ home, tree }) {
  const put = async (base, rel, data) => {
    const abs = join(base, rel)
    if ((await readMaybe(abs))?.equals(data)) return false
    await writeAt(abs, data)
    return true
  }
  // 前缀按**路径段**匹配：'a/b' 不该匹配到 'a/bc'（否则 knownObjects 会捞到隔壁目录）。
  const listUnder = async (base, prefix) =>
    (await walkRel(base)).filter((r) =>
      prefix === undefined || prefix === '' || r === prefix || r.startsWith(`${prefix}/`))
  return {
    listLocal: async (prefix) => (await listUnder(home, prefix)).map((rel) => ({ rel })),
    listTree: (prefix) => listUnder(tree, prefix),
    readLocal: (rel) => readMaybe(join(home, rel)),
    readTree: (rel) => readMaybe(join(tree, rel)),
    writeLocal: (rel, data) => put(home, rel, data),
    writeTree: (rel, data) => put(tree, rel, data),
    existsLocal: async (rel) => (await readMaybe(join(home, rel))) !== null,
  }
}

/**
 * 记录动作的假 git（三方合并/冲突裁决用）：只记 checkout/addAll，不真跑 git。
 * 两个文件曾各写一份**逐字节相同**的副本，故收在这里。
 */
export function fakeGit(stages, conflicted = []) {
  const actions = []
  return {
    actions,
    schedule: (fn) => fn(),
    conflictedPaths: async () => conflicted,
    readStageBlob: async (stage, path) => stages[path]?.[stage],
    checkoutStage: async (which, path) => { actions.push(`checkout:${which}:${path}`) },
    addAll: async () => { actions.push('add-all') },
  }
}

/* ───────────────────────── 假 storageDomain ───────────────────────── */
/**
 * 忠实复刻 storageDomain 的表 API（真机核对 dsh-storage-domain/lib/index.js:241-292）：
 * `get()` **同步**、`put()`/`delete()`/`update()` 异步、`entries()`/`keys()` 迭代器、`size` getter。
 * ★ 桩必须与真接口同形 —— 否则会放过 `table.set is not a function` 这类错误。
 */
export function makeFakeDomain() {
  const rows = new Map()
  const table = {
    get: (k) => rows.get(k),
    put: async (k, v) => { rows.set(k, v) },
    delete: async (k) => rows.delete(k),
    update: async (k, fn) => { const next = fn(rows.get(k)); rows.set(k, next); return next },
    entries: () => [...rows.entries()][Symbol.iterator](),
    keys: () => [...rows.keys()][Symbol.iterator](),
    get size() { return rows.size },
  }
  return { table: () => table, close: async () => {} }
}

/** 收集 spawn 调用的假 subprocess（记录 argv/env，不真跑 git）。 */
export function fakeSubprocess(records) {
  const empty = { readFrom: () => ({ text: '' }) }
  return {
    async resolveExecutable(bin) { return `/usr/bin/${bin}` },
    spawn(options) {
      records.push({ argv: options.argv, env: options.env })
      return {
        stdout: (async function* none() {})(),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: empty, stderr: empty },
      }
    },
  }
}

/**
 * 该 peer 依赖是否可解析（DSH 运行时提供，克隆下来可能没有）。
 * 为什么需要：本插件的 peer 依赖（`@deepseek-ai/*`）由宿主 DSH 提供，**不随仓库分发**。
 * 于是"从 GitHub 克隆后直接 `npm test`"会在 6 个文件上抛 ERR_MODULE_NOT_FOUND ——
 * 对用户是**误导性的红**（看着像插件坏了，其实是缺宿主依赖）。这里让它们**优雅跳过**。
 */
export function hasPeer(name) {
  try {
    createRequire(import.meta.url).resolve(`${name}/package.json`)
    return true
  } catch {
    try { createRequire(import.meta.url).resolve(name); return true } catch { return false }
  }
}

/**
 * 缺 peer 依赖时：整份文件只登记一条 **skip**，并说清怎么补。
 * @param {string[]} peers - 该文件需要的包名。
 * @param {string} file - 文件名（用于消息）。
 * @returns {boolean} true = 缺依赖，调用方应立刻 return。
 */
export function skipWithoutPeers(peers, file) {
  const missing = peers.filter((p) => !hasPeer(p))
  if (missing.length === 0) return false
  test(`${file}: 跳过（缺宿主 peer 依赖：${missing.join(', ')}）`, { skip: `在 DSH 桌面端里跑：dsh plugin --profile desktop add file:<本仓库路径>，或把宿主 node_modules 链进来（npm run dev-link）` }, () => {})
  return true
}

/**
 * 动态加载宿主 peer 依赖 —— **必须在守卫之前不抛**。
 *
 * 为什么不能静态 import：ESM 的静态 import 在模块求值**之前**执行，所以
 * `import { Context } from '@deepseek-ai/cordis'` 在克隆出来的仓库里会直接
 * 抛 ERR_MODULE_NOT_FOUND，**轮不到** `skipWithoutPeers` 登记跳过。改成
 * 顶层 await 的动态导入后，缺依赖只会得到空对象 + 一条清晰的 skip。
 * @returns {Promise<object>} 模块命名空间；缺依赖时返回空对象。
 */
export async function peer(name) {
  try { return await import(name) } catch { return {} }
}

/**
 * 动态导入插件入口（`index.mjs`）。
 *
 * 为什么不能静态 import：`index.mjs → lib/config.mjs` 在**模块作用域**就要
 * `@deepseek-ai/schemastery` 与 `dsh-storage-domain`（用它们构建 Config schema 与
 * domain spec，这是宿主 peer 依赖，不随仓库分发）。静态 import 会在克隆出来的仓库里
 * 直接抛 ERR_MODULE_NOT_FOUND，轮不到守卫登记跳过。
 * @returns {Promise<object|null>} 模块命名空间；缺宿主依赖时返回 null。
 */
export async function pluginEntry() {
  try { return await import('../index.mjs') } catch { return null }
}

/**
 * 缺宿主依赖时登记一条 skip 并返回 true（调用方据此提前结束）。
 * @param {string} file
 */
export function skipWithoutHost(file) {
  test(`${file}: 跳过（缺宿主依赖 @deepseek-ai/*，本机未安装 DSH）`, {
    skip: '在 DSH 桌面端里跑：npm run dev-link（把宿主的 node_modules 链进来）后再 npm test',
  }, () => {})
  return true
}
