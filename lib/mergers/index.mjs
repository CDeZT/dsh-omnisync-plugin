// lib/mergers/index.mjs — Merger 接口与策略表（纯函数，零依赖）。
//
// 设计（research/文件同步算法选型预研.md §4）：
//   1 个默认安全 Merger（keepboth）+ N 个专用 Merger，策略表驱动。
//   新增内容类型 = 加一行注册，**不动流程代码**。
//
// 关键性质：**移除任何一个专用 Merger，系统仍然正确** —— 只是多出 fork
// 文件（退化为 keep-both）。这是"扩展性强 + 简洁"同时成立的原因。

import * as keepboth from './keepboth.mjs'
import * as json from './json.mjs'
import * as tree from './tree.mjs'
import * as patchYaml from './patch-yaml.mjs'
import * as credentials from './credentials.mjs'
import * as blob from './blob.mjs'

/**
 * 统一结果形状：keep-ours / take-theirs / {merged, data} / {conflict, keepOurs, …}；
 * `delete: true` = 该路径应从结果中移除（跟随删除）。
 * @typedef {object} MergeOutcome
 * @property {string} kind
 * @property {Buffer} [data] - 结果字节（`merged` 是它的历史别名）
 * @property {boolean} [keepOurs]
 * @property {boolean} [delete]
 * @property {Array} [forks] - tree 的冲突副本（自带字节，不是路径）
 * @property {Array} [conflicts]
 * @property {string} [note]
 */

/**
 * Merger 契约（duck-typed，无需继承）：merge(input) → MergeOutcome。
 * 全部为纯函数：不改入参、不读时钟（now 注入）、不做 IO。
 * @typedef {object} Merger
 * @property {(input: object) => MergeOutcome} merge
 */

/**
 * 策略表：section.merger 名 → 实现。
 * `blob` = 内容寻址对象：同路径即同内容，内容不同则**硬失败**（损坏不得扩散）。
 */
export const SECTION_MERGER = new Map([
  ['keepboth', keepboth], ['json', json], ['tree', tree],
  ['patch-yaml', patchYaml], ['credentials', credentials], ['blob', blob],
])

/**
 * 取合并器。未知名称 → 回落 keepboth（默认安全：绝不静默覆盖）。
 * @param {string|undefined} name - section.merger 值。
 * @returns {Merger}
 */
export function mergerFor(name) {
  return SECTION_MERGER.get(name) ?? keepboth
}
