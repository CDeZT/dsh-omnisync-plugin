// lib/credyaml.mjs — .credentials.yaml 的读写（version / refs / records）。
//
// 为什么不用通用 YAML 库：DSH 对该文件是「全拒式」解析（未知键/字段一律整体
// 拒收），所以产出形态必须精确可控；输入里还有第三方插件写的长 JSON 串。
// 这里只认自己关心的三个顶层段，其余原样留在 chunks 里。
//
// ★ 保真原则（2026-10 对 5 份真实文件实测取证，见 test/audit-credyaml.test.mjs）：
//   ① `payload:` 在真实文件里是 **YAML 嵌套映射**（`      version: 1`），不是
//      JSON 流式块。读成字符串 → 渲染成 `"version: 1\n..."` → DSH 全拒式解析
//      拒收**整份**文件 = 用户凭据全丢。旧实现正是这个 bug。
//   ② refs 的长 JSON 值会被**折行**（`'{"a":"xx` + 4 空格续行 + `yy"}'`），
//      YAML 语义是「折行 → 一个空格」。只读第一物理行 ⇒ 值被截断
//      （实测单个 ref 丢 175 字符），JSON.parse 直接失败 ⇒ 挖不到过期时间。
//   ③ 段序是 `version, records, refs`（实测 5/5）。
//   ①②③ 任一处理错，parse → render 就不逐字节相等 —— 而往返不等意味着
//   **每轮同步都在重写用户的凭据文件**。
//   因此：解析时把每一行的原始形态记进 chunks；渲染时**值没变就原样吐回**，
//   只有真正被合并改动过的条目才走规范形态（"没改的东西一个字节都不动"）。
//
// ⚠ 已知边界（2026-10 实测确认，别被上面的"逐字节"误导）：
//   chunks 只在 **直接 parse → render** 时可用。同步路径是
//   `parse → snapshotOf({refs,records}) → mergeCredentials → render`，
//   `raw` 在 snapshotOf 处就丢了 → 同步路径走**规范重排**。
//   实测影响：**值完全保留**（真实文件 10 refs / 3 records 往返后条数与值均等价），
//   但字节形态会变（实测 8916 → 8989 字节：引号风格/折行位置被规范化）。
//   即"冲突后用户的凭据文件会被重排一次"，不是数据丢失。
//   要消掉这个边界，需把 `p.raw` 透传进 snapshotOf 并按获胜方携带 —— 那会改动
//   合并数据流，属独立变更，未在本轮做。

import { deepEqual, toMap } from './mergers/equal.mjs'

/** 去一层引号并还原转义。单引号内 `''` 是转义的单引号（DSH 长 JSON ref 的形态）。 */
const unquote = (s) => {
  const t = String(s).trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  return t
}

/**
 * 单引号风格包裹（内部 `'` 翻倍）。不用双引号：JSON 串本身含大量 `"`，
 * 双引号风格会被转义成 `\"` 而难还原。
 */
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`

/**
 * 该行上的标量是否**未闭合**（= 后面还有续行）。
 * 单引号：末尾连续 `'` 个数为偶数即未闭合（`''` 是转义）。双引号：末尾的 `"`
 * 若被奇数个反斜杠转义则未闭合。无引号的 plain 标量按已闭合处理（保守：
 * 真实文件里的 plain ref 都是单行，误吞后续行比截断更危险）。
 */
function unterminated(t) {
  if (t.startsWith("'")) {
    let n = 0
    while (t[t.length - 1 - n] === "'") n++
    return n % 2 === 0
  }
  if (!t.startsWith('"')) return false
  if (!t.endsWith('"')) return true
  let n = 0
  while (t[t.length - 2 - n] === '\\') n++
  return n % 2 === 1
}

