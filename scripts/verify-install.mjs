// scripts/verify-install.mjs — 源码 ↔ 已安装副本一致性检查（+ 两半身份核对）。
//
// 为什么需要：pnpm 对 `file:` 依赖有时**原地写**（保留硬链接，源码改动即时生效），
// 有时**替换文件**（链接断开，必须重新安装）。两种都遇到过，所以不能靠假设
// —— 必须能一条命令验证"桌面端加载的确实是当前源码"。
//
// 用法：node scripts/verify-install.mjs [--profile desktop]

import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'desktop'
const LIVE = args.includes('--live')
const SYNC = args.includes('--sync')
const PORT = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 19387
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.dsh')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const profileDir = join(dshHome, 'profiles', profile)
const installedDir = join(profileDir, 'node_modules', pkg.name)

const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/**
 * 发布清单 = package.json 的 files 白名单（目录递归展开）。
 * ★ 必须尊重白名单：test/ scripts/ 验收报告都不发布，拿它们比对是假报警。
 */
async function shippedFiles(rootDir, entries) {
  const out = []
  for (const entry of entries) {
    const abs = join(rootDir, entry)
    if (!existsSync(abs)) { out.push(`${entry} (声明了但不存在)`); continue }
    const st = await stat(abs)
    if (st.isDirectory()) {
      for (const child of await readdir(abs, { withFileTypes: true })) {
        if (child.name.startsWith('.')) continue
        const childAbs = join(abs, child.name)
        if (child.isDirectory()) out.push(...await shippedFiles(rootDir, [relative(rootDir, childAbs)]))
        else out.push(relative(rootDir, childAbs))
      }
    } else {
      out.push(entry)
    }
  }
  return out
}

const problems = []
const notes = []
let needsRestart = false

/* ① 安装位置与清单登记 */
if (!existsSync(installedDir)) {
  console.error(`✗ 未安装：${installedDir}\n  先执行：dsh plugin --profile ${profile} add file:${root}`)
  process.exit(1)
}
const profileManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
const spec = profileManifest.dependencies?.[pkg.name]
const inBundles = (profileManifest.dsh?.profile?.bundles ?? []).includes(pkg.name)
if (spec === undefined) problems.push('profile package.json 的 dependencies 里没有本插件')
if (!inBundles) problems.push('dsh.profile.bundles 里没有本插件（不会被挂载）')
notes.push(`spec: ${spec ?? '(缺失)'}`)

/* ② 逐文件内容比对 */
const wanted = await shippedFiles(root, pkg.files ?? [])
let identical = 0
const differing = []
const missingInSource = []
let linked = 0
for (const rel of wanted) {
  if (rel.includes('(声明了但不存在)')) { missingInSource.push(rel); continue }
  const src = join(root, rel)
  const dst = join(installedDir, rel)
  if (!existsSync(dst)) { differing.push(`${rel}（已安装副本缺失）`); continue }
  if (await hash(src) === await hash(dst)) {
    identical += 1
    if ((await stat(src)).ino === (await stat(dst)).ino) linked += 1
  } else differing.push(rel)
}
for (const m of missingInSource) problems.push(`package.json 的 files 声明了不存在的条目：${m}`)
if (differing.length > 0) {
  problems.push(`${differing.length} 个文件与源码不一致：${differing.slice(0, 8).join(', ')}${differing.length > 8 ? ' …' : ''}`)
}
notes.push(`文件一致 ${identical}/${wanted.length}`)

/* ③ 硬链接状态（逐文件 —— 实测有的链接有的独立，不能只看一个文件） */
notes.push(`硬链接 ${linked}/${identical} 个文件${linked === identical
  ? '（全部链接：源码改动即时生效）'
  : '（部分独立：**改动过的文件必须重装才生效**）'}`)

