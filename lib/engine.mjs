// lib/engine.mjs — 同步引擎（精简版；零 DSH 依赖，能力经 deps 注入）。
//
// 设计要点：**用 git 当合并引擎**。git 已经能算出 base/ours/theirs 并把
// 冲突标在索引里（stage 1/2/3），我们只在「git 报冲突的路径」上跑自己的
// 分区合并器 —— 这比手工 reconcile 简单一个数量级，也少一类 bug。
//
//   push: 镜像本机 → add/commit → push（被拒则 fetch+merge 重试一次，绝不强推）
//   pull: fetch → merge → 冲突路径按分区策略裁决 → 检出 → 回写本机
//
// 两条不变式：单飞；写本机前必留备份。

export const STATES = Object.freeze({
  IDLE: 'idle', SYNCING: 'syncing', CONFLICT: 'conflict', ERROR: 'error',
})

/** 错误码 → 退避毫秒（AUTH 必须长退避，不做无人值守空转）。 */
export function backoffFor(code) {
  return {
    AUTH_BLOCKED: 6 * 3600_000,
    SNAPSHOT_CORRUPT: 30 * 60_000,
    LOCK_TIMEOUT: 60_000,
    MERGE_CONFLICT: 0,
    DECRYPT_FAILED: 0,
    PUSH_REJECTED: 0,
  }[code] ?? 5 * 60_000
}

export class Engine {
  #deps
  #state = STATES.IDLE
  #busy = false

  /** @param {object} deps - 见 index.mjs 的构造处（git/mirror/applyToLocal/previewLocal/confirm/now/deviceId）。 */
  constructor(deps) { this.#deps = deps }

  get state() { return this.#state }

  /**
   * 跑一轮。
   * @param {object} input - { mode?: 'sync'|'push'|'pull', trigger?: string, autoApply?: boolean }。
   * @returns {Promise<object>} 报告（含 error 字段时表示失败）。
   */
  async run(input = {}) {
    if (this.#busy) return { skipped: true, reason: 'already-running' }
    this.#busy = true
    const t0 = this.#deps.now()
    const mode = input.mode ?? 'sync'
    const report = { mode, trigger: input.trigger ?? 'manual', startedAt: t0, pushed: 0, pulled: 0, conflicts: [], forks: [] }
    try {
      const { git, mirror, applyToLocal, confirm } = this.#deps
      this.#set(STATES.SYNCING, input)

      // ① 拉：fetch 远端 → 需要时合并进工作树 → **总是**把工作树落地到本机。
      //   ★ 不能只在"有新提交"时落地：新机器首次 clone 后 HEAD 已等于远端，
      //     若跳过落地，全新机器上什么都不会被物化（"空机引导"直接失效）。
      if (mode !== 'push') {
        const fetched = await this.#withGit(git, () => git.fetch())
        const remoteHead = fetched ? await this.#withGit(git, () => git.remoteHeadSha()) : undefined
        if (remoteHead !== undefined) {
          const head = await this.#withGit(git, () => git.headSha())
          if (head !== remoteHead) {
            await this.#mergeRemote(git, remoteHead, report, input)
            report.reconciled = true
          }
          // 落地是幂等的：内容一致的文件会被跳过（见 applyToLocal）。
          // ★ 确认门必须在**写之前**问：先写再问 = 用户拒绝也挡不住落盘
          //   （旧实现把门放在 push 分支里，pull 模式甚至完全不过门）。
          //   previewLocal（可选 dep）干跑算出"即将写入几个文件"；拿不到
          //   预估时一律要问（fail closed：没有确认通道就不写）。
          const preview = this.#deps.previewLocal === undefined ? null : await this.#deps.previewLocal()
          if (!input.autoApply && preview !== 0 && !(await confirm({ files: preview ?? 0 }))) {
            this.#set(STATES.IDLE, input)
            return { ...report, cancelled: true, finishedAt: this.#deps.now() }
          }
          report.pulled = await applyToLocal()
        }
      }

      // ② 推：镜像本机 → 提交 → 推送。
      if (mode !== 'pull') {
        report.pushed = await mirror()
        const commit = await this.#withGit(git, () => git.commitAll(`omnisync: ${report.pushed} change(s) from ${this.#deps.deviceId()}`))
        if (commit !== null) {
          try {
            await this.#withGit(git, () => git.push())
          } catch (error) {
            if (error?.code !== 'PUSH_REJECTED') throw error
            // 对端推过新提交 → fetch + 合并 + 重试一次（绝不强推）。
            await this.#withGit(git, () => git.fetch())
            const rh = await this.#withGit(git, () => git.remoteHeadSha())
            if (rh === undefined) throw error
            await this.#mergeRemote(git, rh, report, input)
            await this.#withGit(git, () => git.push())
            report.reconciled = true
          }
          report.commit = commit
        }
      }

      this.#set(STATES.IDLE, input)
      return { ...report, finishedAt: this.#deps.now() }
    } catch (error) {
      this.#set(STATES.ERROR, input)
      const code = error?.code ?? 'UNKNOWN'
      return { ...report, error: { code, message: String(error?.message ?? error) }, retryInMs: backoffFor(code), finishedAt: this.#deps.now() }
    } finally {
      this.#busy = false
    }
  }

  /**
   * 把远端 head 合进工作树：beginMerge → （有冲突则裁决）→ commitMerge。
   *
   * ★ 必须是**唯一实现**：pull 路径与 push-重试路径原本各写了一遍，两处的
   *   report 累积方式还不一样（一个赋值、一个 push）—— 典型的"修了一处漏另一处"
   *   形态。合并序列一旦分叉，就会出现"某条路径忘了裁决冲突"这类静默故障。
   * @param {object} git - 后端。
   * @param {string} remoteHead - 要合入的远端 sha。
   * @param {object} report - 累积报告（就地追加 conflicts/forks）。
   * @param {object} input - 传给 #set 的上下文。
   */
  async #mergeRemote(git, remoteHead, report, input) {
    const begun = await this.#withGit(git, () => git.beginMerge(remoteHead))
    if (begun.conflicted) {
      this.#set(STATES.CONFLICT, input)
      const resolved = await this.#deps.resolveConflicts()
      report.conflicts.push(...resolved.conflicts)
      report.forks.push(...resolved.forks)
    }
    await this.#withGit(git, () => git.commitMerge())
  }

  /** 只读状态（不触网、不写盘）。 */
  async status() {
    const { git } = this.#deps
    return this.#withGit(git, async () => {
      const [dirty, head, remoteHead, mergeInProgress, commits] = [
        await git.dirtyLines(), await git.headSha(), await git.remoteHeadSha(), await git.mergeInProgress(), await git.recentCommits(5),
      ]
      return { state: this.#state, dirty: dirty.length, head, remoteHead, mergeInProgress, lastCommits: commits }
    })
  }

  /** 所有 git 调用经 GitBackend 的串行链（同仓库单飞）。 */
  #withGit(git, fn) { return git.schedule(fn) }

  #set(next, input) { this.#state = next; input?.onState?.(next) }
}
