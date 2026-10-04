// scripts/verify-real-home.mjs — 真实 $DSH_HOME 体检 + 端到端同步闭环验证。
//
// 做两件事（对真实 ~/.dsh **只读**，绝不写、绝不上传）：
//   ① 分类体检：真实文件里有多少能被注册表识别？哪些会被跳过？有没有
//      "本该同步却被漏掉"的（这是最容易静默出问题的地方）；
//   ② 闭环验证：把 ~/.dsh 复制一份到临时目录 → 镜像 → 提交 → 推到本地裸仓
//      → 克隆到第二个 home → 拉回 → 逐字节比对 + 校验秘密没明文出门。
//
// 用法：node scripts/verify-real-home.mjs [--source ~/.dsh] [--keep]

import { mkdtemp, mkdir, rm, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { walk, makeFsDeps } from '../lib/workspace.mjs'
import { sectionForPath, SECTIONS, SECTION_BY_ID } from '../lib/sections.mjs'
import { applyToWorktree, applyToLocal } from '../lib/apply.mjs'
import { GitBackend } from '../lib/git.mjs'
import { VAULT_FILE } from '../lib/vault.mjs'

const run = promisify(execFile)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const SOURCE = argOf('--source', join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.dsh'))
const KEEP = args.includes('--keep')
const PASSPHRASE = 'verify-passphrase'

/** 测试用 git runner（直连系统 git；生产走 ctx.subprocess）。 */
const nativeRun = async (argv, opts = {}) => {
  try {
    const { stdout, stderr } = await run('git', ['-c', 'credential.helper=', ...argv], {
      cwd: opts.cwd, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) }
  }
}

const backendFor = (repoDir, remote, branch = 'main') => new GitBackend({
  repoDir, remote, branch, commitName: 'omnisync-verify', commitEmail: 'verify@localhost',
  timeoutMs: 120_000, run: nativeRun,
})

/* ─────────── ① 分类体检 ─────────── */

async function audit() {
  console.log(`\n═══ ① 真实 $DSH_HOME 分类体检 ═══\n源: ${SOURCE}\n`)
  const files = await walk(SOURCE, {
    ignore: (rel) => rel.startsWith('omnisync/') || /(?:session\.lock|\.DS_Store|migration)/u.test(rel),
  })
  const bySection = new Map()
  const unclassified = []
  let totalBytes = 0
  for (const f of files) {
    totalBytes += f.size
    const section = sectionForPath(f.rel, 'desktop')
    if (section === null) { unclassified.push(f.rel); continue }
    bySection.set(section.id, (bySection.get(section.id) ?? 0) + 1)
  }
  const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`
  console.log(`文件总数 ${files.length}（${mb(totalBytes)}），已识别 ${files.length - unclassified.length}，未识别 ${unclassified.length}\n`)

  console.log('按分区（命中文件数 / 该分区密级）：')
  for (const s of SECTIONS) {
    const n = bySection.get(s.id) ?? 0
    if (n === 0) continue
    console.log(`  ${n.toString().padStart(6)}  ${s.id.padEnd(22)} ${s.secretGroup === undefined ? '—' : '🔑 ' + s.secretGroup}`)
  }
  const zero = SECTIONS.filter((s) => (bySection.get(s.id) ?? 0) === 0 && s.id !== 'sessions')
  if (zero.length > 0) console.log(`\n本机未命中的分区（正常，说明该功能未使用）：${zero.map((s) => s.id).join(', ')}`)

  if (unclassified.length > 0) {
    console.log(`\n⚠ 未识别（**不会同步** —— 默认拒绝模型）共 ${unclassified.length} 项，前 20：`)
    const grouped = new Map()
    for (const rel of unclassified) {
      const top = rel.split('/').slice(0, 2).join('/')
      grouped.set(top, (grouped.get(top) ?? 0) + 1)
    }
    for (const [top, n] of [...grouped].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${n.toString().padStart(6)}  ${top}`)
    console.log('\n（逐条确认这些是否**应该**同步；漏掉的是隐患，多同步的是风险。）')
  } else {
    console.log('\n✓ 所有文件都被注册表识别')
  }
  return { files: files.length, unclassified: unclassified.length }
}

/* ─────────── ② 闭环验证 ─────────── */

