// lib/git.mjs — git 命令层（零 DSH 依赖；runner 由 index.mjs 注入）。
//
// 安全边界（每条都有实证依据，见 research/git传输层设计.md）：
// - 动词白名单 + 参数断言（运行时强制，防未来改坏）；
// - 绝不 force push；绝不 reset/clean/rebase；checkout 只许 --ours/--theirs+显式路径；
// - PAT 注入走 GIT_ASKPASS 临时脚本（token 不进 argv、不进 .git/config）；
//   ★ credential.helper 必须显式置空 —— 宿主机的 osxkeychain / Windows GCM
//   会优先于 ASKPASS（gitcredentials(7)：ASKPASS 是"没有任何 helper 时"的
//   兜底），GCM 无人值守会弹窗挂死；
// - GIT_* 环境清洗：GIT_DIR 等会关闭仓库发现并让 git 指向别处 ——
//   17 个变量显式置空后再注入本插件自己的；
// - Windows MSYS 路径转换防护只在子进程注入（不写全局）；
// - 错误消息嵌入前统一 redactText（git stderr 可能回显 remote 地址）。
//
// runner 契约（index.mjs 构造）：
//   run(args, { cwd, signal, timeoutMs, binary, maxBytes }) → { code, stdout, stderr }
//   binary=true 时 stdout 为 Buffer（原始字节，cat-file blob 用）。

import { redactText } from './sanitize.mjs'
import { LIMITS } from './constants.mjs'
import { gitFailed, pushRejected, authBlocked } from './errors.mjs'

/** 允许的顶层动词。 */
export const ALLOWED_VERBS = new Set([
  'init', 'config', 'remote', 'add', 'commit', 'push', 'fetch', 'merge', 'merge-base',
  'rev-parse', 'log', 'diff', 'cat-file', 'show', 'checkout', 'ls-files', 'ls-tree',
  'update-ref', 'status', 'worktree',
])

/** GIT_* 环境清洗清单（显式置空——置空而非删除，防止继承污染）。 */
export const GIT_ENV_SCRUB = Object.freeze([
  // ── 可以安全置空的（实测：置空后 git 一切正常，且能中和父进程的继承）──
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM',
  'GIT_GRAFTS', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS', 'GIT_MERGE_VERBOSITY', 'GIT_LFS_SKIP_SMUDGE',
])

/**
 * **绝不能置空**的 git 环境变量（置空 = 弄坏 git，而不是"中和"）。
 *
 * 为什么单列一张表：DSH 的 subprocess 是**合并**语义（父环境清洗后再叠加调用方的 env），
 * 所以调用方**删不掉**继承来的变量，只能选择"设成什么"。而"设成空串"对这些**路径型**
 * 变量不是中和，是喂给它一个非法路径。实测（`git status --porcelain`，逐变量）：
 *
 *   GIT_DIR=''                  → fatal: not a git repository: ''
 *   GIT_WORK_TREE=''            → fatal: The empty string is not a valid path   ← 线上就是这个
 *   GIT_OBJECT_DIRECTORY=''     → fatal: not a git repository
 *   GIT_COMMON_DIR=''           → fatal: not a git repository
 *   GIT_INDEX_FILE=''           → **不报错**，但索引变成空 → 所有文件显示为已删除
 *                                 （`D a.txt`）。最危险的一个：会让插件提交一次大规模误删。
 *
 * 对它们的正确做法是**不碰** —— 父进程若真的设了，那是父进程的环境决定，
 * 与任何普通 CLI 工具的行为一致；我们不该用"置空"去假装中和。
 */
export const GIT_ENV_FORBIDDEN = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
])

/** 断言命令是白名单内的安全原语（绝不 force/改历史/切分支）。 */
export function assertSafe(args) {
  const verb = args[0] ?? ''
  if (!ALLOWED_VERBS.has(verb)) {
    throw gitFailed('assert', `forbidden git verb ${JSON.stringify(verb)} (whitelist violation)`)
  }
  for (const arg of args.slice(1)) {
    // push 永不强制；commit 永不改写历史。
    if (arg === '-f' || arg === '--force' || arg === '--force-with-lease' || arg === '--mirror' || arg.startsWith('+')) {
      if (verb === 'push' || verb === 'fetch') {
        // fetch 的 +refspec 是唯一例外（只影响跟踪引用，绝不触碰工作树）。
        if (verb === 'fetch' && arg.startsWith('+')) continue
        throw gitFailed('assert', `git ${verb} argument ${JSON.stringify(arg)} is forbidden`)
      }
    }
  }
  if (verb === 'checkout' && !(args.includes('--ours') || args.includes('--theirs'))) {
    throw gitFailed('assert', 'git checkout is only allowed with --ours/--theirs (no branch switching)')
  }
  if (verb === 'merge' && !(args.includes('--no-commit') || args.includes('--abort'))) {
    throw gitFailed('assert', 'git merge is only allowed with --no-commit or --abort')
  }
  if (verb === 'commit' && args.includes('--amend')) {
    throw gitFailed('assert', 'git commit --amend is forbidden (history is append-only)')
  }
}

