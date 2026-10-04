// lib/constants.mjs — 词汇表与协议常量（零依赖，全插件唯一常量来源）。
//
// 边界：任何跨模块共享的字面量必须住在这里（禁止散落）；
// 每个正则常量上方写它守护什么。改值 = 改协议，慎重。

/** 包名 —— 插件身份。必须与 package.json 的 name 一致（前端注册 ID 亦然）。 */
export const PACKAGE_NAME = '@cdezt/dsh-omnisync'

/**
 * 运行时版本镜像（与 package.json 的 version 同步）。
 * 用途：**检测"运行中的是旧模块"** —— DSH 的热重载只重新导入插件入口
 * （index.mjs），`lib/**` 的相对导入仍留在 ESM 缓存里。所以磁盘上是新版、
 * 进程里是旧版是常态，必须能探测（见 scripts/verify-install.mjs --live）。
 */
export const LIB_REV = '0.9.6'

/** 短名 —— 仅用于日志前缀与内部标签（命令/域/路由各有自己的常量）。 */
export const PLUGIN_NAME = 'dsh-omnisync'
export const COMMAND_NAME = 'omnisync'
export const NAMESPACE = 'omnisync' // HTTP 路由与 client 模块 id 的统一前缀

// storageDomain 域名（下划线：域名正则不允许连字符）。
export const DOMAIN_NAME = 'omnisync'
export const STATE_KEY = 'singleton'

// fork / 冲突副本命名（永不自动删除 —— 两边字节都存续）。
// remote-fork：与 dsh-session-sync 同口径，14 位 UTC 戳。
export const FORK_NAME_RE = /\.remote-fork-\d{14}-[0-9a-z]{8}(?:\.|$)/iu
export const CONFLICT_NAME_RE = /\.conflict-\d{14}-[0-9a-z]{8}(?:\.|$)/iu
// 宿主私有产物：既不复制也不删除（瞬时锁/迁移暂存，跨机传播即事故）。
export const HOST_ARTIFACT_NAME_RE = /^(?:session\.lock|session\.migration\..+\.tmp|\.DS_Store)$/u

// 合并三分支分类（keepboth 的五分类）。
export const MERGE_KINDS = Object.freeze({
  IDENTICAL: 'identical',
  OURS_ONLY: 'ours-only',
  THEIRS_ONLY: 'theirs-only',
  APPEND_BOTH: 'append-both',
  DIVERGED: 'diverged',
})

// 确认门分级（用户决策：默认 first-run；首次启用无论如何都要确认）。
export const CONFIRM_LEVELS = Object.freeze({
  AUTO: 'auto',
  FIRST_RUN: 'first-run',
  ALWAYS: 'always',
})

// 密钥六分组（用户决策：默认全开）。
export const SECRET_GROUPS = Object.freeze({
  PROVIDER_KEYS: 'providerKeys',
  MCP_ENV: 'mcpEnv',
  OAUTH_GRANTS: 'oauthGrants',
  PLUGIN_TOKENS: 'pluginTokens',
  SECRETS_DIR: 'secretsDir',
  HOME_ENV: 'homeEnv',
})

// 永不同步（硬排除，不可配置 —— 安全边界不是偏好）。
// 说明：本插件的 token/vault、凭据锁、浏览器 cookies/profile、活体 CDP
// 令牌、网关明文 key、Electron 单例锁。任何"未来的未知插件目录"也因
// 不在白名单注册表而被默认拒绝（discover+allowlist+deny 模型）。
export const NEVER_SYNC = Object.freeze([
  'omnisync/github.token',
  'omnisync/passphrase.vault',
  '.credentials.yaml.lock',
  'dsh-builtin-browser-bridge.json',
  'openai-gateway/api-key',
  // 备份残留（`*.bak`、`*.bak-*`）：手工编辑的临时副本，跨机传播只会造成"旧版覆盖新版"。
  'profiles/desktop/package.json.bak',
  'profiles/desktop/pnpm-workspace.yaml.bak',
  // 市场日志与缓存：纯本机、可再生；同步它们只会每轮产生无意义提交。
  'profiles/desktop/.dsh-market/log.ndjson',
  'profiles/desktop/.dsh-market/discovery-compatibility-v1.json',
  // 插件自己的持久化状态（deviceId / 同步历史 / 删除墓碑）：**按设备隔离**。
  // 同步它 = 两台机器抢同一个身份，且把对方的退避/墓碑当成自己的。
  'storages/omnisync.json',
])

/**
 * 硬排除的**正则**形态（NEVER_SYNC 是精确/前缀表，表达不了"名字不固定"的一类）。
 * 每一条都必须写明理由 —— 硬排除是"永不进通道"，误加会让用户以为同步了其实没有。
 */
export const NEVER_SYNC_PATTERNS = Object.freeze([
  // 用户自己的回滚快照（backup-<时间戳>[-<标签>]/）：是历史副本，跨机传播只会造成"旧版覆盖新版"。
  /^backup-[^/]+\//u,
  // 设备身份：每台机器各自匿名，同步它等于让两台机器共用一个身份。
  /^\.anonymous-user-id$/u,
  // 机器指纹：编码了本机环境（路径/硬件），跨机无意义且会误导。
  /^dsh-config-manager\/environment-fingerprint\.token$/u,
  // 另一个插件的运行态：事务日志/迁移历史/启动状态/导出归档 —— 都是本机过程产物。
  /^dsh-config-manager\/(?:boot-state|transactions|migration-history|exports)\//u,
  // 浏览器历史：纯本机隐私，且体量增长快。
  /^dsh-builtin-browser-host\/history\.jsonl$/u,
  // 运行时覆盖：编码了本机端口/路径，跨机会让目标机的 DSH 起不来。
  /^agy-link\/runtime-overrides\.json$/u,
])

/** 是否命中硬排除（精确表 + 前缀 + 正则）。 */
export function isNeverSynced(rel) {
  if (NEVER_SYNC.some((p) => rel === p || rel.startsWith(`${p}/`))) return true
  return NEVER_SYNC_PATTERNS.some((re) => re.test(rel))
}

// git 引擎限额。
export const LIMITS = Object.freeze({
  MAX_COMMIT_MESSAGE_LENGTH: 200,
  MAX_OUTPUT_BYTES: 262144,
  ANCESTOR_KEEP: 10,      // 基线快照保留份数
  BACKUP_KEEP: 5,         // 写前备份保留份数
  TOMBSTONE_TTL_MS: 90 * 24 * 3600 * 1000, // 墓碑 90 天
  ECHO_WINDOW_MS: 3000,  // 回声防护窗口
})

// 调度去抖：两次同步之间的最小间隔。

// 领域错误码（与 lib/errors.mjs 的 ERROR_CODES 保持一致——那边是权威）。
export { ERROR_CODES } from './errors.mjs'

/**
 * 遍历时**直接剪枝**的目录名（性能刚需，不只是安全考虑）。
 * 本机实测 ~/.dsh 有 29431 个文件 / 1.5GB，其中 node_modules 18316 个、
 * agy-accounts 10867 个 —— 每 15 分钟全量 stat 一遍是不可接受的。
 * 这些目录既不进通道，也绝不该被遍历。
 */
export const PRUNE_DIRS = Object.freeze([
  'node_modules', '.git', 'cache', 'agy-accounts', '.pnpm-store',
  'dist', 'build', '.cache', '.venv', 'venv', '__pycache__',
  '.plugin-manager', // 实测只含 pnpm 操作日志（噪声，无同步价值）
])

/** 剪枝目录名集合（O(1) 判定）。 */
export const PRUNE_DIR_SET = new Set(PRUNE_DIRS)
