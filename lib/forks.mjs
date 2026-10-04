// lib/forks.mjs — 把 keep-both 的 fork 补落到**本机**（零直接 I/O，能力经 ctx 注入）。
//
// 冲突裁决把远端版本转成 `<path>.remote-fork-<14位UTC>-<8位设备>` 写进镜像工作树/远端，
// 本机对应目录里却看不到 —— 用户不知道发生过冲突，也无法取回远端版本。配置分区尤其严重：
// applyToLocal 按注册表前缀匹配，`AGENTS.md.remote-fork-…` 匹配不上 `AGENTS.md`
// （sectionOf → null）→ 被跳过；push 路径的冲突则压根没有落地步骤。所以本模块是**独立的一步**：
// 不依赖注册表匹配，只认 FORK_NAME_RE，且绝不覆盖已存在文件。

import { FORK_NAME_RE } from './constants.mjs'
import { forkName } from './mergers/keepboth.mjs'
import { badInput, pathUnsafe } from './errors.mjs'

/** 落本机前的最后一道闸：拒绝空路径、绝对路径、UNC 与 `..` 上跳。
 *  UNC 必须显式挡：`\\server\share\x` 不以 `/` 开头、也不是盘符，会被漏放行，而 Windows 上
 *  `path.resolve(home, '\\\\server\\share\\x')` 会真的写到网络共享。判据用"首段为空"统一
 *  覆盖 `//x`、`\\\\x`、`\/x` 等所有双分隔符开头形态。 */
function assertSafeRel(rel) {
  const s = String(rel ?? '')
  const parts = s.split(/[\\/]/u)
  const first = parts[0] ?? ''
  if (s === '' || first === '' || /^[a-zA-Z]:$/u.test(first) || parts.includes('..')) {
    throw pathUnsafe('fork-write', s)
  }
  return s
}

/** fork 后缀：`<14 位数字戳>-<≤8 位设备>`，设备位放宽到任意非分隔符。
 *  ★ 刻意比 FORK_NAME_RE 宽松一档：forkName 只做 `String(deviceId).slice(0, 8)`，而 index.mjs
 *  的兜底值是 `'unknown'`（7 位）—— 严格 RE 会失配，于是**合法的 fork 被拒绝落地**，正好是
 *  本模块要防的"远端版本在本机看不到"。协议口径仍以 FORK_NAME_RE 为准（生产 deviceId 是
 *  deriveDeviceId 的 8 位 hex，必然匹配）；这里只保证"只写 fork 形态的路径"，且不含 `/`、`\`。 */
const FORK_SUFFIX_RE = /\.remote-fork-\d{14}-[^\s/\\]{1,8}$/u

/** 是否为 fork 路径（挡住"fork 的 fork"无限增殖；宽松档见 FORK_SUFFIX_RE）。 */
export function isForkRel(rel) {
  const s = String(rel ?? '')
  return FORK_NAME_RE.test(s) || FORK_SUFFIX_RE.test(s)
}

/** 由原路径推出 fork 路径。命名复用 keepboth.forkName —— 树侧与本机侧**同一相对路径**
 *  （不额外加目录层），这正是"fork 落地"能简单到只是复制一份的原因。 */
export function localForkRel(rel, deviceId, now) {
  return forkName(assertSafeRel(rel), deviceId, now)
}

/** 纯函数：决定哪些 fork 该落地（无 I/O，最好测的一层）。三组均排序 → 确定性。 */
export function planForkLanding(forkPaths, presentRels) {
  const present = presentRels instanceof Set ? presentRels : new Set(presentRels)
  const land = []
  const skip = []
  const reject = []
  for (const raw of new Set(forkPaths)) {
    const rel = String(raw ?? '')
    try {
      assertSafeRel(rel)
      if (!isForkRel(rel)) { reject.push(rel); continue }
    } catch { reject.push(rel); continue }
    // 已存在 = 同一个 fork（时间戳+设备已编码进名字）→ 跳过，绝不覆盖用户看得见的文件。
    if (present.has(rel)) skip.push(rel)
    else land.push(rel)
  }
  return { land: land.sort(), skip: skip.sort(), reject: reject.sort() }
}

/**
 * 把工作树里的 fork 落到本机（内容经 readTree 取，I/O 全走 ctx）。
 * ★ 本机存在性判定的能力名是 `existsLocal`（收**相对路径**）—— 刻意不叫 `exists`：
 *   index.mjs 的 treeCtx.exists 收的是**绝对路径**（ensureWorkspaceDirs 用），同名会把
 *   "本机已有该 fork"误判成 false，直接踩坏"绝不覆盖"这条铁律。
 * @param {object} ctx - { readTree(rel), writeLocal(rel, data), existsLocal(rel) }。
 * @param {Iterable<string>} forkPaths - 通常直接传 resolveConflicts() 返回的 forks。
 * @returns {Promise<{landed: string[], skipped: string[], rejected: string[], missing: string[]}>}
 */
export async function landForks(ctx, forkPaths) {
  for (const fn of ['readTree', 'writeLocal', 'existsLocal']) {
    if (typeof ctx?.[fn] !== 'function') throw badInput(`landForks needs ctx.${fn}`)
  }
  const present = new Set()
  for (const raw of new Set(forkPaths)) {
    const rel = String(raw ?? '')
    if (isForkRel(rel) && await ctx.existsLocal(rel)) present.add(rel)
  }
  const plan = planForkLanding(forkPaths, present)
  const landed = []
  const missing = []
  for (const rel of plan.land) {
    const data = await ctx.readTree(rel)
    // 工作树里读不到 = 上游根本没写成（不是"没冲突"）→ 报告出来，绝不假装成功。
    if (data === null || data === undefined) { missing.push(rel); continue }
    await ctx.writeLocal(rel, data)
    landed.push(rel)
  }
  return { landed, skipped: plan.skip, rejected: plan.reject, missing }
}