/** 认证/网络失败的错误分流（决定退避策略与用户提示）。 */
export function classifyGitFailure(stderr) {
  const text = String(stderr ?? '')
  if (/Authentication failed|403|could not read Username|terminal prompts disabled/i.test(text)) {
    return authBlocked('push-auth')
  }
  return null
}

/**
 * git 同步后端。所有命令串行经内部互斥链执行（每仓库一把）。
 */
export class GitBackend {
  /** @type {(args: string[], opts?: object) => Promise<{code: number, stdout: string|Buffer, stderr: string}>} */
  #run
  #repoDir
  #remote
  #branch
  #commitName
  #commitEmail
  #chain = Promise.resolve()
  #timeoutMs

  /**
   * @param {object} deps - { repoDir, remote, branch, commitName, commitEmail, run, timeoutMs }。
   */
  constructor(deps) {
    this.#run = deps.run
    this.#repoDir = deps.repoDir
    this.#remote = deps.remote
    this.#branch = deps.branch
    this.#commitName = deps.commitName ?? 'dsh-omnisync'
    this.#commitEmail = deps.commitEmail ?? 'omnisync@localhost'
    this.#timeoutMs = deps.timeoutMs ?? LIMITS.MAX_OUTPUT_BYTES
  }

  /** 串行执行：同一仓库的所有操作按序排队。 */
  schedule(fn) {
    const run = this.#chain.then(fn, fn)
    this.#chain = run.then(() => undefined, () => undefined)
    return run
  }

