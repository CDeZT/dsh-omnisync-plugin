// scripts/size.mjs — 代码规模度量（精简工作的统一标尺，别各自用 wc -l）。
//
// 为什么需要：`wc -l` 把注释和空行也算进去，于是"精简"很容易变成"删注释"。
// 本脚本把三者分开，并给出**注释/代码比** —— 比 >0.8 通常意味着注释写成了散文
// （该留"为什么"，不该复述"是什么"）。
//
// 用法：
//   node scripts/size.mjs            # 实现 + 测试总览
//   node scripts/size.mjs lib        # 只看 lib/
//   node scripts/size.mjs test       # 只看 test/

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const filter = process.argv[2] ?? ''

/** 收集 .mjs/.js 文件（跳过 node_modules 与隐藏目录）。 */
function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collect(p, out)
    else if (/\.(mjs|js)$/u.test(e.name)) out.push(p)
  }
  return out
}

/** 一行的归类：注释 / 空行 / 代码。 */
function classify(line) {
  if (/^\s*(\/\/|\/\*|\*)/u.test(line)) return 'comment'
  if (line.trim() === '') return 'blank'
  return 'code'
}

function measure(files) {
  const rows = files.map((abs) => {
    const rel = abs.slice(ROOT.length)
    const lines = readFileSync(abs, 'utf8').split('\n')
    const n = { comment: 0, blank: 0, code: 0 }
    for (const l of lines) n[classify(l)] += 1
    const tests = (readFileSync(abs, 'utf8').match(/^test\(/gmu) ?? []).length
    return { rel, total: lines.length, ...n, tests, ratio: n.comment / (n.code || 1) }
  })
  return rows
}

const all = collect(ROOT).filter((f) => !f.includes('/scripts/'))
const impl = measure(all.filter((f) => !f.includes('/test/') && (filter === '' || filter === 'lib')))
const tests = measure(all.filter((f) => f.includes('/test/') && (filter === '' || filter === 'test')))

const report = (title, rows) => {
  if (rows.length === 0) return
  const t = rows.reduce((a, r) => ({
    total: a.total + r.total, code: a.code + r.code, comment: a.comment + r.comment, tests: a.tests + r.tests,
  }), { total: 0, code: 0, comment: 0, tests: 0 })
  console.log(`\n── ${title}（${rows.length} 个文件）──`)
  console.log(`  代码 ${t.code} · 注释 ${t.comment} · 空行 ${t.total - t.code - t.comment} · 总 ${t.total}`)
  console.log(`  注释/代码 ${(t.comment / (t.code || 1)).toFixed(2)}` + (t.tests > 0 ? ` · 测试 ${t.tests} 个` : ''))
  // 只列"值得看一眼"的：最大的 10 个 + 注释比超标的
  const big = [...rows].sort((a, b) => b.code - a.code).slice(0, 10)
  const wordy = rows.filter((r) => r.ratio > 0.8 && r.code > 30).sort((a, b) => b.ratio - a.ratio)
  console.log('  最大的：')
  for (const r of big) console.log(`    ${String(r.code).padStart(4)} 代码 ${String(r.comment).padStart(4)} 注释  ${r.rel}`)
  if (wordy.length > 0) {
    console.log('  注释比 >0.8（该瘦身，只留"为什么"）：')
    for (const r of wordy) console.log(`    ${r.ratio.toFixed(2)}  ${r.rel}（${r.code} 代码 / ${r.comment} 注释）`)
  }
}

report('实现', impl)
report('测试', tests)
