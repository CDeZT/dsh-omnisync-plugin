// scripts/coverage.mjs — 真实 $DSH_HOME 的逐文件归属审计。
//
// 为什么要有这个脚本：早先我用"按顶层目录分组、取组内第一个文件的归属"来做覆盖率
// 统计，于是 `profiles/desktop` 因为组内首文件（市场缓存）未覆盖而被整组标红 ——
// **统计口径骗了我**，差点给已覆盖的文件重复加分区。这里改成**逐文件判定**。
//
// 判定三态：
//   已覆盖     → 命中某个分区（打印分区 id 与合并器）
//   硬排除     → 命中 NEVER_SYNC 或目录剪枝（打印原因）
//   未认领     → 既没分区也没排除 → **这是真缺口**，必须为 0
//
// 用法：node scripts/coverage.mjs [--verbose]

import { readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { sectionForPath, SECTIONS, SECTION_BY_ID } from '../lib/sections.mjs'
import { NEVER_SYNC, NEVER_SYNC_PATTERNS, PRUNE_DIR_SET } from '../lib/constants.mjs'

const VERBOSE = process.argv.includes('--verbose')
const HOME = process.env.DSH_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? homedir()}/.dsh`
const PROFILE = process.env.OMNISYNC_PROFILE ?? 'desktop'

if (!existsSync(HOME)) {
  console.log(`$DSH_HOME 不存在（${HOME}）—— 跳过覆盖率审计`)
  process.exit(0)
}

/** 备份残留（用户手工编辑的临时副本）：`*.bak`、`*.bak-<tag>`。 */
const BACKUP_RESIDUE_RE = /\.bak(?:-[\w.-]+)?$/u
/** 硬排除：精确表 + 前缀 + 正则模式（与生产同一套判据，避免审计口径漂移）。 */
const neverSync = (rel) => NEVER_SYNC.some((p) => rel === p || rel.startsWith(`${p}/`))
  || NEVER_SYNC_PATTERNS.some((re) => re.test(rel))

const rows = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    const rel = relative(HOME, abs).replaceAll('\\', '/')
    if (e.isDirectory()) {
      if (PRUNE_DIR_SET.has(e.name)) continue
      walk(abs)
      continue
    }
    rows.push({ rel, size: statSync(abs).size })
  }
}
walk(HOME)

const covered = []
const excluded = []
const unclaimed = []
for (const row of rows) {
  const sec = sectionForPath(row.rel, PROFILE)
  if (sec !== null) { covered.push({ ...row, sec: sec.id }); continue }
  if (neverSync(row.rel)) { excluded.push({ ...row, why: 'NEVER_SYNC' }); continue }
  if (BACKUP_RESIDUE_RE.test(row.rel)) { excluded.push({ ...row, why: '备份残留' }); continue }
  unclaimed.push(row)
}

const sum = (list) => list.reduce((a, r) => a + r.size, 0)
const kb = (n) => `${(n / 1024).toFixed(0)}KB`

console.log(`覆盖率审计 · ${HOME} · profile=${PROFILE}`)
console.log(`  文件总数 ${rows.length}（已剪枝 ${[...PRUNE_DIR_SET].join('/')} 等）`)
console.log(`  已覆盖   ${covered.length} 个 / ${kb(sum(covered))}`)
console.log(`  硬排除   ${excluded.length} 个 / ${kb(sum(excluded))}`)
console.log(`  未认领   ${unclaimed.length} 个 / ${kb(sum(unclaimed))}`)

if (VERBOSE) {
  const bySection = new Map()
  for (const r of covered) {
    const b = bySection.get(r.sec) ?? { n: 0, bytes: 0 }
    b.n += 1; b.bytes += r.size
    bySection.set(r.sec, b)
  }
  console.log('\n── 各分区 ──')
  for (const [id, b] of [...bySection].sort((a, c) => c[1].n - a[1].n)) {
    const m = SECTION_BY_ID.get(id)?.merger ?? 'keepboth'
    console.log(`  ${String(b.n).padStart(4)}  ${kb(b.bytes).padStart(7)}  ${id.padEnd(22)} merger=${m}`)
  }
  console.log('\n── 硬排除明细 ──')
  for (const r of excluded) console.log(`  ${r.why.padEnd(12)} ${r.rel}`)
}

if (unclaimed.length > 0) {
  console.log('\n✗ 未认领文件（每个都必须有归属：加分区 或 加硬排除）：')
  for (const r of unclaimed) console.log(`  ${kb(r.size).padStart(7)}  ${r.rel}`)
  process.exit(1)
}
console.log('\n✓ 每个文件都有明确归属（分区或硬排除）')
