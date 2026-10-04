// lib/sections.mjs — 同步条目注册表（本插件的单一边界真相源）。
//
// discover + allowlist + deny：不在本表的路径默认拒绝进通道（防"未来某插件把密钥静默推上云"）。
// 每条目 = id · 相对路径 · 合并策略 · 密级分组；deviceScoped 条目按设备分桶。

import { SECRET_GROUPS } from './constants.mjs'

/** 密文分组：进 secrets.enc.json 的条目带 secretGroup。 */
const S = SECRET_GROUPS

/**
 * @typedef {object} Section
 * @property {string} id
 * @property {string[]} relPaths - 相对 $DSH_HOME（支持目录前缀）
 * @property {'keepboth'|'json'|'tree'|'patch-yaml'|'credentials'|'blob'} merger
 * @property {string} [secretGroup]
 * @property {boolean} [deviceScoped]
 * @property {boolean} [localWins] - 插件清单本地优先
 * @property {string} note - 一句话说明（UI/审计用）
 */

/** 全部同步条目。顺序 = 落盘顺序（依赖靠前）。 */
export const SECTIONS = Object.freeze([
  // ── 全局配置层（压在所有 profile 之上）─────────────────────────
  { id: 'home-patch', relPaths: ['cordis.patch.yml'], merger: 'patch-yaml', note: 'home 级 patch（最高优先级配置层）' },

  // ── profile 层（每 profile 一组；这里列 desktop，其它 profile 动态发现）──
  { id: 'profile-manifest', relPaths: ['profiles/{name}/package.json', 'profiles/{name}/compatibility.json'], merger: 'json', localWins: true, note: 'profile 清单（真 JSON）：本地优先+并集（被远端覆盖=crash loop）' },
  // ★ 这三个是 **YAML**，绝不能走 json 合并器 —— 实测它判 "invalid JSON" → 每次分叉都变成
  //   conflict 且远端被隔离，等于这些文件永不合并。用 keepboth：分叉保双方并上报，绝不静默取一边。
  { id: 'profile-yaml', relPaths: ['profiles/{name}/cordis.yml', 'profiles/{name}/pnpm-workspace.yaml', 'profiles/{name}/pnpm-lock.yaml'], merger: 'keepboth', note: 'profile YAML：根占位 / pnpm 供应链策略 / 依赖锁（缺它们新机器装不出同一个桌面端）' },
  { id: 'profile-patch', relPaths: ['profiles/{name}/cordis.patch.yml'], merger: 'patch-yaml', note: 'profile patch：条目 id 级合并+实例字段过滤' },

  // ── 凭据（记录级合并 —— 生态空白，本插件核心）─────────────────
  { id: 'credentials', relPaths: ['.credentials.yaml', 'dsh-config-manager/vault/.credentials.yaml'], merger: 'credentials', secretGroup: S.OAUTH_GRANTS, note: '凭据记录（含 config-manager 的 vault 副本：同格式，走同样的记录级合并与加密）' },

  // ── 工作区与指令 ────────────────────────────────────────────
  { id: 'workspace', relPaths: ['storages/workspace.json'], merger: 'json', note: 'path 跨机重定基' },
  { id: 'instructions', relPaths: ['AGENTS.md'], merger: 'keepboth', note: '全局指令' },

  // ── skills（双根，导出解引用 —— 跨机不能指望 link target 存在）────
  { id: 'skills-dsh', relPaths: ['skills'], merger: 'tree', note: '$DSH_HOME/skills（含 secrets/ 密钥子目录→密文）' },
  { id: 'skills-secrets', relPaths: ['secrets'], merger: 'keepboth', secretGroup: S.SECRETS_DIR, note: '技能自带密钥目录' },

  // ── 家环境层 ────────────────────────────────────────────────
  { id: 'env-home', relPaths: ['.env'], merger: 'keepboth', secretGroup: S.HOME_ENV, note: '家级 .env' },

  // ── 桌面 UI 偏好（文档内按设备分桶，零合并风险）──────────────────
  // 另一个插件的**配置**（不含其运行态：boot-state/transactions/migration-history/exports 硬排除）
  { id: 'config-manager', relPaths: ['dsh-config-manager/sync'], merger: 'json', note: 'dsh-config-manager 的同步偏好与备份计划（UI 偏好跨机一致）' },

  // 外部根：路径在 $DSH_HOME 之外，用 `@userdata/` 虚拟前缀寻址（见 workspace.mjs 的 externalRoots）
  { id: 'keybindings', relPaths: ['@userdata/keybindings.json'], merger: 'json', deviceScoped: true, note: '快捷键（在 Electron userData 下，非 $DSH_HOME）' },

  // ── 附件（内容寻址+写一次不可变 → 无冲突可能）───────────────────
  { id: 'attachments', relPaths: ['attachments/v1/objects'], merger: 'blob', note: '内容寻址 blob（缺引用硬失败）' },

  // ── 账号/渠道状态 ───────────────────────────────────────────
  { id: 'jet-hub-state', relPaths: ['jet-hub/state.json', 'jet-hub/permanent-locks.json', 'jet-hub/auto-checkin.json'], merger: 'json', secretGroup: S.PLUGIN_TOKENS, note: '渠道账号索引/锁/自动签到配置' },
  { id: 'browser-settings', relPaths: ['dsh-builtin-browser-host/settings.json'], merger: 'json', note: '浏览器宿主用户设置' },
  { id: 'agy-sessions', relPaths: ['agy-link/sessions.json'], merger: 'json', note: 'agy 会话映射（按机过滤）' },
  { id: 'market-state', relPaths: ['profiles/{name}/.dsh-market/state.json'], merger: 'json', note: '市场状态：含 disabled 插件清单（决定"同一桌面"的启用集）' },
  { id: 'device-health', relPaths: ['omnisync-devices'], merger: 'json', note: '每台机器的体检报告（远程排障的唯一窗口）' },

  // ── 会话（mirror 分支，keep-both + fork）─────────────────────
  { id: 'sessions', relPaths: ['sessions'], merger: 'keepboth', note: '会话镜像（mirror/sessions 分支）' },
  { id: 'sessions-projcache', relPaths: ['storages/session_projcache'], merger: 'keepboth', note: '会话投影缓存（随会话）' },
])

