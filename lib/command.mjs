// lib/command.mjs — /omnisync 命令实现（纯渲染 + 转发，不持有状态）。
//
// 设计：命令、模型工具、HTTP 路由三条入口共用同一个 api 面（见 index.mjs），
// 于是"命令说什么"和"UI 显示什么"永远一致 —— 单一真相源。
//
// 只做三件事：解析子命令 → 调 api → 把结果排版成人能读的文本。

import { COMMAND_NAME, PLUGIN_NAME } from './constants.mjs'
import { t } from './i18n.mjs'

/** 支持的子命令。 */
export const ACTIONS = Object.freeze(['status', 'push', 'pull', 'diff', 'log', 'doctor'])

/**
 * 注册 `/omnisync` 命令：只转发到 runCommand，与工具/UI 共用同一个 api。
 * @param {object} ctx - 宿主上下文（需 commands 服务）。
 * @param {object} api - 同 runCommand。
 */
export function mountCommand(ctx, api) {
  ctx.commands.register({
    name: COMMAND_NAME,
    description: 'Omnisync: full-state cloud sync (status | push | pull | diff | log | doctor | help)',
    input: { hint: '[status | push | pull | diff | log | doctor | help]' },
    handler: (invocation) => runCommand(api, invocation?.rawInput),
  })
}

/**
 * 执行一个子命令。
 * @param {object} api - { engine, git, state, doctor, runSync, repo: () => string, cfg }。
 * @param {string} raw - 用户输入的原文。
 * @returns {Promise<{kind: 'success'|'error', text: string}>}
 */
export async function runCommand(api, raw) {
  const action = String(raw ?? '').trim().split(/\s+/u)[0]?.toLowerCase() || 'status'
  if (action === 'help' || !ACTIONS.includes(action)) return { kind: 'success', text: t('cmd.usage') }
  if (api.repo() === '' && action !== 'doctor') return { kind: 'error', text: t('cmd.not-configured') }

  try {
    switch (action) {
      case 'status': return { kind: 'success', text: await statusText(api) }
      case 'log': {
        const lines = await api.git.schedule(() => api.git.recentCommits(10))
        return { kind: 'success', text: lines.length === 0 ? '(no commits)' : lines.join('\n') }
      }
      case 'diff': {
        const dirty = await api.git.schedule(() => api.git.dirtyLines())
        return { kind: 'success', text: dirty.length === 0 ? 'clean' : dirty.slice(0, 50).join('\n') }
      }
      case 'doctor': return { kind: 'success', text: await api.doctor() }
      default: {
        const report = await api.runSync(action === 'pull' ? 'pull' : 'push', 'manual')
        if (report.error !== undefined) return { kind: 'error', text: `${report.error.code}: ${report.error.message}` }
        if (report.cancelled === true) return { kind: 'success', text: t('cancelled') }
        if (action === 'pull') return { kind: 'success', text: t('cmd.pull.preview', { a: report.pulled, m: 0, c: report.conflicts.length }) }
        return {
          kind: 'success',
          text: report.commit == null
            ? t('cmd.push.nothing')
            : t('cmd.push.done', { n: report.pushed, sha: String(report.commit).slice(0, 8) }),
        }
      }
    }
  } catch (error) {
    return { kind: 'error', text: `${error?.code ?? 'UNKNOWN'}: ${error?.message ?? error}` }
  }
}

/** status 的人读排版。 */
async function statusText(api) {
  const s = await api.state()
  const st = await api.engine.status()
  const ago = (ms) => (ms === 0 ? 'never' : new Date(ms).toISOString())
  return [
    `${PLUGIN_NAME} status`,
    `  state      ${st.state}`,
    `  device     ${s.deviceId}`,
    `  remote     ${api.repo()} (${api.cfg.branch})`,
    `  last sync  ${ago(s.lastSyncedAt)}`,
    `  dirty      ${st.dirty} file(s)`,
    `  merge      ${st.mergeInProgress ? 'in progress' : 'none'}`,
    s.lastError === null || s.lastError === undefined ? '  last error none' : `  last error ${s.lastError.code}: ${s.lastError.message}`,
  ].join('\n')
}
