// types.d.ts — 配置与公开接口的类型声明（供消费者与编辑器使用）。

/** 敏感内容分组开关。关闭 = 只留本机，绝不明文上传。 */
export interface SecretGroups {
  providerKeys?: boolean
  mcpEnv?: boolean
  oauthGrants?: boolean
  pluginTokens?: boolean
  secretsDir?: boolean
  homeEnv?: boolean
}

/** 确认级别：auto 全自动 / first-run 首次确认一次 / always 每次写本机都问。 */
export type ConfirmLevel = 'auto' | 'first-run' | 'always'

/** 插件配置（与 index.mjs 的 Schemastery schema 一一对应）。 */
export interface OmnisyncConfig {
  /** 总开关。 */
  enabled?: boolean
  /** GitHub 私仓 `owner/repo`；留空 = 不自动同步，等向导。 */
  repo?: string
  /** 配置流分支。 */
  branch?: string
  /** 会话镜像分支。 */
  mirrorBranch?: string
  /** PAT 文件（$DSH_HOME 相对路径，0600）。 */
  tokenFile?: string
  /** 配置流工作树。 */
  repoDir?: string
  /** 会话镜像工作树。 */
  mirrorDir?: string
  /** 定时同步间隔（分钟，5..1440）。 */
  intervalMinutes?: number
  /** 启动后延迟首轮（秒）。 */
  startupDelaySeconds?: number
  /** 确认级别；**首次启用无论如何都会确认一次**。 */
  confirmLevel?: ConfirmLevel
  /** 模型工具触发时是否过确认门（默认 true，不受 confirmLevel 影响）。 */
  toolConfirm?: boolean
  /** git 可执行文件。 */
  gitBin?: string
  /** 单条 git 命令超时（毫秒，≥10000）。 */
  gitTimeoutMs?: number
  /** 备份保留份数。 */
  backupKeep?: number
  /** 提交者名。 */
  commitName?: string
  /** 提交者邮箱。 */
  commitEmail?: string
  /** 是否注册 /omnisync 命令。 */
  registerCommand?: boolean
  /** 是否注册 omni_sync_* 模型工具。 */
  registerTools?: boolean
  /** 敏感内容分组。 */
  secretGroups?: SecretGroups
  /** 是否同步会话（独立分支，双向）。默认 true。 */
  syncSessions?: boolean
  /** 是否同步附件（内容寻址对象）。默认 true。 */
  syncAttachments?: boolean
  /** 口令文件（$DSH_HOME 相对路径，0600，**永不同步**）。 */
  passphraseFile?: string
  /**
   * 关掉的分区 id 列表（`sectionList()` 的 id）。
   * 关掉的分区等同"未分类" → 不进工作树。注册表驱动，新增分区自动出现在 UI 列表里。
   */
  disabledSections?: string[]
}

/** 分区（同步范围的一项）。 */
export interface SectionInfo {
  id: string
  note: string
  secretGroup?: string
  deviceScoped?: boolean
  defaultOn: boolean
  /** 由宿主附加：当前是否在同步。 */
  enabled?: boolean
}

/** 同步引擎状态（与 lib/engine.mjs 的 STATES 一一对应）。 */
export type SyncState = 'idle' | 'running' | 'conflict' | 'error'

/** 一轮同步的报告。 */
export interface SyncReport {
  mode: 'sync' | 'push' | 'pull'
  trigger: string
  pushed: number
  pulled: number
  conflicts: Array<{ rel: string, note: string }>
  forks: string[]
  /** 本轮合并后消失的凭据键（用于记墓碑，格式 `ref:<k>` / `rec:<k>`）。 */
  deleted?: string[]
  /** 会话流的子报告（配置流成功后才跑；失败只记警告）。 */
  sessions?: { pushed: number, pulled: number, error: string | null }
  commit?: string
  reconciled?: boolean
  cancelled?: boolean
  error?: { code: string, message: string }
  retryInMs?: number
}

/** 持久化状态（storageDomain 单例；schema 必须覆盖 emptyState() 的每个键）。 */
export interface OmnisyncState {
  version: 1
  deviceId: string
  lastSyncedAt: number
  lastError: { code: string, message: string, at: number } | null
  backoffUntil: number
  history: Array<{ trigger: string, pushed: number, pulled: number, error?: string }>
  /** 删除墓碑：键形如 `ref:<name>` / `rec:<id>`，值为删除时刻。 */
  tombstones: Record<string, { at: number }>
}

/** 每台机器的体检报告（随同步流动，远程排障的唯一窗口）。 */
export interface DeviceHealthReport {
  reportV: number
  at: number
  deviceId: string
  platform: NodeJS.Platform | string
  arch: string
  node: string
  electron: string | null
  version: string
  state: 'ok' | 'error'
  lastError: { code: string, message: string, at: number } | null
  lastSyncedAt: number
  backoffUntil: number
  runs: number
  remote: string | null
  branch: string | null
  mirrorBranch: string | null
  secretGroups: string[]
  sessionsEnabled: boolean
  gitVersion: string | null
  counts: { files: number, classified: number } | null
  sessionFiles: number | null
  notes: string[]
}