export const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]))

/** Electron app.getPath('userData') 的约定位置（拿不到 app 对象时按平台推导）。 */
export function defaultUserDataDir() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  if (process.platform === 'win32') return `${(process.env.APPDATA ?? `${home}/AppData/Roaming`).replaceAll('\\', '/')}/@deepseek-ai/dsh-desktop`
  if (process.platform === 'darwin') return `${home}/Library/Application Support/@deepseek-ai/dsh-desktop`
  return `${process.env.XDG_CONFIG_HOME ?? `${home}/.config`}/@deepseek-ai/dsh-desktop`
}

/** 解析 relPath 里的 {name} 模板。 */
function expandSectionPath(relPath, name) {
  return relPath.replaceAll('{name}', name)
}

/** 外部根的虚拟前缀（rel 以它开头 = 文件在 $DSH_HOME 之外）。 */
export const EXTERNAL_PREFIX = '@userdata/'

export function isExternalRel(rel) {
  return typeof rel === 'string' && rel.startsWith(EXTERNAL_PREFIX)
}

/** 注册表声明在外部根下的全部 rel（供 fs 层精确探测，避免整棵遍历 userData）。 */
export function externalRels() {
  const out = []
  for (const s of SECTIONS) {
    for (const tpl of s.relPaths) {
      if (isExternalRel(tpl)) out.push(tpl)
    }
  }
  return out
}

/** 判定一个相对路径属于哪个条目（最长前缀胜出）。 */
export function sectionForPath(rel, profileName = 'desktop') {
  let best = null
  let bestLen = 0
  for (const s of SECTIONS) {
    for (const tpl of s.relPaths) {
      const base = expandSectionPath(tpl, profileName)
      if (rel === base || rel.startsWith(base + '/')) {
        if (base.length > bestLen) { best = s; bestLen = base.length }
      }
    }
  }
  return best
}

/** 供 UI 与配置使用的分区清单（注册表驱动 —— 新增分区自动出现在选择列表里）。 */
export function sectionList() {
  return SECTIONS.map((s) => ({
    id: s.id,
    note: s.note,
    ...(s.secretGroup !== undefined ? { secretGroup: s.secretGroup } : {}),
    ...(s.deviceScoped === true ? { deviceScoped: true } : {}),
    // 默认全开：用户装这个插件就是为了"全部同步"，要关的自己去关。
    defaultOn: s.defaultOff !== true,
  }))
}
