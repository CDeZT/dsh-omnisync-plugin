// lib/rebind.mjs — 路径跨机重定基：在「本机 ⇄ 工作树」边界把绝对路径模板化/还原。
//
// 为什么必须做：`storages/workspace.json` 的 `tables.workspaces.<uuid>.path` 是绝对路径
// （实测形如 `<家目录>/Documents/<项目>/default-workspace`），原样同步过去
// 那边就是一个不存在的目录。模板形态与替换顺序见 paths.mjs。

import { templatize, detemplatize } from './paths.mjs'

/** 含本机绝对路径、需要重定基的分区。 */
const REBIND_SECTIONS = new Set(['workspace'])

/** 递归只改字符串值，结构与类型原样保留。 */
function mapValue(value, fn) {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapValue(v, fn))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = mapValue(v, fn)
    return out
  }
  return value
}

/**
 * 文本级重定基（JSON 文件用）。解析失败原样返回 —— 绝不破坏内容，交给合并器处理。
 * @param {Buffer} data - 原始内容。
 * @param {'templatize'|'detemplatize'} direction
 * @param {{home: string, dshHome: string}} vars
 * @returns {Buffer}
 */
export function rebindText(data, direction, vars) {
  const text = data.toString('utf8')
  const fn = direction === 'templatize' ? templatize : detemplatize
  try {
    const parsed = JSON.parse(text)
    const mapped = mapValue(parsed, (s) => fn(s, vars.home, vars.dshHome))
    return Buffer.from(JSON.stringify(mapped, null, 2) + '\n', 'utf8')
  } catch {
    return data
  }
}

/** 某个分区是否需要重定基。 */
export function needsRebind(sectionId) {
  return REBIND_SECTIONS.has(sectionId)
}
