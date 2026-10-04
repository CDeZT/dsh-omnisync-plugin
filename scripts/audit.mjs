// scripts/audit.mjs — 共享代码审计（团队成员都用这个，不要各写一份）。
//
// 用法：
//   node scripts/audit.mjs              # 全量报告
//   node scripts/audit.mjs <路径前缀>    # 只看某范围（如 lib/mergers）
//
// 检查项（都是"机器能判定"的客观事实，不靠主观判断）：
//   ① 死代码：导出但全仓库（含测试）零引用
//   ② 内部导出：只在定义文件内使用 → 应取消 export 收窄 API
//   ③ 重复实现：同名/近名函数在多文件出现
//   ④ 未测试模块：lib/ 下没有任何 test 引用到的文件
//   ⑤ 契约风险：调用方传参个数与函数签名不符（粗筛，需人工确认）

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const filter = process.argv[2] ?? ''

const files = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(mjs|js)$/u.test(e.name)) files.push(relative(ROOT, p))
  }
}
walk(ROOT)

/**
 * 去掉注释后的代码文本。
 * 必须做：注释里写的示例调用会被当成真调用 —— `migrateState()` 出现在说明
 * 文字里，就被报成"0 个实参"的契约问题（真踩过）。字符串里的伪调用同理，
 * 这里只处理注释（保守：宁可少报也不误导审计员）。
 */