/* ④ 两半身份核对（真实事故点） */
const clientSrc = await readFile(join(installedDir, 'client.js'), 'utf8')
const clientId = /__ModuleLoader__\.load\(\s*\{\s*id:\s*['"]([^'"]+)['"]/u.exec(clientSrc)?.[1]
if (clientId !== pkg.name) problems.push(`前端注册 ID (${clientId}) ≠ 包名 (${pkg.name}) → 宿主会回退重复注册，桌面启动失败`)
const clientInject = /exports\.inject\s*=\s*\[([^\]]*)\]/u.exec(clientSrc)?.[1]?.replace(/['"\s]/gu, '') ?? ''
const clientUsed = new Set()
for (const m of clientSrc.matchAll(/ctx\.get\(\s*['"]([\w.@/-]+)['"]\s*\)/gu)) clientUsed.add(m[1])
for (const m of clientSrc.matchAll(/ctx\.([a-zA-Z][\w]*)\s*[.&|)]/gu)) clientUsed.add(m[1])
for (const name of [...clientUsed].filter((n) => !['logger', 'effect', 'inject', 'get', 'on', 'emit', 'provide', 'plugin', 'scope'].includes(n))) {
  if (!clientInject.split(',').includes(name)) problems.push(`前端 apply 用了 ctx.${name} 但 exports.inject 未声明 → 初始化失败`)
}
notes.push(`前端 ID: ${clientId} · inject: [${clientInject}]`)
const hostName = /export const name = (\w+)/u.exec(await readFile(join(installedDir, 'index.mjs'), 'utf8'))?.[1]
notes.push(`宿主 name 来源: ${hostName ?? '(未导出)'}`)

/* ④b 可选：把缺失/不一致的文件硬链接补齐（--sync） */
if (SYNC && differing.length > 0) {
  const { link, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  let fixed = 0
  for (const rel of differing) {
    const clean = rel.replace(/（.*?）/u, '')
    if (!existsSync(join(root, clean))) continue
    const dst = join(installedDir, clean)
    await mkdir(dirname(dst), { recursive: true })
    await rm(dst, { force: true })
    await link(join(root, clean), dst) // 硬链接：源码改动即时生效
    fixed += 1
  }
  if (fixed > 0) {
    notes.push(`已硬链接补齐 ${fixed} 个文件（重跑本检查确认）`)
    problems.length = 0
    problems.push(...differing.slice(fixed).map((r) => `${r} 未能补齐`))
  }
}

/* ⑤ 运行时探针（--live）：进程里跑的到底是哪个版本？
   DSH 的热重载只重新导入插件入口 index.mjs，lib/** 的相对导入留在 ESM 缓存里
   —— 所以"磁盘新版、进程旧版"是常态，必须能探测而不是靠猜。 */
if (LIVE) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/omnisync/api/v1/status`)
    const body = await res.json()
    const live = body?.data?.libRev
    if (live === undefined) {
      needsRestart = true
      problems.push('运行中的插件未报告 libRev（进程里是旧模块）')
    } else if (live !== pkg.version) {
      needsRestart = true
      problems.push(`运行中的版本 v${live} ≠ 源码 v${pkg.version}`)
    } else {
      notes.push(`运行中版本 v${live} ✓ 与源码一致`)
    }
  } catch (error) {
    notes.push(`运行时探针跳过（端口 ${PORT} 未响应：${String(error?.message ?? error).slice(0, 60)}）`)
  }
}

/* 报告 */
console.log(`\n检查 ${pkg.name}@${pkg.version} → ${installedDir}\n`)
for (const n of notes) console.log(`  · ${n}`)
if (problems.length === 0) {
  console.log('\n✓ 已安装副本与源码一致，两半身份正确\n')
  process.exit(0)
}
console.log('\n✗ 发现问题：')
for (const p of problems) console.log(`  - ${p}`)
if (problems.some((p) => p.includes('已安装副本缺失'))) {
  console.log('\n提示：pnpm 可能被 profile 的供应链策略挡住（minimumReleaseAge）。')
  console.log('      此时可手工硬链接补齐（保持"源码改动即时生效"的链接语义）：')
  console.log(`      node scripts/verify-install.mjs --sync   # 自动补齐缺失/不一致的文件`)
}
if (needsRestart) {
  console.log('\n原因：DSH 的热重载只重新导入插件入口（index.mjs），lib/** 的相对导入')
  console.log('      仍留在 ESM 缓存里 —— 所以磁盘是新版、进程是旧版。重装无用。')
  console.log('\n修复：**完整重启 DeepSeek Harness**（退出应用再打开）\n')
} else {
  console.log(`\n修复：dsh plugin --profile ${profile} add file:${root}\n`)
}
process.exit(1)
