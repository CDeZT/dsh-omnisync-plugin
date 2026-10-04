// lib/tools.mjs — 模型工具三件套（status 只读；push/pull 过确认门）。
//
// 设计：工具只是「引擎的一层薄壳」—— 不做任何自己的判断，全部转发给
// engine/gate。这样工具与命令/UI 的行为永远一致（单一真相源）。

import { defineTool } from '@deepseek-ai/dsh-tools'

import { PLUGIN_NAME } from './constants.mjs'
import { confirm } from './gate.mjs'
import { t } from './i18n.mjs'

export const TOOL_STATUS = 'omni_sync_status'
export const TOOL_PUSH = 'omni_sync_push'
export const TOOL_PULL = 'omni_sync_pull'

const OUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      text: { type: 'string', required: true },
      state: { type: 'string' },
      code: { type: 'string' },
    },
  },
  render(_args, value) { return [{ type: 'text', text: value.text }] },
}

/**
 * 三个工具定义。
 * @param {object} api - { status: () => Promise<string>, run: (mode, exec) => Promise<string> }。
 * @returns {object[]}
 */
export function makeTools(api) {
  const status = defineTool({
    name: TOOL_STATUS,
    description: 'Omnisync status: sync state, remote, pending changes, conflicts. Read-only.',
    parameters: {},
    output: OUT,
    async execute() {
      try {
        return { ok: true, text: await api.status() }
      } catch (error) {
        return { ok: false, code: error?.code ?? 'UNKNOWN', text: `status failed: ${error?.message ?? error}` }
      }
    },
  })

  const push = defineTool({
    name: TOOL_PUSH,
    description: 'Omnisync push: mirror local DSH state and push it to the private sync repository. Requires user confirmation.',
    parameters: {},
    output: OUT,
    async execute(_args, exec) {
      try {
        return { ok: true, text: await api.run('push', exec) }
      } catch (error) {
        return { ok: false, code: error?.code ?? 'UNKNOWN', text: `push failed: ${error?.message ?? error}` }
      }
    },
  })

  const pull = defineTool({
    name: TOOL_PULL,
    description: 'Omnisync pull: fetch the remote snapshot and apply it locally (auto-backup first). Requires user confirmation.',
    parameters: {},
    output: OUT,
    async execute(_args, exec) {
      try {
        return { ok: true, text: await api.run('pull', exec) }
      } catch (error) {
        return { ok: false, code: error?.code ?? 'UNKNOWN', text: `pull failed: ${error?.message ?? error}` }
      }
    },
  })

  return [status, push, pull]
}

/**
 * 注册三个模型工具。工具触发的写动作**永远**过确认门（toolConfirm），
 * 不受 confirmLevel=auto 影响 —— 模型不能替用户同意。
 * @param {object} ctx - 宿主上下文。
 * @param {object} api - { cfg, state, engine, runSync }。
 */
export function mountTools(ctx, api) {
  ctx.inject?.(['tools'], (toolCtx) => {
    const runMode = async (mode, exec) => {
      const gate = await confirm({ ctx }, {
        question: t('confirm.tool-push'), detail: `mode=${mode}`, approveLabel: t('ok'),
        agent: exec?.agent, signal: exec?.signal, isTool: true,
      }, { confirmLevel: api.cfg.confirmLevel, toolConfirm: api.cfg.toolConfirm, confirmedOnce: true })
      if (!gate.allowed) return `not allowed: ${gate.reason ?? 'declined'}`
      const report = await api.runSync(mode, 'tool')
      return report.error === undefined
        ? `${mode} ok: pushed ${report.pushed}, pulled ${report.pulled}, conflicts ${report.conflicts.length}`
        : `${mode} failed: ${report.error.code} ${report.error.message}`
    }
    for (const tool of makeTools({
      status: async () => {
        const st = await api.engine.status()
        const s = await api.state()
        return `${PLUGIN_NAME}: ${st.state}, device ${s.deviceId}, dirty ${st.dirty}, remote ${api.cfg.repo || 'unconfigured'}`
      },
      run: runMode,
    })) toolCtx.tools.register(tool)
  })
}
