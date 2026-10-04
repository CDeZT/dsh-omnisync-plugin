// lib/mergers/equal.mjs — 合并内核的公共小工具：深比较 + 表归一（零依赖）。
//
// 为什么单独一个文件：json / patch-yaml / credentials 三个合并器各自抄了一份
// **逐字节相同**的深比较（deepEqual / deepEq / jsonEqual）；credyaml 与
// credentials 又各抄了一份"Map / 键值对数组 / 普通对象 → Map"的归一。
// 重复意味着多处可能各自漂移 —— 而"两侧是否相等"是三方合并全部裁决的起点，
// 判据漂移会直接变成"该合并的判成冲突"或更糟"该冲突的判成相等"。
//
// 深比较语义（三份原本一致，此处固化）：
//   键序无关（对象按 key 集合比）、数组**序敏感**、类型敏感（'1' ≠ 1）。
export function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a !== 'object') return false
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
}

/**
 * Map / 键值对数组 / 普通对象 → Map（其余形态 → 空表）。
 * 为什么需要：解析层产出 `[k, v]` 数组（保序），合并层要 Map，渲染层还得
 * 同时接受调用方手搓的三种形态。
 * @param {Map|Array<[*,*]>|object|null|undefined} v
 * @returns {Map}
 */
export function toMap(v) {
  if (v instanceof Map) return v
  if (Array.isArray(v)) return new Map(v)
  return new Map(v !== null && typeof v === 'object' ? Object.entries(v) : [])
}
