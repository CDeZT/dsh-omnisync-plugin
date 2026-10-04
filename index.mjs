// index.mjs — @cdezt/dsh-omnisync 插件入口（唯一 host 面文件）。
//
// 把 $DSH_HOME 的全量状态同步到 GitHub 私仓：配置 / 凭据（记录级合并）/
// skills / MCP / 附件 / 会话镜像。目标："任意一台机器都是同一个 desktop"。
//
// 分层：lib/ 零 DSH 依赖且可单测；本文件只做接线 —— 把宿主服务包成 deps
// 交给 lib，把 lib 的能力暴露成命令 / 工具 / HTTP 路由 / 定时器。
//
// 三条安全铁律（都有实测依据）：
//   ① PAT 只经 GIT_ASKPASS 脚本，且每条命令 `-c credential.helper=` 置空
//      （否则宿主 osxkeychain / Windows GCM 会顶掉 ASKPASS，GCM 还会弹窗挂死）；
//   ② 17 个 GIT_* 显式置空（GIT_DIR 会让 git 指向别处）；
//   ③ 落盘后无条件 chmod 0600（git 不存权限位，0644 会让 DSH 凭据插件挂掉）。

import { LIB_REV, PACKAGE_NAME, PLUGIN_NAME, STATE_KEY } from './lib/constants.mjs'
import { GitBackend, makeRunGit } from './lib/git.mjs'
import { Engine } from './lib/engine.mjs'
import { applyToWorktree, applyToLocal, ensureWorkspaceDirs } from './lib/apply.mjs'
import { mirrorSessions, applySessionsToLocal } from './lib/sessions.mjs'
import { landForks } from './lib/forks.mjs'
import { checkReferences, OBJECT_ROOT } from './lib/attachments.mjs'
import { prepareFolderRemote, assertFolderUsable, findConflictCopies, makeFolderBackendDeps } from './lib/backend-folder.mjs'
import { doctorText, makeHealth } from './lib/health.mjs'
import { mountCommand } from './lib/command.mjs'
import { mountTools } from './lib/tools.mjs'
import { mountRoutes } from './lib/routes.mjs'
import { makeConfirm } from './lib/gate.mjs'
import { makeRebuildDeps } from './lib/deps.mjs'
import { makeFsDeps } from './lib/workspace.mjs'
import { defaultUserDataDir, sectionForPath, sectionList, SECTION_BY_ID, SECTIONS } from './lib/sections.mjs'
import { emptyState, migrateState, deriveDeviceId, pushHistory, mergeSettings, applySettings, updateTombstones } from './lib/state.mjs'
import { resolveAll } from './lib/conflicts.mjs'
import { Config, omnisyncDomainSpec, resolveConfig, stateSchema } from './lib/config.mjs'
import { userHome } from './lib/paths.mjs'

// 对外 API 逐字不变：声明住在 lib/config.mjs，但宿主与守卫测试都从本文件取。
export { Config, omnisyncDomainSpec, resolveConfig, stateSchema }

/**
 * 插件身份 = **包名**（与前端 __ModuleLoader__ 的注册 ID 同一字符串）。
 * 参考实现多不导出 name，cordis 仅用它做诊断标签；但两半用同一个身份
 * 能消除一整类"ID 与包名不一致"的困惑（前端那半必须一致，见 test/mount）。
 */
export const name = PACKAGE_NAME
export const inject = ['subprocess', 'commands', 'storageDomain']

