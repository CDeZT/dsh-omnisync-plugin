// lib/gate.mjs — 确认门（fail closed）。
//
// 三级（Config.confirmLevel）：auto | first-run | always。
// 通道优先 userQuestions，回退 approval，都没有 → **拒绝**（绝不"没通道就放行"）。
// 模型工具触发的动作**永远**过门（toolConfirm），不受 level=auto 影响。

import { t } from './i18n.mjs'

export const CHANNELS = Object.freeze({ USER_QUESTIONS: 'userQuestions', APPROVAL: 'approval', NONE: 'none' })

/** 选择可用通道。 */
export function pickChannel(ctx) {
  if (ctx.get?.('userQuestions') !== undefined) return CHANNELS.USER_QUESTIONS
  if (ctx.get?.('approval') !== undefined) return CHANNELS.APPROVAL
  return CHANNELS.NONE
}

/**
 * 请求确认。
 * @param {object} deps - { ctx, logger }。
 * @param {object} req - { question, detail, approveLabel, agent, signal, isTool }。
 * @param {object} cfg - { confirmLevel, toolConfirm, confirmedOnce }。
 * @returns {Promise<{allowed: boolean, channel: string, reason?: string}>}
 */
export async function confirm(deps, req, cfg) {
  // ★ 先判"要不要问"。不问的路径不该依赖确认通道存在 —— 否则 auto 级别
  //   在无通道环境（headless）下会永远 fail closed，配置形同虚设。
  const mustAsk = req.isTool === true
    ? cfg.toolConfirm !== false
    : cfg.confirmLevel === 'always' || (cfg.confirmLevel === 'first-run' && cfg.confirmedOnce !== true)
  if (!mustAsk) return { allowed: true, channel: 'auto', reason: 'no confirmation needed at this level' }

  // 要问就必须有通道；没有 → 拒绝（fail closed，绝不"没法问就放行"）。
  const channel = pickChannel(deps.ctx)
  if (channel === CHANNELS.NONE) {
    return { allowed: false, channel, reason: 'no confirmation channel (fail closed)' }
  }
  const approveLabel = req.approveLabel ?? 'Continue'
  try {
    if (channel === CHANNELS.USER_QUESTIONS) {
      const service = deps.ctx.get('userQuestions')
      if (typeof service?.ask !== 'function') return { allowed: false, channel, reason: 'userQuestions has no ask()' }
      const answer = await service.ask({
        questions: [{
          id: 'omnisync-confirm',
          question: req.question,
          detail: req.detail,
          options: [
            { label: approveLabel, description: req.detail },
            { label: 'Cancel', description: 'Do nothing.' },
          ],
        }],
        agent: req.agent,
        signal: req.signal,
      })
      const item = answer?.answers?.find((e) => e.id === 'omnisync-confirm')
      if (typeof item?.custom === 'string' && item.custom.length > 0) {
        return { allowed: false, channel, reason: 'free-text answer is not an approval' }
      }
      const selected = Array.isArray(item?.selected) ? item.selected : []
      return selected.includes(approveLabel)
        ? { allowed: true, channel }
        : { allowed: false, channel, reason: 'user declined' }
    }
    // approval 通道（仅轮内可用；真实契约见 dsh-user-approval/lib/index.js:128-140）：
    //   请求形状 { agent, toolName, reason }；**返回字符串**，只有 'allowed-once' 是授权。
    const service = deps.ctx.get('approval')
    if (typeof service?.request !== 'function') return { allowed: false, channel, reason: 'approval has no request()' }
    const outcome = await service.request({
      agent: req.agent,
      toolName: req.toolName ?? 'omnisync',
      ...(req.callId !== undefined ? { callId: req.callId } : {}),
      reason: req.question,
    })
    return outcome === 'allowed-once'
      ? { allowed: true, channel }
      : { allowed: false, channel, reason: `approval outcome: ${String(outcome)}` }
  } catch (error) {
    return { allowed: false, channel, reason: `confirmation failed: ${error?.message ?? error}` }
  }
}

/**
 * 落地前的确认包装：问一次"要不要把 N 个文件写进本机"，并把"已确认过"持久化
 * （first-run 只打扰一次）。state/withState 由调用方注入 —— 本模块不碰存储。
 * @param {object} deps - { ctx, cfg, state: () => Promise<object>, withState }。
 * @returns {(req: {files: number}) => Promise<boolean>} 引擎的 confirm dep。
 */
export function makeConfirm(deps) {
  return async (req) => {
    const st = await deps.state()
    const res = await confirm({ ctx: deps.ctx }, {
      question: t('confirm.apply', { n: req.files, s: 0 }),
      detail: `${req.files} file(s) will be written locally (auto-backup first)`,
      approveLabel: t('ok'),
    }, { confirmLevel: deps.cfg.confirmLevel, toolConfirm: deps.cfg.toolConfirm, confirmedOnce: st.confirmedOnce })
    if (res.allowed && st.confirmedOnce !== true) await deps.withState(async (s) => { s.confirmedOnce = true; return s })
    return res.allowed
  }
}
