// lib/i18n.mjs — 双语文案表（中文主表，英文键控回退）。
//
// 契约：所有用户可见文案（命令输出 / UI / 确认问句 / 错误提示）收在这
// 一张表里。t(key) 先查 zh（主表），缺失时回退 en，再缺失回退 key 本身
// （保证永不渲染 undefined）。client.js 与 host 共用本表（host 路由把它
// 暴露给 client，client 不再内置第二份 —— 单一来源防漂移）。

/** 文案主表（内部：对外只经 t() / allMessages()，避免出现第二份真相）。 */
const MESSAGES = Object.freeze({
  // ── 通用 ───────────────────────────────────────────────
  'nav': { zh: 'Omnisync 全量同步', en: 'Omnisync' },
  'ok': { zh: '完成', en: 'Done' },
  'cancelled': { zh: '已取消', en: 'Cancelled' },

  // ── 状态 ───────────────────────────────────────────────
  'status.idle': { zh: '空闲', en: 'Idle' },
  'status.scanning': { zh: '扫描中…', en: 'Scanning…' },
  'status.planning': { zh: '计算变更…', en: 'Planning…' },
  'status.applying': { zh: '写入中…', en: 'Applying…' },
  'status.pushing': { zh: '推送中…', en: 'Pushing…' },
  'status.error': { zh: '出错（退避中）', en: 'Error (backing off)' },

  // ── 命令输出 ────────────────────────────────────────────
  'cmd.usage': {
    zh: [
      'omnisync 用法 — /omnisync [status | push | pull | diff | log | doctor | help]',
      '  status  同步状态（默认）：远端、上次同步、待推/待拉、冲突数',
      '  push   扫描本机 → 提交并推送（写远端，需确认级别允许）',
      '  pull   拉取远端 → 预览差异（只读，不写本机）',
      '  diff   本机相对上次推送的变更（只读）',
      '  log    同步仓库最近提交',
      '  doctor 本机体检 + 其他机器的报告（远程排障；报告随同步流动）',
    ].join('\n'),
    en: [
      'omnisync usage — /omnisync [status | push | pull | diff | log | help]',
      '  status  sync state (default): remote, last sync, pending, conflicts',
      '  push    scan → commit → push (writes remote per confirm level)',
      '  pull    fetch remote → preview (read-only, never writes local)',
      '  diff    local changes since last push (read-only)',
      '  log     recent commits in the sync repository',
      '  doctor  Local health + reports from other machines (reports ride the sync)',
    ].join('\n'),
  },
  'cmd.not-configured': { zh: '尚未配置远端仓库 —— 请在 设置 → Omnisync 完成向导', en: 'Remote not configured — finish the wizard in Settings → Omnisync' },
  'cmd.push.done': { zh: '已推送 {n} 个文件（{sha}）', en: 'Pushed {n} files ({sha})' },
  'cmd.push.nothing': { zh: '云端已是最新，无变更', en: 'Remote already up to date' },
  'cmd.pull.preview': { zh: '拉取预览：新增 {a} · 变更 {m} · 冲突 {c}（只读，未写本机）', en: 'Pull preview: +{a} ~{m} !{c} (read-only, nothing written)' },
  'cmd.auth-blocked': { zh: 'GitHub 认证失败 —— PAT 可能已过期，请到 设置 → Omnisync 更新令牌', en: 'GitHub auth failed — PAT may have expired; update it in Settings → Omnisync' },
  'cmd.token-expiring': { zh: '⚠️ PAT 将于 {date} 过期（剩 {days} 天）', en: '⚠️ PAT expires {date} ({days} days left)' },

  // ── 确认门 ─────────────────────────────────────────────
  'confirm.first-run': {
    zh: '首次同步将把云仓库配置应用到本机（自动备份已启用）。确认继续？',
    en: 'First sync will apply the cloud configuration to this machine (auto-backup enabled). Continue?',
  },
  'confirm.apply': {
    zh: '即将写入本机 {n} 个文件（含密文分区 {s} 个）。确认？',
    en: 'About to write {n} files locally ({s} encrypted sections). Confirm?',
  },
  'confirm.push': { zh: '即将推送 {n} 个文件到云仓库。确认？', en: 'About to push {n} files to the cloud repository. Confirm?' },
  'confirm.tool-push': {
    zh: '模型请求执行 omni_sync_push。允许本次推送？（此确认不可关闭）',
    en: 'The model requested omni_sync_push. Allow this push? (this gate cannot be disabled)',
  },

  // ── 引导向导 ────────────────────────────────────────────
  'wizard.title': { zh: 'Omnisync 引导', en: 'Omnisync Setup' },
  'wizard.step-pat': { zh: '① 粘贴 GitHub Personal Access Token（将存入本机 0600 文件，绝不上云）', en: '① Paste your GitHub PAT (stored locally 0600, never synced)' },
  'wizard.step-repo': { zh: '② 私有仓库（owner/repo；留空则用 dsh-omnisync 自动创建）', en: '② Private repository (owner/repo; leave empty to auto-create dsh-omnisync)' },
  'wizard.step-passphrase': { zh: '③ 密文口令（两台机器使用同一个口令）', en: '③ Encryption passphrase (the same on both machines)' },
  'wizard.pat-link-hint': {
    zh: '点此打开 GitHub 预填页面（已预填名称/有效期/权限，只需勾选仓库并生成）',
    en: 'Open the GitHub pre-filled token page (name/expiry/scopes pre-filled; just pick the repo and generate)',
  },
  'wizard.verifying': { zh: '验证令牌…', en: 'Verifying token…' },
  'wizard.pat-bad': { zh: '令牌无效或无仓库权限，请重新粘贴', en: 'Token invalid or lacks repository access; paste again' },
  'wizard.done': { zh: '引导完成！首推已就绪', en: 'Setup complete! Ready for first push' },

  // ── 密钥分组（设置页）────────────────────────────────────
  'secrets.providerKeys': { zh: '模型 Provider Key（XIAOMI/OPENCODE_GO 等）', en: 'Model provider keys' },
  'secrets.mcpEnv': { zh: 'MCP 服务的 env / URL 内嵌 Key', en: 'MCP env / URL-embedded keys' },
  'secrets.oauthGrants': { zh: 'OAuth 登录凭证（TRAE/QODER/BUDDY 等，按过期时间取新合并）', en: 'OAuth grants (merged by expiry, newest wins)' },
  'secrets.pluginTokens': { zh: '插件 Token（market/jet-hub 等）', en: 'Plugin tokens' },
  'secrets.secretsDir': { zh: 'secrets/ 技能密钥目录', en: 'secrets/ skill keys' },
  'secrets.homeEnv': { zh: '家级 .env', en: 'Home .env' },

  // ── 错误（code → 文案；与 ERROR_CODES 对齐）──────────────
  'err.GIT_FAILED': { zh: 'git 操作失败：{msg}', en: 'git operation failed: {msg}' },
  'err.PUSH_REJECTED': { zh: '推送被拒（远端有新提交）—— 将自动拉取重合并', en: 'Push rejected (remote ahead) — will fetch and re-merge' },
  'err.AUTH_BLOCKED': { zh: '认证被拒 —— 请更新 PAT', en: 'Authentication blocked — update your PAT' },
  'err.SNAPSHOT_CORRUPT': { zh: '快照校验失败 —— 已拒绝应用，本机未动', en: 'Snapshot verification failed — refused to apply; local untouched' },
  'err.DECRYPT_FAILED': { zh: '解密失败（口令错误或数据损坏）—— 未写入任何文件', en: 'Decryption failed (wrong passphrase or corrupt data) — nothing written' },
  'err.MERGE_CONFLICT': { zh: '存在 {n} 处合并冲突待裁决', en: '{n} merge conflicts need resolution' },
  'err.LOCK_TIMEOUT': { zh: '文件锁超时 —— 本轮放弃，下轮重试', en: 'File lock timeout — skipped this round, will retry' },
  'err.PATH_UNSAFE': { zh: '拒绝不安全路径', en: 'Refused unsafe path' },
})

/**
 * 取文案。zh 主表优先；{x} 占位用 params 填充。
 * @param {string} key - MESSAGES 的键。
 * @param {object} [params] - 占位参数。
 * @param {'zh'|'en'} [locale] - 语言（默认 zh）。
 * @returns {string}
 */
export function t(key, params = {}, locale = 'zh') {
  const entry = MESSAGES[key]
  if (entry === undefined) return key // 永不渲染 undefined
  const raw = entry[locale] ?? entry.zh ?? key
  return raw.replaceAll(/\{(\w+)\}/gu, (_, name) => String(params[name] ?? `{${name}}`))
}

/** 语言表整体导出（client 经 host 路由取用，不内置第二份）。 */
export function allMessages() {
  return MESSAGES
}