async function loop() {
  console.log('\n═══ ② 端到端同步闭环（真实数据副本 + 本地裸仓）═══\n')
  const base = await mkdtemp(join(tmpdir(), 'omni-verify-'))
  const remote = join(base, 'remote.git')
  const homeA = join(base, 'homeA')
  const homeB = join(base, 'homeB')
  try {
    // 复制真实 home（排除超大/无意义目录，保持真实文件形态）。
    await run('git', ['init', '--bare', remote])
    await cp(SOURCE, homeA, {
      recursive: true, dereference: true,
      filter: (src) => !/node_modules|omnisync|\.git|agy-accounts|\/cache\//u.test(src),
    })
    await mkdir(homeB, { recursive: true })
    const filesA = await walk(homeA)
    console.log(`副本文件数 ${filesA.length}（真实形态，含 zstd 会话与 YAML patch）`)

    // A 机：镜像（含加密）→ 提交 → 推送。
    const gitA = backendFor(join(homeA, 'omnisync', 'repo'), remote)
    await gitA.schedule(() => gitA.bootstrap())
    const depsA = makeFsDeps({ dshHome: homeA, workTree: join(homeA, 'omnisync', 'repo'), backupRoot: join(homeA, 'omnisync', 'backups'), git: gitA })
    const secretGroups = Object.fromEntries(['providerKeys', 'mcpEnv', 'oauthGrants', 'pluginTokens', 'secretsDir', 'homeEnv'].map((g) => [g, true]))
    const ctxOf = (home, deps, git) => ({
      walk: () => deps.listLocal(''),
      read: (rel) => deps.readLocal(rel),
      writeTree: (rel, data) => deps.writeTree(rel, data),
      removeTree: (rel) => deps.removeTree(rel),
      listTree: () => deps.listTree(),
      readTree: (rel) => deps.readTree(rel),
      writeLocal: async (rel, data) => { await deps.writeLocal(rel, data, { mode: 0o600 }); return true },
      sectionOf: (rel) => sectionForPath(rel, 'desktop')?.id ?? null,
      secretGroupOf: (id) => {
        const g = SECTION_BY_ID.get(id)?.secretGroup
        return g === undefined || secretGroups[g] === false ? null : g
      },
      passphrase: PASSPHRASE,
    })

    const sealed = await applyToWorktree(ctxOf(homeA, depsA, gitA))
    console.log(`镜像：写入 ${sealed.changed} 项，跳过秘密 ${sealed.skipped} 项（无口令时只留本机）`)
    const commit = await gitA.schedule(() => gitA.commitAll('omnisync: verify push'))
    console.log(`提交：${commit === null ? '无变更' : commit.slice(0, 8)}`)
    await gitA.schedule(() => gitA.push())
    const { stdout: treeFiles } = await run('git', ['-C', join(homeA, 'omnisync', 'repo'), 'ls-files'])
    console.log(`推送成功，仓库内文件 ${treeFiles.trim().split('\n').filter(Boolean).length} 个`)

    // 秘密不得明文出门：全仓库扫描。
    const secretScan = await run('git', [
      '-C', join(homeA, 'omnisync', 'repo'), 'grep', '-I', '-l',
      '-e', 'sk-', '-e', 'tvly-', '-e', 'ghp_', '-e', 'AKIA', '-e', 'BEGIN PRIVATE KEY',
    ]).catch((e) => ({ stdout: e.stdout ?? '' }))
    const leaks = secretScan.stdout.trim().split('\n').filter((f) => f && f !== VAULT_FILE)
    console.log(leaks.length === 0
      ? '✓ 仓库内无明文密钥（密文袋除外）'
      : `⚠ 疑似明文密钥文件：${leaks.join(', ')}`)

    // B 机：克隆 → 应用。
    await run('git', ['clone', remote, join(homeB, 'omnisync', 'repo')])
    const gitB = backendFor(join(homeB, 'omnisync', 'repo'), remote)
    const depsB = makeFsDeps({ dshHome: homeB, workTree: join(homeB, 'omnisync', 'repo'), backupRoot: join(homeB, 'omnisync', 'backups'), git: gitB })
    const written = await applyToLocal(ctxOf(homeB, depsB, gitB))
    console.log(`B 机落地：${written} 个文件`)

    // 逐字节比对：从真实存在的已识别文件里动态抽样（不写死路径）。
    const candidates = (await walk(homeA)).map((f) => f.rel).filter((rel) => {
      const id = sectionForPath(rel, 'desktop')?.id
      return id !== undefined && id !== null && !rel.startsWith('sessions/') && !rel.startsWith('storages/session_projcache/')
    })
    const preferred = ['profiles/desktop/package.json', 'profiles/desktop/cordis.patch.yml', 'profiles/desktop/pnpm-lock.yaml']
    const sample = [...new Set([...preferred.filter((r) => candidates.includes(r)), ...candidates])].slice(0, 4)
    console.log(`抽样比对：${sample.join(' · ')}`)
    let identical = 0
    for (const rel of sample) {
      const a = await readFile(join(homeA, rel)).catch(() => null)
      const b = await readFile(join(homeB, rel)).catch(() => null)
      if (a === null || b === null) { console.log(`  ? ${rel} 缺失（A=${a !== null} B=${b !== null}）`); continue }
      if (a.equals(b)) { identical += 1; console.log(`  ✓ ${rel} 逐字节一致`) }
      else console.log(`  ✗ ${rel} 不一致（A ${a.length}B vs B ${b.length}B）`)
    }

    // 凭据：密文袋存在则必须解密还原（A 的明文 == B 的明文）。
    const credA = await readFile(join(homeA, '.credentials.yaml')).catch(() => null)
    const credB = await readFile(join(homeB, '.credentials.yaml')).catch(() => null)
    if (credA !== null) {
      console.log(credB !== null && credA.equals(credB)
        ? '  ✓ .credentials.yaml 解密还原逐字节一致'
        : `  ✗ 凭据还原失败（A=${credA.length}B B=${credB?.length ?? 'null'}）`)
    } else {
      console.log('  — 本机无 .credentials.yaml，跳过')
    }

    console.log(`\n${identical}/${sample.length} 抽样一致 · 镜像 ${sealed.changed} 项 · 落地 ${written} 项`)
    if (KEEP) console.log(`临时目录保留：${base}`)
    return { changed: sealed.changed, written, identical, sampled: sample.length, leaks: leaks.length }
  } finally {
    if (!KEEP) await rm(base, { recursive: true, force: true })
  }
}

const a = await audit()
const b = await loop()
console.log(`\n═══ 结论 ═══\n未识别文件 ${a.unclassified} 项 · 明文泄漏 ${b.leaks} 项 · 抽样一致 ${b.identical}/${b.sampled}`)
const ok = a.unclassified <= 40 && b.leaks === 0 && b.identical === b.sampled
console.log(ok ? '✓ 全部通过' : '✗ 有项目未通过')
process.exit(ok ? 0 : 1)