function stripComments(text) {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .map((line) => {
      // 只截断"不在字符串里"的 `//`：粗略判断引号个数奇偶。
      const idx = line.indexOf('//')
      if (idx < 0) return line
      const quotes = (line.slice(0, idx).match(/['"`]/gu) ?? []).length
      return quotes % 2 === 1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

const raw = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
const sources = new Map([...raw].map(([f, t]) => [f, stripComments(t)]))
const libFiles = files.filter((f) => f.startsWith('lib/') && f.includes(filter))
const testFiles = files.filter((f) => f.startsWith('test/'))

/** 某符号被引用的行数（排除定义行）。 */
function refsOf(sym) {
  let n = 0
  for (const [, text] of sources) {
    for (const line of text.split('\n')) {
      if (new RegExp(`\\b${sym}\\b`, 'u').test(line) && !/^export (?:async )?function|^export const|^function|^const/u.test(line)) n += 1
    }
  }
  return n
}

/** 某符号在定义文件之外被引用的文件数。 */
function externalRefs(sym, self) {
  const hits = []
  for (const [f, text] of sources) {
    if (f === self) continue
    if (new RegExp(`\\b${sym}\\b`, 'u').test(text)) hits.push(f)
  }
  return hits
}

const dead = []
const internal = []
for (const f of libFiles) {
  const text = sources.get(f)
  for (const m of text.matchAll(/^export (?:async )?function ([a-zA-Z_]\w*)|^export const ([A-Za-z_]\w*)/gmu)) {
    const sym = m[1] ?? m[2]
    const total = refsOf(sym)
    if (total === 0) { dead.push(`${f} → ${sym}`); continue }
    if (externalRefs(sym, f).length === 0) internal.push(`${f} → ${sym}`)
  }
}

/* ④ 未测试模块 */
const untested = libFiles.filter((f) => {
  const base = f.replace(/^lib\//u, '').replace(/\.mjs$/u, '')
  const stem = base.split('/').pop()
  return !testFiles.some((t) => {
    const tt = sources.get(t)
    return tt.includes(`lib/${base}.mjs`) || tt.includes(`./${stem}.mjs`) || tt.includes(`../lib/${base}.mjs`)
  })
})

/* ③ 重复实现（同名导出出现在多个文件） */
const byName = new Map()
for (const f of libFiles) {
  for (const m of sources.get(f).matchAll(/^export (?:async )?function ([a-zA-Z_]\w*)/gmu)) {
    if (!byName.has(m[1])) byName.set(m[1], [])
    byName.get(m[1]).push(f)
  }
}
const dupes = [...byName].filter(([, fs]) => fs.length > 1)

/* ⑤ 契约粗筛：函数签名参数个数 vs 调用处实参个数
 *
 * ⚠ 必须做**括号配平**扫描。早期版本用 `\bfn\(([^)]*)\)` 抓参数，遇到嵌套调用
 * 会在内层 `)` 处截断：`fn(mapRemote(rel), workTree)` 被读成 1 个实参，
 * 于是产出成片的假阳性（auditor-data 实测确认过）。假信号会让审计员白改签名。
 */
/** 从 `(` 位置起做括号配平，返回顶层逗号切分的实参个数。 */
function countArgs(text, open) {
  let depth = 0
  let args = 0
  let seen = false
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') { depth += 1; continue }
    if (ch === ')') { depth -= 1; if (depth === 0) return seen ? args + 1 : 0; continue }
    if (depth !== 1) continue
    if (ch === ',') { args += 1; continue }
    if (!/\s/u.test(ch)) seen = true
  }
  return -1 // 未配平（跨文件或语法异常）→ 丢弃，不报
}

const contract = []
for (const f of libFiles) {
  const text = sources.get(f)
  for (const m of text.matchAll(/^export (?:async )?function (\w+)\(([^)]*)\)/gmu)) {
    const [, name, params] = m
    const declared = params.trim() === '' ? 0 : params.split(',').filter((p) => !p.includes('=')).length
    if (declared === 0) continue
    for (const [cf, ct] of sources) {
      // 只看 lib→lib 与 index→lib 的调用；测试里的同名断言/工具函数是噪音。
      if (cf === f || cf.startsWith('test/') || cf.startsWith('scripts/')) continue
      for (const c of ct.matchAll(new RegExp(`(?<![.\\w])${name}\\(`, 'gu'))) {
        const args = countArgs(ct, c.index + c[0].length - 1)
        if (args >= 0 && args < declared) contract.push(`${cf} 调 ${name}(${args} 个实参) < ${f} 声明 ${declared} 个必填`)
      }
    }
  }
}

/**
 * 已知假阳性（人工确认过，别再让审计员白改）：
 *   依赖注入的同名回调 —— engine.mjs 从 deps 解构出 `applyToLocal`/`confirm`，
 *   它们是 index.mjs 传进来的闭包，**不是** lib/apply.mjs / lib/gate.mjs 的函数。
 *   按名字匹配无法区分，这两条恒定出现，请忽略。
 */
const KNOWN_FALSE_POSITIVES = [
  /engine\.mjs 调 applyToLocal\(0 个实参\)/u,
  /engine\.mjs 调 confirm\(1 个实参\)/u,
]

/** ③ 重复实现的已知假阳性：`merge` 是 Merger 接口约定，各实现同名是设计要求。 */
const KNOWN_DUPE_INTERFACES = [/^merge: /u]

const show = (title, list, limit = 40) => {
  console.log(`\n── ${title}（${list.length}）──`)
  if (list.length === 0) { console.log('  ✓ 无'); return }
  for (const item of list.slice(0, limit)) console.log(`  ${item}`)
  if (list.length > limit) console.log(`  … 另有 ${list.length - limit} 项`)
}

console.log(`审计范围：${filter === '' ? '全部' : filter}（${libFiles.length} 个 lib 文件）`)
show('① 死代码（应删）', dead)
show('② 仅内部使用（应取消 export）', internal)
show('③ 重复实现（同名导出跨文件；已滤除 Merger 接口约定）',
  dupes.filter(([n]) => !KNOWN_DUPE_INTERFACES.some((re) => re.test(`${n}: `))).map(([n, fs]) => `${n}: ${fs.join(', ')}`))
show('④ 未测试模块', untested)
const real = contract.filter((c) => !KNOWN_FALSE_POSITIVES.some((re) => re.test(c)))
show('⑤ 契约可疑（实参少于必填形参；已滤除依赖注入同名回调）', real)