/** YAML core schema 的标量还原（够用即可；宁可留字符串，也不猜错类型）。 */
function resolveScalar(s) {
  const t = String(s).trim()
  if (t === '') return null
  if (t.length >= 2 && /^(['"])[\s\S]*\1$/u.test(t)) return unquote(t)
  if (/^(?:~|null|Null|NULL)$/u.test(t)) return null
  if (/^(?:true|True|TRUE)$/u.test(t)) return true
  if (/^(?:false|False|FALSE)$/u.test(t)) return false
  // 大整数保留字符串形态（Number 会丢精度 —— 宁可类型保守也不改用户的值）。
  if (/^[-+]?\d+$/u.test(t)) {
    const n = Number(t)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/u.test(t)) {
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  return t
}

/**
 * 解析一个缩进块（payload / env 的块体）。
 *
 * 两种真实形态都要认：
 *   ① JSON 流式块（`{` 起头）—— 第三方插件会写，既有测试也锁着；
 *   ② YAML 嵌套映射（`      key: value`）—— **DSH 自己写的形态**，实测 5/5。
 * 都认不出时返回原始文本（绝不静默丢字段）。
 */
function parseBlock(body) {
  const nonBlank = body.filter((l) => l.trim() !== '')
  if (nonBlank.length === 0) return {}
  const text = nonBlank.map((l) => l.trim()).join('\n')
  // 块内不做 `#` 注释剥离：JSON 流式块里的 `#` 只可能出现在字符串里。
  if (/^[[{]/u.test(text)) { try { return JSON.parse(text) } catch { /* 落到映射解析 */ } }
  const obj = parseMapBlock(nonBlank)
  // 一行映射都没认出来 → 保留原文，别把自由文本 payload 丢掉。
  return Object.keys(obj).length > 0 ? obj : text
}

/** 缩进块 → 对象 / 数组（按缩进递归；支持 `- ` 序列，避免未知形态被丢）。 */
function parseMapBlock(lines) {
  const obj = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*#/u.test(line)) { i++; continue } // 映射块里 `#` 起头 = YAML 注释
    const indent = line.match(/^ */u)[0].length
    const m = /^\s*([^:\s][^:]*?):(?:\s+(.*))?$/u.exec(line)
    if (m === null) { i++; continue }
    const key = m[1].trim()
    const inline = (m[2] ?? '').trim()
    if (inline !== '') {
      // 内联流式集合（`{...}`/`[...]`）先按 JSON 认：YAML 里这就是流式集合，
      // 认不出来会让对象值退化成字符串（渲染回去就成了 '[object Object]'）。
      try { obj[key] = /^[[{]/u.test(inline) ? JSON.parse(inline) : resolveScalar(inline) } catch { obj[key] = resolveScalar(inline) }
      i++
      continue
    }
    // 值为嵌套块：吃掉所有更深缩进的行。
    const sub = []
    let j = i + 1
    const deeper = (l) => l.trim() === '' || l.match(/^ */u)[0].length > indent
    while (j < lines.length && deeper(lines[j])) { if (lines[j].trim() !== '') sub.push(lines[j]); j++ }
    obj[key] = sub.length === 0
      ? null
      : (/^\s*-\s/u.test(sub[0]) ? sub.map((l) => resolveScalar(l.replace(/^\s*-\s?/u, ''))) : parseMapBlock(sub))
    i = j
  }
  return obj
}

/**
 * 解析一条 record 体（kind / key / env / payload）。
 * env 与 payload 都是**嵌套块**，必须按 >4 空格收；早先只认 4 空格行 ⇒ 整块丢失。
 */
function parseRecord(lines) {
  const rec = {}
  let i = 0
  while (i < lines.length) {
    const m = /^ {4}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u.exec(lines[i])
    if (m === null) { i++; continue }
    const field = m[1]
    const inline = m[2].trim()
    if (field === 'payload' || field === 'env') {
      const body = []
      let j = i + 1
      while (j < lines.length && (lines[j].trim() === '' || /^ {5,}\S/u.test(lines[j]))) { body.push(lines[j]); j++ }
      // 内联形态（`env: {A: 1}`）不是本渲染器的产出，但第三方插件可能写：
      // 能当对象读就当对象，读不出就原样留字符串（绝不静默丢）。
      let v = inline
      if (inline !== '') { try { const p = JSON.parse(inline); if (p !== null && typeof p === 'object') v = p } catch { /* 留字符串 */ } }
      rec[field] = inline === '' ? parseBlock(body) : v
      i = j
      continue
    }
    rec[field] = unquote(inline)
    i++
  }
  return rec
}

/**
 * 解析 .credentials.yaml。
 * @param {string} text
 * @returns {{refs: Array<[string,string]>, records: Array<[string,object]>,
 *            raw: {chunks: Array<object>}}}
 *   `raw.chunks` 是**逐行保真**所需的原始形态（含空行/注释/未识别行），
 *   渲染时按它原样吐回未被改动的条目。
 */
export function parseCredYaml(text) {
  const src = String(text)
  // ★ 两套行数组：`rawLines` 保留原样（含 CRLF 的 `\r`）用于逐字节回吐；
  //   `lines` 去掉行尾 `\r` 用于解析。必须分开 —— JS 正则的 `.` **不匹配 `\r`**，
  //   而所有解析正则都以 `(.*)$` 收尾，直接拿 CRLF 行去匹配会**一行都匹配不上**
  //   ⇒ refs/records 全空 ⇒ 合并把空集当结果写回 ⇒ 整份凭据从文件里消失。
  //   CRLF 完全可能（Windows 上的插件写盘、文件经 Windows 工具传输）。
  const rawLines = src.split('\n')
  const lines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const refs = new Map()
  const records = new Map()
  const chunks = []
  let pending = [] // 尚未归属任何条目的原始行（version / 段头 / 空行 / 注释 / 未识别行）
  const flushPending = () => { if (pending.length > 0) { chunks.push({ t: 'raw', lines: pending }); pending = [] } }

  let section = null
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const raw = rawLines[i] // 原始行（可能带 \r）—— 进 chunks 用，保证逐字节
    const top = /^(refs|records|version):/u.exec(line)
    if (top !== null) {
      section = top[1]
      // 段头单独成块：段内条目被删空时要把它改成 `refs: {}`（裸 `refs:` 在 YAML
      // 里是 null，不是空映射 —— DSH 全拒式解析可能因此拒收**整份**文件）。
      if (top[1] === 'version') pending.push(raw)
      else { flushPending(); chunks.push({ t: 'section', name: top[1], line: raw }) }
      i++
      continue
    }
    if (section === 'refs') {
      const m = /^ {2}([^\s:]+):\s*(.*)$/u.exec(line)
      if (m === null) { pending.push(raw); i++; continue } // 段内未识别行：留着，别丢
      // 折行标量：续行缩进 > 2，按 YAML 语义折成一个空格（实测单个 ref 会折掉 175 字符）。
      const parts = [m[2].trim()]
      const body = [raw]
      let j = i + 1
      if (unterminated(parts[0])) {
        while (j < lines.length && /^ {3,}\S/u.test(lines[j])) { parts.push(lines[j].trim()); body.push(rawLines[j]); j++ }
      }
      const value = unquote(parts.filter((p) => p !== '').join(' '))
      flushPending()
      refs.set(m[1], value)
      chunks.push({ t: 'ref', key: m[1], value, lines: body })
      i = j
      continue
    }
    if (section === 'records') {
      const key = /^ {2}([^\s:]+):\s*$/u.exec(line)
      if (key === null) { pending.push(raw); i++; continue }
      const body = [raw]
      const parsed = []
      let j = i + 1
      // ` {4,}` 而非 ` {4}`：record 体里 payload/env 的子行缩进是 6 空格，
      // 只认 4 空格会让 record 在第一个嵌套行处被截断（payload 整块丢失）。
      while (j < lines.length && /^ {4,}\S/u.test(lines[j])) { parsed.push(lines[j]); body.push(rawLines[j]); j++ }
      const rec = parseRecord(parsed)
      flushPending()
      records.set(key[1], rec)
      chunks.push({ t: 'rec', key: key[1], value: rec, lines: body })
      i = j
      continue
    }
    pending.push(raw) // 段外/段前（version、空行、注释、未知段）
    i++
  }
  flushPending()
  return { refs: [...refs], records: [...records], raw: { chunks } }
}

/* ───────────────────────── 渲染 ───────────────────────── */

/** 值是否未变（refs 比字符串，records 比结构且键序无关）—— 深比较复用 equal.mjs。 */
const unchanged = (t, a, b) => (t === 'ref' ? a === b : deepEqual(a, b))

/** 值 → 行内标量：字符串走单引号风格，其余（对象/数组/数字/布尔/null）走 JSON。 */
const inlineScalar = (v) => (typeof v === 'string' ? quote(v) : JSON.stringify(v))

/**
 * 段头之后、下一个段头之前，是否存在**搬不走的**未识别行。
 * 只有 raw 块算数：ref/rec 块对应的条目若被裁决删除，那一块会整体消失。
 * @param {Array<object>} chunks
 * @param {number} ci - section 块的下标。
 */
function hasUnparsedContent(chunks, ci) {
  // 往后第一个"段头或非空 raw 块"决定答案：段头 → 没有搬不走的行；raw → 有。
  const stop = chunks.slice(ci + 1).find((c) => c.t === 'section' || (c.t === 'raw' && c.lines.some((l) => l.trim() !== '')))
  return stop !== undefined && stop.t === 'raw'
}

/** record 的 schema 白名单（其余字段第三方可能写，必须原样留住）。 */
const KNOWN_FIELDS = new Set(['kind', 'key', 'env', 'payload'])

/** 规范形态：一条 ref / record 的行。 */
function canonicalLines(t, key, value) {
  if (t === 'ref') return [`  ${key}: ${quote(value)}`]
  const out = [`  ${key}:`]
  const v = value ?? {}
  if (v?.kind !== undefined) out.push(`    kind: ${v.kind}`)
  if (v?.key !== undefined) out.push(`    key: ${quote(v.key)}`)
  const env = v?.env
  if (env !== null && typeof env === 'object') {
    // ★ 值不能一律 quote：对象/数组会被 quote 成 '[object Object]' —— 那是静默改坏
    //   用户数据（第三方插件的 env 里放结构化值就会命中）。
    out.push('    env:')
    for (const [ek, ev] of Object.entries(env)) out.push(`      ${ek}: ${inlineScalar(ev)}`)
  } else if (env !== undefined) {
    // 非对象形态（第三方内联写法）：原样写回。绝不能掉进 Object.entries
    // —— null 会抛，字符串会展开成 `0: 'a'` 这种垃圾。
    out.push(`    env: ${env}`)
  }
  if (v?.payload !== undefined) out.push('    payload:', ...JSON.stringify(v.payload, null, 2).split('\n').map((l) => `      ${l}`))
  // 白名单之外的字段（第三方插件写的）也必须留住 —— 丢了就是静默丢数据。
  for (const [k, val] of Object.entries(v)) if (!KNOWN_FIELDS.has(k)) out.push(`    ${k}: ${inlineScalar(val)}`)
  return out
}

/** 规范形态：整份文档（无原始形态可用时）。段序取 DSH 自己的产出序（实测 5/5）。 */
function canonicalDocument(refs, records) {
  const out = ['version: 1']
  for (const [name, t, table] of [['records', 'rec', records], ['refs', 'ref', refs]]) {
    if (table.size === 0) continue
    out.push(`${name}:`)
    for (const [k, v] of table) out.push(...canonicalLines(t, k, v))
  }
  return out.join('\n') + '\n'
}

/**
 * 渲染回 .credentials.yaml。
 *
 * 传进来的若是 `parseCredYaml` 的产出（带 `raw.chunks`），则**值未变的条目
 * 原样吐回原始行** —— 这是 parse → render 逐字节相等的唯一可靠做法：
 * 引号风格、折行位置、plain 与 quoted 的混用、段序，全都无法靠"规范重排"复现。
 * 一旦合并真的改动了值（或新增了键），该条目走规范形态。
 *
 * @param {{refs: Map|Array|object, records: Map|Array|object, raw?: object}} merged
 * @returns {string}
 */
export function renderCredYaml(merged) {
  const refs = toMap(merged?.refs)
  const records = toMap(merged?.records)
  const chunks = merged?.raw?.chunks

  if (Array.isArray(chunks) && chunks.length > 0) {
    // 新增的键不在原始形态里 → 无法定位插入点，退回整份规范渲染。
    const known = new Set(chunks.filter((c) => c.t === 'ref' || c.t === 'rec').map((c) => `${c.t}:${c.key}`))
    if ([...refs.keys()].every((k) => known.has(`ref:${k}`)) && [...records.keys()].every((k) => known.has(`rec:${k}`))) {
      const out = []
      for (let ci = 0; ci < chunks.length; ci++) {
        const c = chunks[ci]
        if (c.t === 'raw') { out.push(...c.lines); continue }
        if (c.t === 'section') {
          const table = c.name === 'refs' ? refs : records
          // 空段要写成 `refs: {}`（裸 `refs:` 在 YAML 里是 null 而非空映射）。
          // 但只有当段后**没有我们搬不走的未识别行**时才改写 —— 否则会在用户
          // 文件里凭空制造 diff（认不出的子行只能原样留着）。
          if (table.size === 0 && !hasUnparsedContent(chunks, ci)) out.push(`${c.name}: {}`)
          // 原行自带流式集合（`refs: {}`）却又有块级子行 → 必须去掉 `{}`，
          // 否则 `refs: {}` 后面跟缩进子行是非法 YAML。
          else if (table.size > 0 && /:\s*[[{]/u.test(c.line)) out.push(`${c.name}:`)
          else out.push(c.line)
          continue
        }
        const table = c.t === 'ref' ? refs : records
        if (!table.has(c.key)) continue // 被裁决为删除 → 该条目整块移除
        const cur = table.get(c.key)
        out.push(...(unchanged(c.t, c.value, cur) ? c.lines : canonicalLines(c.t, c.key, cur)))
      }
      return out.join('\n')
    }
  }
  return canonicalDocument(refs, records)
}