  async #git(args, opts = {}) {
    assertSafe(args)
    try {
      return await this.#run(args, {
        cwd: this.#repoDir,
        binary: opts.binary ?? false,
        timeoutMs: opts.timeoutMs ?? this.#timeoutMs,
        signal: opts.signal,
      })
    } catch (error) {
      throw gitFailed(args[0] ?? 'git', redactText(error instanceof Error ? error.message : String(error)))
    }
  }

  async #must(args, opts = {}) {
    const result = await this.#git(args, opts)
    if (result.code !== 0) {
      const auth = classifyGitFailure(result.stderr)
      if (auth !== null) throw auth
      const tail = redactText(String(result.stderr ?? '')).trim().split('\n').slice(-3).join(' | ') || `exit ${result.code}`
      throw gitFailed(args[0] ?? 'git', tail)
    }
    return result
  }

  /**
   * `#maybe` + 取 sha：4 处调用点原本各写一遍"空则 undefined"。
   * git 在 ref 不存在时返回非零，`#maybe` 给 null —— 这里统一收敛成 undefined，
   * 调用方只需判 `=== undefined`。
   */
  async #maybeSha(args) {
    const out = await this.#maybe(args)
    const sha = out === null ? '' : String(out.stdout).trim()
    return sha === '' ? undefined : sha
  }

  /** 取 stdout 的非空行（git 输出普遍是行列表）。 */
  #lines(out) {
    return String(out.stdout ?? '').split('\n').filter((l) => l.trim() !== '')
  }

  async #maybe(args, opts = {}) {
    const result = await this.#git(args, opts)
    return result.code === 0 ? result : null
  }

  async isRepo() {
    const out = await this.#maybe(['rev-parse', '--is-inside-work-tree'])
    return out !== null && String(out.stdout).trim() === 'true'
  }

  /** 本地初始化（字节镜像必须逐字节保真：autocrlf 关闭）。 */
  async ensureRepo() {
    if (!(await this.isRepo())) {
      // 仓库目录可能尚不存在（首次引导）—— 先建目录，否则 git init 报 ENOENT。
      const fs = await import('node:fs/promises')
      await fs.mkdir(this.#repoDir, { recursive: true, mode: 0o700 })
      await this.#must(['init', '-b', this.#branch])
    }
    await this.#must(['config', 'core.autocrlf', 'false'])
    await this.#must(['config', 'user.name', this.#commitName])
    await this.#must(['config', 'user.email', this.#commitEmail])
  }

  /** 引导：init → remote（增/改）→ 初始提交。幂等。 */
  async bootstrap() {
    await this.ensureRepo()
    const current = await this.#maybe(['remote', 'get-url', 'origin'])
    if (current === null) await this.#must(['remote', 'add', 'origin', this.#remote])
    else if (String(current.stdout).trim() !== this.#remote.trim()) await this.#must(['remote', 'set-url', 'origin', this.#remote])
    if ((await this.headSha()) === undefined) await this.commitAll('omnisync: initial commit', { allowEmpty: true })
  }

  async headSha() {
    return this.#maybeSha(['rev-parse', '--verify', 'HEAD'])
  }

  async remoteHeadSha() {
    return this.#maybeSha(['rev-parse', '--verify', `refs/remotes/origin/${this.#branch}`])
  }

  async refSha(ref) {
    return this.#maybeSha(['rev-parse', '--verify', ref])
  }

  async mergeBaseOf(left, right) {
    return this.#maybeSha(['merge-base', left, right])
  }

  /** 工作树全量提交（add -A → 有变更才 commit）。返回新 HEAD 或 null。 */
  async commitAll(message, opts = {}) {
    await this.#must(['add', '-A'])
    const status = await this.#must(['status', '--porcelain'])
    if (String(status.stdout).trim() === '' && !(opts.allowEmpty ?? false)) return null
    await this.#must(['commit', '-m', message.slice(0, LIMITS.MAX_COMMIT_MESSAGE_LENGTH), ...(opts.allowEmpty === true ? ['--allow-empty'] : [])])
    return this.headSha() ?? null
  }

  /** push（被拒=远端领先→PUSH_REJECTED，绝不重试强推）。 */
  async push(opts = {}) {
    const result = await this.#git(['push', 'origin', `HEAD:refs/heads/${this.#branch}`], { signal: opts.signal })
    if (result.code !== 0) {
      const auth = classifyGitFailure(result.stderr)
      if (auth !== null) throw auth
      throw pushRejected(redactText(String(result.stderr ?? '')).trim().split('\n').slice(-3).join(' | ') || `exit ${result.code}`)
    }
    // 成功的 push 响应头里可能带 token 过期信息 —— 提取给调用方做倒计时。
    return { tokenExpiry: parseTokenExpiry(String(result.stderr ?? '') + String(result.stdout ?? '')) }
  }

  /** fetch 到跟踪引用（绝不触碰工作树）。远端无分支（首次）返回 false。 */
  async fetch(opts = {}) {
    const result = await this.#git(['fetch', 'origin', `+${this.#branch}:refs/remotes/origin/${this.#branch}`], { signal: opts.signal })
    if (result.code === 0) return true
    const stderr = String(result.stderr ?? '')
    if (/couldn't find remote ref/i.test(stderr)) return false
    const auth = classifyGitFailure(stderr)
    if (auth !== null) throw auth
    throw gitFailed('fetch', redactText(stderr).trim().split('\n').slice(-3).join(' | ') || `exit ${result.code}`)
  }

  /** 开始合并（--no-commit；首拉的无关历史合并允许）。 */
  async beginMerge(remoteHead) {
    const result = await this.#git(['merge', '--no-commit', '--allow-unrelated-histories', remoteHead])
    if (result.code === 0) {
      // ★ "Already up to date." 走 **stdout**（git 只把冲突/警告写 stderr）——
      //   只看 stderr 会把空合并误报成"合并进行中"，让上层多提交一次空合并。
      const text = `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`
      if (/already up to date/i.test(text)) return { conflicted: false, inProgress: false }
      return { conflicted: false, inProgress: true }
    }
    const inProgress = await this.mergeInProgress()
    return { conflicted: inProgress, inProgress }
  }

  async mergeInProgress() {
    const out = await this.#maybe(['rev-parse', '--verify', 'MERGE_HEAD'])
    return out !== null && String(out.stdout).trim() !== ''
  }

  async abortMerge() {
    if (!(await this.mergeInProgress())) return
    await this.#must(['merge', '--abort'])
  }

  /** 冲突路径（ls-files -u：stage 1=base 2=ours 3=theirs）。 */
  async conflictedPaths() {
    const out = await this.#must(['ls-files', '-u'])
    const byPath = new Map()
    for (const line of String(out.stdout).split('\n')) {
      if (line.trim() === '') continue
      const [meta, ...rest] = line.split('\t')
      const rel = rest.join('\t')
      const stage = (meta ?? '').split(/\s+/)[2]
      let entry = byPath.get(rel)
      if (entry === undefined) { entry = { path: rel }; byPath.set(rel, entry) }
      if (stage === '1') entry.base = (meta ?? '').split(/\s+/)[1]
      else if (stage === '2') entry.ours = (meta ?? '').split(/\s+/)[1]
      else if (stage === '3') entry.theirs = (meta ?? '').split(/\s+/)[1]
    }
    return [...byPath.values()]
  }

  /** 读索引阶段 blob 原始字节。 */
  async readStageBlob(stage, rel) {
    const out = await this.#maybe(['cat-file', 'blob', `:${stage}:${rel}`], { binary: true })
    if (out === null) return undefined
    return Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(String(out.stdout))
  }

  async checkoutStage(which, rel) {
    await this.#must(['checkout', `--${which}`, '--', rel])
  }

  async addAll() { await this.#must(['add', '-A']) }

  async commitMerge() {
    if (!(await this.mergeInProgress())) return null
    await this.#must(['commit', '--no-edit'])
    return this.headSha() ?? null
  }

  async recentCommits(limit) {
    const out = await this.#maybe(['log', '--oneline', `-n${Math.max(1, Math.floor(limit))}`])
    return out === null ? [] : this.#lines(out)
  }

  async dirtyLines() {
    return this.#lines(await this.#must(['status', '--porcelain', '-uall']))
  }

  async lsFiles() {
    return this.#lines(await this.#must(['ls-files']))
  }

  /** 读任意提交里的文件字节（git show <ref>:<path>）。 */
  async readBlob(ref, rel) {
    const out = await this.#maybe(['show', `${ref}:${rel}`], { binary: true })
    if (out === null) return undefined
    return Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(String(out.stdout))
  }
}

/** 从 git 输出解析 GitHub PAT 过期头（响应头形态嵌在 stderr/stdout 文本里）。 */
export function parseTokenExpiry(text) {
  const m = /GitHub-Authentication-Token-Expiration:\s*([0-9TZ:.-]+)/iu.exec(text)
  if (m === null) return undefined
  const t = Date.parse(m[1])
  return Number.isNaN(t) ? undefined : t
}

/**
 * git runner：ASKPASS + 环境清洗 + Windows MSYS 防护（token 绝不进 argv）。
 * @param {object} subprocess - ctx.subprocess。
 * @param {object} opts - { gitBin, timeoutMs, askpassPath }。
 */
export function makeRunGit(subprocess, opts) {
  return async (args, runOpts = {}) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('git timeout')) }, opts.timeoutMs)
    const onAbort = () => controller.abort(new Error('aborted'))
    runOpts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const executable = await subprocess.resolveExecutable(opts.gitBin, undefined, controller.signal)
      const handle = subprocess.spawn({
        // `-c credential.helper=` 必须先于动词：否则宿主 helper 顶掉 ASKPASS。
        argv: [executable, '-c', 'credential.helper=', ...args],
        cwd: runOpts.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: runOpts.binary === true ? 'pipe' : { maxBytes: LIMITS.MAX_OUTPUT_BYTES },
          stderr: { maxBytes: LIMITS.MAX_OUTPUT_BYTES },
        },
        graceMs: 2000,
        signal: controller.signal,
        env: {
          ...Object.fromEntries(GIT_ENV_SCRUB.map((k) => [k, ''])),
          GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
          GIT_ASKPASS: opts.askpassPath, GIT_ASKPASS_REQUIRE: 'force',
          GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never',
          ...(process.platform === 'win32' ? { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } : {}),
        },
      })
      let raw
      if (runOpts.binary === true) {
        const chunks = []
        for await (const chunk of handle.stdout) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        raw = Buffer.concat(chunks)
      }
      const outcome = await handle.done
      if (timedOut) throw new Error(`git ${args[0] ?? ''} timed out`)
      return {
        code: outcome.exitCode ?? (outcome.signal !== null ? 128 : 0),
        stdout: raw ?? handle.collected.stdout.readFrom(0).text,
        stderr: handle.collected.stderr.readFrom(0).text,
      }
    } finally {
      clearTimeout(timer)
      runOpts.signal?.removeEventListener('abort', onAbort)
    }
  }
}