/* ─────────────── apply ─────────────── */

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return
  const log = (level, msg) => ctx.logger?.[level]?.call(ctx.logger, `${PLUGIN_NAME}: ${msg}`)

  // ★ 不要用 `process.env.HOME`：Windows 上是 USERPROFILE（HOME 常为空 →
  //   会推出 `/.dsh` 这种"当前盘根"下的错路径，且不报错）。见 paths.userHome。
  const dshHome = process.env.DSH_HOME ?? (userHome() === '' ? '' : `${userHome()}/.dsh`)
  const abs = (rel) => `${dshHome}/${rel}`
  // 口令来源：环境变量 > 本机 0600 文件（文件本身在 NEVER_SYNC 里，绝不上云）。
  // 用 getter 以便 UI 保存后立即生效，无需重启。
  let passphraseFileValue = ''
  const passphrase = () => process.env.OMNISYNC_PASSPHRASE || passphraseFileValue

  /* 状态 */
  let tablePromise
  ctx.effect(() => {
    const opened = ctx.storageDomain.open(omnisyncDomainSpec)
    tablePromise = opened.then((d) => d.table('state'))
    tablePromise.catch((e) => log('warn', `state domain failed: ${e?.message ?? e}`))
    return () => { void opened.then((d) => d.close()).catch(() => {}) }
  }, `${PLUGIN_NAME}.domain`)

  let stateCache = null
  const withState = async (fn) => {
    const table = await tablePromise
    // storageDomain 表 API：get() 同步、put() 异步（真机验证过的形态）。
    const state = migrateState(table.get(STATE_KEY) ?? emptyState())
    if (state.deviceId === null) state.deviceId = deriveDeviceId((await import('node:os')).hostname(), process.platform)
    const next = await fn(state)
    await table.put(STATE_KEY, next)
    stateCache = next
    return next
  }
  const state = async () => stateCache ?? withState(async (s) => s)

  /**
   * 把持久化偏好套进运行期 cfg。
   * ★ 必须在任何"读 cfg"之前跑一次：`disabled` 集合与 secretGroups 都是在 apply 期间
   *   按当时 cfg 快照算出来的，晚套 = 重启后开关显示开着、实际没生效。
   */
  const hydrateSettings = async () => {
    // 只读：启动时不该产生一次状态写入（withState 总会 put）。
    const st = migrateState((await tablePromise).get(STATE_KEY) ?? emptyState())
    applySettings(cfg, st.settings)
    disabled = new Set(cfg.disabledSections) // sectionOf 读的就是这个闭包集合 → 套用后必须重建
    return st
  }

  // 每轮最多扫描多少个会话做附件引用校验（会话是 34MB 量级，必须封顶）。
  const ATTACH_SCAN_LIMIT = 24

  /* 口令（env > 文件；文件 0600 且不同步） */
  const loadPassphrase = async () => {
    const fs = await import('node:fs/promises')
    try { passphraseFileValue = (await fs.readFile(abs(cfg.passphraseFile), 'utf8')).trim() } catch { passphraseFileValue = '' }
    return passphraseFileValue
  }
  const savePassphrase = async (value) => {
    await writeSelf(cfg.passphraseFile, value, 0o600)
    passphraseFileValue = value
  }

  /* token + askpass */
  const writeSelf = async (rel, data, mode = 0o600) => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    await fs.mkdir(path.dirname(abs(rel)), { recursive: true, mode: 0o700 })
    await fs.writeFile(abs(rel), data, { mode })
    if (process.platform !== 'win32') await fs.chmod(abs(rel), mode)
  }
  const askpassPath = async () => {
    const win = process.platform === 'win32'
    const tokenPath = abs(cfg.tokenFile)
    const body = win
      ? `@echo off\r\ntype "${tokenPath.replaceAll('/', '\\')}"\r\n`
      : `#!/bin/sh\ncase "$1" in *sername*) echo x-access-token ;; *) cat "${tokenPath}" ;; esac\n`
    await writeSelf(`omnisync/askpass.${win ? 'cmd' : 'sh'}`, body, 0o700)
    return abs(`omnisync/askpass.${win ? 'cmd' : 'sh'}`)
  }

  /* git 后端（配置流 + 会话镜像流） */
  const runner = async (args, runOpts = {}) => makeRunGit(ctx.subprocess, {
    gitBin: cfg.gitBin, timeoutMs: cfg.gitTimeoutMs, askpassPath: await askpassPath(),
  })(args, runOpts)
  // 文件夹后端：网盘里放一个 git 裸仓，`remote` 从 URL 换成本地绝对路径 ——
  // 三方合并/非 FF/墓碑/fork 全部复用 GitBackend，零新增合并逻辑。
  const folderDir = cfg.folderRemote.trim() === '' ? null : abs(cfg.folderRemote)
  const makeBackend = (dir, branch) => (folderDir === null
    ? new GitBackend({
      repoDir: abs(dir), remote: `https://github.com/${cfg.repo}.git`, branch,
      commitName: cfg.commitName, commitEmail: cfg.commitEmail, timeoutMs: cfg.gitTimeoutMs, run: runner,
    })
    : makeFolderBackendDeps({
      repoDir: abs(dir), remoteDir: folderDir, branch, run: runner,
      commitName: cfg.commitName, commitEmail: cfg.commitEmail, timeoutMs: cfg.gitTimeoutMs,
    }))

  const git = makeBackend(cfg.repoDir, cfg.branch)
  const mirrorGit = makeBackend(cfg.mirrorDir, cfg.mirrorBranch)

  /* 文件系统 deps */
  const fsDeps = makeFsDeps({
    dshHome, workTree: abs(cfg.repoDir), backupRoot: `${dshHome}/omnisync/backups`, backupKeep: cfg.backupKeep, git,
    // 外部根：keybindings 在 Electron userData 下（$DSH_HOME 之外），用 @userdata/ 前缀寻址。
    externalRoots: { '@userdata': defaultUserDataDir() },
  })
  const mirrorFs = makeFsDeps({ dshHome, workTree: abs(cfg.mirrorDir), backupRoot: `${dshHome}/omnisync/backups`, backupKeep: cfg.backupKeep, git: mirrorGit })

  // 分区开关：被关掉的分区等同"未分类" → 不进工作树（applyToWorktree 会跳过）。
  // 注册表驱动，所以新增分区自动出现在 UI 列表里，不需要改这里。
  let disabled = new Set(cfg.disabledSections)
  const sectionOf = (rel) => {
    const id = sectionForPath(rel, 'desktop')?.id ?? null
    return id !== null && disabled.has(id) ? null : id
  }
  const secretGroupOf = (sectionId) => {
    const group = SECTION_BY_ID.get(sectionId)?.secretGroup
    return group === undefined || cfg.secretGroups[group] === false ? null : group
  }
  // 树侧读写由 fsDeps 提供（锚定 workTree），本机侧锚定 dshHome —— 不再手工拼路径。
  const treeCtx = () => ({
    walk: () => fsDeps.listLocal(''),
    read: (rel) => fsDeps.readLocal(rel),
    writeTree: (rel, data) => fsDeps.writeTree(rel, data),
    removeTree: (rel) => fsDeps.removeTree(rel),
    listTree: () => fsDeps.listTree(),
    readTree: (rel) => fsDeps.readTree(rel),
    readLocal: (rel) => fsDeps.readLocal(rel),
    writeLocal: async (rel, data) => { await fsDeps.writeLocal(rel, data, { mode: 0o600 }); return true },
    // 写本机前自动备份（README 承诺；缺这两个能力时 applyToLocal 退化为 no-op）
    backupDir: (kind) => fsDeps.backupDir(kind),
    backupFile: (rel, dir) => fsDeps.backupFile(rel, dir),
    // 工作区目录自动创建（绝对路径，不经 $DSH_HOME 收口 —— 它本就在外面）
    exists: async (p) => (await import('node:fs/promises')).access(p).then(() => true, () => false),
    mkdir: async (p) => { await (await import('node:fs/promises')).mkdir(p, { recursive: true }); return true },
    sectionOf, secretGroupOf, passphrase: passphrase(),
    vars: { home: userHome(), dshHome }, // 路径重定基用的变量（Windows 上 HOME 为空会让重定基写坏路径）
    logger: { warn: (m) => log('warn', m) },
  })

  /* 冲突裁决：git 报冲突的路径交给 lib/conflicts.mjs 按分区策略处理 */
  const resolveConflicts = async () => {
    const result = await resolveAll({
      git, sectionOf, deviceId: () => stateCache?.deviceId ?? 'unknown0',
      writeTree: (rel, data) => fsDeps.writeTree(rel, data),
      removeTree: (rel) => fsDeps.removeTree(rel), // 删除裁决：远端删了 → 本机树也要删
      tombstones: stateCache?.tombstones ?? {}, // 防"删掉的凭据被另一台机器复活"
      logger: { warn: (m) => log('warn', m) },
    })
    if (result.deleted.length > 0) {
      await withState(async (s) => { s.tombstones = updateTombstones(s.tombstones, result.deleted, Date.now()); return s })
    }
    // fork 必须落在**本机**：否则用户不知道发生过冲突，也取不回远端版本。
    // 挂在 resolveConflicts（而非 applyToLocal）—— push 路径根本没有 applyToLocal。
    await landForksSafely(result.forks, {
      readTree: (rel) => fsDeps.readTree(rel),
      writeLocal: async (rel, data) => { await fsDeps.writeLocal(rel, data, { mode: 0o600 }); return true },
      existsLocal: async (rel) => (await fsDeps.readLocal(rel)) !== null,
    })
    return result
  }

  /**
   * 附件引用完整性：会话引用了某个对象，而它既不在本机也不在工作树 → **响亮上报**。
   *
   * 为什么用 strict：宽版会把散文里的对象路径当引用，而"缺引用"是硬失败 ——
   * 一次散文误报就等于**同步永久卡死**。strict 是实测到的生产者形态
   * （`attachmentId: "sha256:<64hex>"`），窄而准。
   * 为什么只在 written>0 时跑：会话是 34MB 的 zstd，每轮白解压不值当。
   * 为什么只 warn 不抛：误报会让用户再也同步不了；而漏报只是"附件可能缺"，
   * 已由体检报告与日志留痕。宁可吵，不可卡死。
   */
  const verifyAttachmentRefs = async () => {
    try {
      const rels = (await fsDeps.listLocal('sessions')).map((f) => f.rel).slice(0, ATTACH_SCAN_LIMIT)
      const blobs = (await Promise.all(rels.map(async (rel) => ({ rel, data: await fsDeps.readLocal(rel) })))).filter((b) => b.data !== null)
      if (blobs.length === 0) return
      const r = await checkReferences({
        listLocal: async () => (await fsDeps.listLocal(OBJECT_ROOT)).map((f) => f.rel),
        listTree: async () => (await fsDeps.listTree()).filter((rel) => rel.startsWith(OBJECT_ROOT)),
        blobs, strict: true,
      })
      if (r.missing.length > 0) log('warn', `attachment refs missing (${r.missing.length}): ${r.missing.slice(0, 3).join(', ')}`)
    } catch (error) {
      log('warn', `attachment ref check skipped: ${error?.message ?? error}`)
    }
  }

  /** fork 落地失败不得拖垮整轮（但必须留痕，绝不假装没冲突）。 */
  const landForksSafely = async (forks, ctx) => {
    if (forks.length === 0) return
    try {
      const r = await landForks(ctx, forks)
      if (r.missing.length > 0) log('warn', `${r.missing.length} fork(s) missing in tree (upstream did not write them)`)
    } catch (error) {
      log('warn', `fork landing failed: ${error?.message ?? error}`)
    }
  }

  /* 引擎 */
  const engine = new Engine({
    now: () => Date.now(),
    git,
    deviceId: () => stateCache?.deviceId ?? 'unknown0',
    mirror: async () => (await applyToWorktree(treeCtx())).changed,
    applyToLocal: async () => {
      const written = await applyToLocal(treeCtx())
      // 新机器上工作区目录往往还不存在 —— 落地后补建（否则工作区打不开）。
      const created = await ensureWorkspaceDirs(treeCtx())
      if (created.length > 0) log('info', `created ${created.length} workspace dir(s)`)
      if (written > 0 && cfg.syncAttachments) await verifyAttachmentRefs()
      return written
    },
    // 干跑：同一套落地逻辑，writeLocal 只计数不落盘。确认门必须在**写之前**
    // 问，而"将写几个文件"只有走一遍 apply 才知道 —— 另抄一份过滤逻辑必然漂移。
    previewLocal: async () => {
      let n = 0
      await applyToLocal({ ...treeCtx(), writeLocal: async () => { n += 1; return true } })
      return n
    },
    confirm: makeConfirm({ ctx, cfg, state, withState }),
    resolveConflicts,
  })

  /**
   * 会话流 = **同一个 Engine 类的第二个实例**（独立分支）。
   * 双向是免费的：Engine 本就同时具备推与拉两条路径。
   */
  const sessionEngine = new Engine({
    now: () => Date.now(),
    git: mirrorGit,
    deviceId: () => stateCache?.deviceId ?? 'unknown0',
    mirror: async () => mirrorSessions({
      walkAll: () => mirrorFs.listLocal(''),
      readLocal: (rel) => fsDeps.readLocal(rel),
      writeTree: (rel, data) => mirrorFs.writeTree(rel, data),
    }),
    applyToLocal: async () => applySessionsToLocal({
      listTree: () => mirrorFs.listTree(),
      readTree: (rel) => mirrorFs.readTree(rel),
      readLocal: (rel) => fsDeps.readLocal(rel),
      writeLocal: async (rel, data) => { await fsDeps.writeLocal(rel, data, { mode: 0o600 }); return true },
      // ★ base 是"上一轮同步时的本机内容"。缺它只能"树优先"，会拿上一轮的树覆盖本机
      //   本轮新增的对话 —— 真实可达：`omnisync pull`（pull 模式不跑 mirror），以及 sync
      //   模式下远端领先的任何一轮（引擎先 pull 后 push）。那是**静默丢字节**。
      base: (rel) => mirrorFs.base(rel),
      // 双方都改时把远端版本转 fork（缺省也能跑，但 fork 名会退化成 unknown0）
      deviceId: () => stateCache?.deviceId ?? 'unknown0',
      now: () => Date.now(),
      // 会话写前备份（大文件策略在 sessions.mjs 内，见其注释）
      backupDir: (kind) => fsDeps.backupDir(kind),
      backupFile: (rel, dir) => fsDeps.backupFile(rel, dir),
      logger: { warn: (m) => log('warn', m) },
    }),
    confirm: async () => true, // 会话落地不额外打扰（已由配置流的确认覆盖）
    resolveConflicts: () => resolveAll({
      git: mirrorGit, sectionOf: () => 'sessions', deviceId: () => stateCache?.deviceId ?? 'unknown0',
      writeTree: (rel, data) => mirrorFs.writeTree(rel, data),
      removeTree: (rel) => mirrorFs.removeTree(rel), tombstones: {},

      logger: { warn: (m) => log('warn', m) },
    }),
  })

  const recordRun = async (report) => withState(async (s) => {
    s.lastError = report.error === undefined ? null : { code: report.error.code, message: String(report.error.message).slice(0, 2000), at: Date.now() }
    s.history = pushHistory(s.history, { trigger: report.trigger, pushed: report.pushed ?? 0, pulled: report.pulled ?? 0, error: report.error?.code })
    if (report.error === undefined) { s.lastSyncedAt = Date.now(); s.backoffUntil = 0 } else { s.backoffUntil = Date.now() + (report.retryInMs ?? 0) }
    return s
  })

  /** 体检报告的采集/落盘/回读（渲染在 lib/health.mjs 的纯函数里）。 */
  const health = makeHealth({ state, cfg, fsDeps, version: LIB_REV, sectionOf, runGit: (args) => runner(args) })

  /** 文件夹后端的开跑前门（探测 + 冲突副本报告）。 */
  const gateFolderRemote = async () => {
    if (folderDir === null) return
    // ★ allowInit 只在**本机首轮**为真。云盘客户端还没把对端裸仓同步下来时，
    //   目录可能"存在但空" —— 此时抢建空仓 = 与对端**分叉**（两边各自成为根，
    //   之后再也合不到一起）。本机已有仓说明不是首轮 → 宁可拒绝，让用户等同步完成。
    const { existsSync } = await import('node:fs')
    const firstRound = !existsSync(abs(`${cfg.repoDir}/.git`))
    await prepareFolderRemote(folderDir, { run: runner, branch: cfg.branch, allowInit: firstRound })
    await assertFolderUsable(folderDir) // 失败 → BACKEND_UNSUPPORTED，tick 记 warn，零写入
    const copies = await findConflictCopies(folderDir)
    if (copies.length > 0) log('warn', `cloud conflict copies (需手动清理): ${copies.map((c) => c.name).join(', ')}`)
  }

  const runSync = async (mode, trigger) => {
    // 报告先落本机（随后随镜像一起上云）。
    await health.write().catch((e) => log('warn', `health report failed: ${e?.message ?? e}`))
    await gateFolderRemote()
    await git.schedule(() => git.bootstrap())
    const report = await engine.run({ mode, trigger })
    // 会话是附加能力：失败只记警告，绝不影响配置流的结论。
    if (cfg.syncSessions && report.error === undefined) {
      try {
        await mirrorGit.schedule(() => mirrorGit.bootstrap())
        const sr = await sessionEngine.run({ mode, trigger: `${trigger}+sessions` })
        report.sessions = { pushed: sr.pushed ?? 0, pulled: sr.pulled ?? 0, error: sr.error?.code ?? null }
        if (sr.error !== undefined) log('warn', `session sync failed: ${sr.error.code} ${sr.error.message}`)
      } catch (error) {
        log('warn', `session sync skipped: ${error?.message ?? error}`)
      }
    }
    await recordRun(report)
    return report
  }

  const commandApi = {
    engine, git, state, cfg, runSync,
    repo: () => cfg.repo,
    doctor: () => doctorText(health.write, health.readAll),
  }

  if (cfg.registerCommand) mountCommand(ctx, commandApi)
  if (cfg.registerTools) mountTools(ctx, { cfg, state, engine, runSync })
  mountRoutes(ctx, {
    engine, state, cfg,
    repo: () => cfg.repo,
    setRepo: (r) => { cfg.repo = r },
    // 分区开关（注册表驱动：新增分区自动出现在 UI 列表里）
    sections: () => sectionList().map((s) => ({ ...s, enabled: !cfg.disabledSections.includes(s.id) })),
    setDisabledSections: async (ids) => {
      // 只接受真实分区 id（挡住拼错/恶意值污染配置）
      const known = new Set(SECTIONS.map((s) => s.id))
      cfg.disabledSections = [...new Set(ids)].filter((id) => known.has(id))
      await withState(async (st) => { applySettings(cfg, mergeSettings(st, { disabledSections: cfg.disabledSections })); return st })
      return cfg.disabledSections
    },
    passphraseConfigured: () => passphrase() !== '',
    passphraseFromEnv: () => (process.env.OMNISYNC_PASSPHRASE ?? '') !== '',
    savePassphrase,
    runSync,
    writeToken: (token) => writeSelf(cfg.tokenFile, token),
    verify: () => git.schedule(() => git.bootstrap()),
    // 偏好落盘 + 立即套用到运行期配置（唯一写入点）。
    // ★ withState 落盘的必须是**完整状态**：旧实现返回
    //   applySettings(cfg,…).secretGroups，于是整行状态被一个分组对象覆盖，
    //   下一次 migrateState 判定版本不符 → 设备身份/墓碑/历史静默全量重置。
    remember: async (patch) => {
      await withState(async (st) => { applySettings(cfg, mergeSettings(st, patch)); return st })
      // 回包给 UI 的必须是**生效后的全量分组**（applySettings 已把补丁并进 cfg）。
      return cfg.secretGroups
    },
    rebuildDeps: makeRebuildDeps({ ctx, manifestPath: abs('profiles/desktop/package.json'), logger: { warn: (m) => log('warn', m) } }),
  })

  void hydrateSettings().then(() => { if (cfg.disabledSections.length > 0) log('info', `${cfg.disabledSections.length} section(s) disabled by preference`) })
  void loadPassphrase().then((v) => { if (v !== '') log('info', 'passphrase loaded from file') })

  /* 调度：启动延迟 + 定时（全部走 ctx.effect 可逆） */
  ctx.effect(() => {
    const timers = []
    const tick = async (trigger) => {
      if (Date.now() < (stateCache?.backoffUntil ?? 0)) return
      try { await runSync('sync', trigger) } catch (error) { log('warn', `${trigger} sync failed: ${error?.message ?? error}`) }
    }
    void state().then((s) => {
      applySettings(cfg, s.settings) // 持久化偏好覆盖配置（重启后仍生效）
      if (cfg.repo === '') return
      timers.push(setTimeout(() => { void tick('startup') }, cfg.startupDelaySeconds * 1000))
      if (cfg.intervalMinutes > 0) timers.push(setInterval(() => { void tick('interval') }, cfg.intervalMinutes * 60_000))
    }).catch((e) => log('warn', `settings init failed: ${e?.message ?? e}`))
    return () => { for (const timer of timers) { clearTimeout(timer); clearInterval(timer) } }
  }, `${PLUGIN_NAME}.schedule`)

  log('info', `mounted v${LIB_REV} (repo=${cfg.repo || '<unconfigured>'}, confirm=${cfg.confirmLevel}, interval=${cfg.intervalMinutes}m)`)
}
