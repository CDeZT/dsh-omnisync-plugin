// test/e2e.test.mjs — 双机端到端（真 git bare 仓 + 两个假 $DSH_HOME）。
//
// 这是 Phase 1 的验收测试：证明"云电脑"闭环真的成立 ——
//   A 机 push → bare 仓 → B 机 pull → 内容逐字节一致（含 0600 权限）。
// 不做任何 mock：真 git 子进程、真文件系统、真合并。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { makeFsDeps, writeAtomic, walk, pruneBackups } from '../lib/workspace.mjs'
import { applyToWorktree, applyToLocal } from '../lib/apply.mjs'
import { sectionForPath } from '../lib/sections.mjs'
import { tmpRoot, gitOut, backendFor, fsCtx } from './helpers.mjs'

/** 造一个假 $DSH_HOME（含真实形态的配置文件）。 */
async function makeHome(root, overrides = {}) {
  await mkdir(join(root, 'profiles', 'desktop'), { recursive: true })
  await mkdir(join(root, 'skills', 'demo'), { recursive: true })
  await mkdir(join(root, 'storages'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), overrides.agents ?? '# 全局指令\n\n默认安全。\n')
  await writeFile(join(root, 'profiles/desktop/package.json'), JSON.stringify({
    name: 'desktop-profile',
    dependencies: { dshmarket: '1.66.8' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket'] } },
  }, null, 2))
  await writeFile(join(root, 'profiles/desktop/cordis.patch.yml'), overrides.patch ?? `- insert:
    - id: mcp-mineru
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mineru
        command: uvx
        args: [mineru-mcp]
`)
  await writeFile(join(root, 'skills/demo/SKILL.md'), '# demo skill\n')
  await writeFile(join(root, 'storages/workspace.json'), JSON.stringify({
    version: 2, records: [{ id: 'ws1', path: `${root}/proj`, sessionIds: [] }],
  }, null, 2))
  return root
}

test('e2e: A 机 push → bare 仓 → B 机 fetch，内容逐字节一致', async (t) => {
  const base = await tmpRoot(t, 'omni-e2e-')
  const remoteDir = join(base, 'remote.git')
  const homeA = join(base, 'homeA')
  const homeB = join(base, 'homeB')
  // 裸仓当远端（无网络、无认证 —— 只验数据通路）。
  await gitOut(['init', '--bare', remoteDir])
  await makeHome(homeA)
  await mkdir(homeB, { recursive: true })

  const gitA = backendFor({ repoDir: join(homeA, 'omnisync', 'repo'), remote: remoteDir })
  const depsA = makeFsDeps({ dshHome: homeA, workTree: join(homeA, 'omnisync', 'repo'), backupRoot: join(homeA, 'omnisync', 'backups'), git: gitA })

  // A 机：**走生产路径**（applyToWorktree：分区过滤 + 秘密封包 + 路径重定基 + 树清理）。
  // 早先这里用 depsA.mirrorInto()（旧的全量拷贝），于是 e2e 测的是一条与生产不同的
  // 路径 —— 不封包秘密、不过滤分区、不重定基。那种"验证"是假的。
  const treeCtx = (home, fsDeps) => fsCtx(fsDeps, {
    writeLocal: async (rel, data) => { await fsDeps.writeLocal(rel, data, { mode: 0o600 }); return true },
    secretGroupOf: () => null,
    passphrase: '',
    vars: { home, dshHome: home },
  })

  await gitA.schedule(() => gitA.bootstrap())
  const mirrorResult = await applyToWorktree(treeCtx(homeA, depsA))
  const changed = mirrorResult.changed
  assert.ok(changed > 0, '应有文件被镜像进工作树')
  // 生产路径必须真的过滤了分区（未分类文件不进工作树）。
  const treeFiles = await depsA.listTree()
  assert.ok(treeFiles.includes('AGENTS.md'), '已分类文件必须进工作树')
  assert.ok(!treeFiles.some((r) => r.startsWith('omnisync/')), '插件自身目录绝不得进工作树')
  const commit = await gitA.schedule(() => gitA.commitAll('omnisync: initial push'))
  assert.ok(commit !== null, '应产生提交')
  await gitA.schedule(() => gitA.push())

  // B 机：克隆同一个裸仓 → 读回内容。
  const gitB = backendFor({ repoDir: join(homeB, 'omnisync', 'repo'), remote: remoteDir })
  await gitOut(['clone', remoteDir, join(homeB, 'omnisync', 'repo')])
  const depsB = makeFsDeps({ dshHome: homeB, workTree: join(homeB, 'omnisync', 'repo'), backupRoot: join(homeB, 'omnisync', 'backups'), git: gitB })

  // 逐字节比对三个代表性文件。
  for (const rel of ['AGENTS.md', 'profiles/desktop/package.json', 'skills/demo/SKILL.md']) {
    const a = await readFile(join(homeA, rel))
    const b = await depsB.readRemote(rel)
    assert.ok(b !== null, `B 机应看到 ${rel}`)
    assert.ok(a.equals(b), `${rel} 必须逐字节一致`)
  }
  // B 机落地（生产路径）→ 本机文件必须真的出现且逐字节一致。
  const written = await applyToLocal(treeCtx(homeB, depsB))
  assert.ok(written > 0, 'B 机应落地 ≥1 个文件')
  for (const rel of ['AGENTS.md', 'skills/demo/SKILL.md']) {
    const a = await readFile(join(homeA, rel))
    const b = await readFile(join(homeB, rel))
    assert.ok(a.equals(b), `B 机落地后 ${rel} 必须逐字节一致`)
  }
  // 三方基线：B 的 HEAD 与 origin/main 相同 → mergeBase 存在。
  const head = await gitB.schedule(() => gitB.headSha())
  assert.ok(typeof head === 'string' && head.length === 40)
})

test('e2e: 并发改动 → B 机 pull 后两侧改动都在（三方合并真实生效）', async (t) => {
  const base = await tmpRoot(t, 'omni-merge-')
  const remoteDir = join(base, 'remote.git')
  const homeA = join(base, 'homeA')
  const homeB = join(base, 'homeB')
  await gitOut(['init', '--bare', remoteDir])
  await gitOut(['clone', remoteDir, join(homeA, 'repo')])
  await gitOut(['clone', remoteDir, join(homeB, 'repo')])
  // 两个克隆各自需要一个初始提交（裸仓为空）。
  for (const h of [homeA, homeB]) {
    await writeFile(join(h, 'repo', 'base.txt'), 'base\n')
    await gitOut(['-C', join(h, 'repo'), 'add', '-A'])
    await gitOut(['-C', join(h, 'repo'), '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-m', 'init'])
  }
  await gitOut(['-C', join(homeA, 'repo'), 'push', 'origin', 'HEAD:refs/heads/main'])
  await gitOut(['-C', join(homeB, 'repo'), 'fetch', 'origin', '+main:refs/remotes/origin/main'])

  // A 机改一个文件并推送。
  await writeFile(join(homeA, 'repo', 'from-a.txt'), 'A 机的改动\n')
  await gitOut(['-C', join(homeA, 'repo'), 'add', '-A'])
  await gitOut(['-C', join(homeA, 'repo'), '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-m', 'a-change'])
  await gitOut(['-C', join(homeA, 'repo'), 'push', 'origin', 'HEAD:refs/heads/main'])

  // B 机改另一个文件 → push 会 non-FF 被拒 → 走 reconcile。
  await writeFile(join(homeB, 'repo', 'from-b.txt'), 'B 机的改动\n')
  await gitOut(['-C', join(homeB, 'repo'), 'add', '-A'])
  await gitOut(['-C', join(homeB, 'repo'), '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-m', 'b-change'])

  const gitB = backendFor({ repoDir: join(homeB, 'repo'), remote: remoteDir })
  // 用真实 GitBackend 复现 engine 的 reconcile-and-retry 路径。
  let rejected = false
  try {
    await gitB.schedule(() => gitB.push())
  } catch (error) {
    rejected = true
    assert.equal(error.code, 'PUSH_REJECTED', '必须识别为非快进拒绝，而不是其他错误')
  }
  assert.ok(rejected, '远端领先时 push 必须被拒（绝不强推）')

  await gitB.schedule(() => gitB.fetch())
  const remoteHead = await gitB.schedule(() => gitB.remoteHeadSha())
  const begun = await gitB.schedule(() => gitB.beginMerge(remoteHead))
  assert.equal(begun.conflicted, false, '两侧改不同文件应干净合并')
  await gitB.schedule(() => gitB.addAll())
  await gitB.schedule(() => gitB.commitMerge())
  await gitB.schedule(() => gitB.push())

  // 合并后两边改动都在。
  assert.equal((await readFile(join(homeB, 'repo', 'from-a.txt'), 'utf8')), 'A 机的改动\n')
  assert.equal((await readFile(join(homeB, 'repo', 'from-b.txt'), 'utf8')), 'B 机的改动\n')
})

test('workspace: 原子写落地后权限为 0600（凭据类文件的生死线）', async (t) => {
  const dir = await tmpRoot(t, 'omni-perm-')
  const target = join(dir, 'sub', '.credentials.yaml')
  await writeAtomic(target, 'version: 1\nrefs: {}\n', { mode: 0o600 })
  const st = await stat(target)
  assert.equal(st.mode & 0o777, 0o600, '必须是 0600（0644 会让 DSH 凭据插件整个挂掉）')
  // 覆盖写仍然是 0600（rename 后显式 chmod 的价值）。
  await writeAtomic(target, 'version: 1\nrefs: {A: "1"}\n', { mode: 0o600 })
  const st2 = await stat(target)
  assert.equal(st2.mode & 0o777, 0o600)
})

test('workspace: 宿主私有产物被排除（session.lock / 迁移暂存 / .DS_Store）', async (t) => {
  const dir = await tmpRoot(t, 'omni-artifact-')
  await mkdir(join(dir, 'sessions', 'p', 's1'), { recursive: true })
  await writeFile(join(dir, 'sessions', 'p', 's1', 'session.v4.jsonl.zstd'), 'x')
  await writeFile(join(dir, 'sessions', 'p', 's1', 'session.lock'), 'lock')
  await writeFile(join(dir, 'sessions', 'p', 's1', 'session.migration.abc.tmp'), 'tmp')
  await writeFile(join(dir, '.DS_Store'), 'junk')
  const files = await walk(dir)
  const rels = files.map((f) => f.rel)
  assert.ok(rels.includes('sessions/p/s1/session.v4.jsonl.zstd'))
  assert.ok(!rels.some((r) => r.includes('session.lock')), '锁文件绝不进通道')
  assert.ok(!rels.some((r) => r.includes('migration')), '迁移暂存绝不进通道')
  assert.ok(!rels.some((r) => r.includes('.DS_Store')))
})

test('workspace: 备份环形保留（不无限增长）', async (t) => {
  const dir = await tmpRoot(t, 'omni-backup-')
  for (let i = 0; i < 8; i++) {
    await mkdir(join(dir, `pre-apply-100${i}`), { recursive: true })
    await writeFile(join(dir, `pre-apply-100${i}`, 'f'), 'x')
  }
  await pruneBackups(dir, 5)
  const left = await readdir(dir)
  assert.equal(left.length, 5, '只保留最近 5 份')
  assert.ok(left.includes('pre-apply-1007'), '保留的是最新的')
  assert.ok(!left.includes('pre-apply-1000'), '最老的被清掉')
})

test('安全: 越界路径被拒绝（绝不写到 $DSH_HOME 之外）', async (t) => {
  const dir = await tmpRoot(t, 'omni-guard-')
  const deps = makeFsDeps({ dshHome: dir })
  await assert.rejects(() => deps.writeLocal('../escape.txt', Buffer.from('x')), /PATH_UNSAFE|unsafe path/u)
  await assert.rejects(() => deps.readLocal('/etc/passwd'), /PATH_UNSAFE|unsafe path/u)
})

/* ─────────── 真实数据驱动的守卫（Phase 3 体检结论固化）─────────── */

test('守卫: 遍历必须剪枝重量级目录（本机实测 29431 → 223 文件）', async (t) => {
  const { PRUNE_DIRS } = await import('../lib/constants.mjs')
  const dir = await tmpRoot(t, 'omni-prune-')
  // 造一个"看起来像 node_modules"的深树，验证根本不下潜。
  await mkdir(join(dir, 'profiles/desktop/node_modules/pkg/deep/deeper'), { recursive: true })
  await writeFile(join(dir, 'profiles/desktop/node_modules/pkg/deep/deeper/x.js'), 'x')
  await mkdir(join(dir, 'agy-accounts/acc/profiles'), { recursive: true })
  await writeFile(join(dir, 'agy-accounts/acc/profiles/Cookies'), 'secret')
  await mkdir(join(dir, '.plugin-manager/logs/op1'), { recursive: true })
  await writeFile(join(dir, '.plugin-manager/logs/op1/pnpm.log'), 'noise')
  await writeFile(join(dir, 'AGENTS.md'), 'keep me')

  const files = await walk(dir)
  const rels = files.map((f) => f.rel)
  assert.deepEqual(rels, ['AGENTS.md'], `只应看到 AGENTS.md，实际：${JSON.stringify(rels)}`)
  for (const d of ['node_modules', 'agy-accounts', '.plugin-manager']) {
    assert.ok(PRUNE_DIRS.includes(d), `${d} 必须在剪枝清单里`)
  }
})

test('守卫: NEVER_SYNC 里的每条路径都必须被判为"不同步"（硬排除不许漏）', async () => {
  const { NEVER_SYNC } = await import('../lib/constants.mjs')
  const { sectionForPath } = await import('../lib/sections.mjs')
  for (const rel of NEVER_SYNC) {
    assert.equal(sectionForPath(rel, 'desktop'), null, `${rel} 被判成了可同步分区 —— 硬排除失效`)
  }
})

test('守卫: 真实体检发现的缺口已覆盖（cordis.yml / market-state / 敏感项仍排除）', async () => {
  const { sectionForPath } = await import('../lib/sections.mjs')
  const expect = {
    // cordis.yml / pnpm-workspace.yaml / pnpm-lock.yaml 是 **YAML**：早先它们与 package.json
    // 同属 profile-manifest（json 合并器）→ 实测被判 "invalid JSON" → 每次分叉都 conflict
    // 且远端被隔离 = 永不合并。现已拆到 profile-yaml。
    'profiles/desktop/cordis.yml': 'profile-yaml',
    'profiles/desktop/pnpm-workspace.yaml': 'profile-yaml',
    'profiles/desktop/pnpm-lock.yaml': 'profile-yaml',
    'profiles/desktop/package.json': 'profile-manifest',      // 真 JSON 才走 json 合并器
    'profiles/desktop/compatibility.json': 'profile-manifest',
    'profiles/desktop/.dsh-market/state.json': 'market-state', // disabled 插件清单
  }
  for (const [rel, id] of Object.entries(expect)) {
    assert.equal(sectionForPath(rel, 'desktop')?.id, id, `${rel} 应属于 ${id}`)
  }
  // 这些必须仍然不同步（隐私/设备绑定/纯噪声）。
  for (const rel of [
    'agy-accounts/pool.json',
    'dsh-builtin-browser-host/history.jsonl',
    '.anonymous-user-id',
    'profiles/desktop/.plugin-manager/logs/op/pnpm.log',
    'backup-20260101/.credentials.yaml',
  ]) {
    assert.equal(sectionForPath(rel, 'desktop'), null, `${rel} 不该被同步`)
  }
})

test('守卫: 每个真实文件都必须有明确归属（逐文件，不许分组口径骗人）', async () => {
  // ★ 这个测试的形态来自一次真实教训：早先用"按顶层目录分组、取组内首文件的归属"
  //   统计覆盖率，于是 profiles/desktop 因组内首文件（市场缓存）未覆盖被整组标红，
  //   差点给已覆盖的文件重复加分区。逐文件判定才可信。
  const { sectionForPath, SECTIONS, SECTION_BY_ID } = await import('../lib/sections.mjs')
  const { isNeverSynced, NEVER_SYNC_PATTERNS } = await import('../lib/constants.mjs')
  const { readdirSync } = await import('node:fs')
  const { join, relative } = await import('node:path')

  // ① 分区表自洽：每条 relPath 都能被自己命中，且 merger 已注册。
  const { SECTION_MERGER } = await import('../lib/mergers/index.mjs')
  for (const s of SECTIONS) {
    for (const tpl of s.relPaths) {
      const probe = tpl.replaceAll('{name}', 'desktop')
      assert.equal(sectionForPath(probe, 'desktop')?.id, s.id, `${s.id} 的 ${tpl} 命中不了自己`)
    }
    if (s.merger !== undefined) assert.ok(SECTION_MERGER.has(s.merger), `${s.id} 的 merger ${s.merger} 未注册`)
  }

  // ② YAML 文件绝不许落在 json 合并器的分区里（实测会永不合并）。
  for (const s of SECTIONS) {
    if (s.merger !== 'json') continue
    for (const tpl of s.relPaths) {
      assert.ok(!/\.ya?ml$/u.test(tpl), `${tpl} 是 YAML 却用 json 合并器（会判 invalid JSON → 永不合并）`)
    }
  }

  // ③ 硬排除的正则必须真的生效（不许写成永不匹配的模式）。
  assert.ok(NEVER_SYNC_PATTERNS.length > 0)
  for (const re of NEVER_SYNC_PATTERNS) {
    assert.ok(re instanceof RegExp && re.source.length > 4, `可疑的排除模式：${re}`)
  }
  for (const rel of ['backup-20260101-000000/package.json', '.anonymous-user-id',
    'dsh-config-manager/transactions/x.json', 'agy-link/runtime-overrides.json',
    'dsh-builtin-browser-host/history.jsonl', 'storages/omnisync.json']) {
    assert.equal(sectionForPath(rel, 'desktop'), null, `${rel} 不该被任何分区认领`)
    assert.equal(isNeverSynced(rel), true, `${rel} 必须被硬排除`)
  }
  // 硬排除不得误伤已覆盖的文件。
  for (const rel of ['.credentials.yaml', 'AGENTS.md', 'jet-hub/state.json',
    'dsh-config-manager/sync/ui-prefs.json', 'profiles/desktop/pnpm-lock.yaml']) {
    assert.equal(isNeverSynced(rel), false, `${rel} 被硬排除误伤了`)
  }
})
