// lib/config.mjs — 配置与状态域的**纯声明**（无 I/O、无 ctx、可单独 import）。
//
// 为什么单独一个模块：这三块声明原本混在 index.mjs 的编排代码里，让那个文件
// 干五件事。声明与接线分开后，改 schema/加配置项不必在 460 行里找位置。
//
// 不变量（踩过两次真机事故）：stateSchema 必须覆盖 emptyState() 的**每一个**
// 键（含 version）。storageDomain 加载时按本 schema 解析记录，未声明的键会被
// zod 剥掉 —— 漏 `version` → migrateState 判"版本不符" → 每次重启静默重置
// 全部状态；漏 `settings` → 每次重启丢用户偏好。
// 漂移由 test/domain.test.mjs 与 test/guards.test.mjs 的守卫拦住。

import Schema from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import { CONFIRM_LEVELS, DOMAIN_NAME, SECRET_GROUPS } from './constants.mjs'
import { badConfig } from './errors.mjs'

const DEFAULTS = Object.freeze({
  enabled: true, repo: '', branch: 'main', mirrorBranch: 'mirror/sessions',
  tokenFile: 'omnisync/github.token', repoDir: 'omnisync/repo', mirrorDir: 'omnisync/mirror',
  intervalMinutes: 15, startupDelaySeconds: 30, confirmLevel: 'first-run', toolConfirm: true,
  gitBin: 'git', gitTimeoutMs: 120_000, backupKeep: 5,
  commitName: 'dsh-omnisync', commitEmail: 'omnisync@localhost',
  registerCommand: true, registerTools: true, secretGroups: undefined,
  syncSessions: true, syncAttachments: true, passphraseFile: 'omnisync/passphrase.vault',
  disabledSections: [],
  folderRemote: '',
})

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
  repo: Schema.string().default(DEFAULTS.repo),
  branch: Schema.string().default(DEFAULTS.branch),
  mirrorBranch: Schema.string().default(DEFAULTS.mirrorBranch),
  tokenFile: Schema.string().default(DEFAULTS.tokenFile),
  repoDir: Schema.string().default(DEFAULTS.repoDir),
  mirrorDir: Schema.string().default(DEFAULTS.mirrorDir),
  intervalMinutes: Schema.number().default(DEFAULTS.intervalMinutes),
  startupDelaySeconds: Schema.number().default(DEFAULTS.startupDelaySeconds),
  confirmLevel: Schema.union(Object.values(CONFIRM_LEVELS)).default(DEFAULTS.confirmLevel),
  toolConfirm: Schema.boolean().default(DEFAULTS.toolConfirm),
  gitBin: Schema.string().default(DEFAULTS.gitBin),
  gitTimeoutMs: Schema.number().default(DEFAULTS.gitTimeoutMs),
  backupKeep: Schema.number().default(DEFAULTS.backupKeep),
  commitName: Schema.string().default(DEFAULTS.commitName),
  commitEmail: Schema.string().default(DEFAULTS.commitEmail),
  registerCommand: Schema.boolean().default(DEFAULTS.registerCommand),
  registerTools: Schema.boolean().default(DEFAULTS.registerTools),
  syncSessions: Schema.boolean().default(DEFAULTS.syncSessions),
  syncAttachments: Schema.boolean().default(DEFAULTS.syncAttachments),
  disabledSections: Schema.array(Schema.string()).default(DEFAULTS.disabledSections),
  // 文件夹后端：网盘里的裸仓绝对路径（iCloud/Dropbox/共享盘）。设了它就**取代** GitHub。
  folderRemote: Schema.string().default(DEFAULTS.folderRemote),
  passphraseFile: Schema.string().default(DEFAULTS.passphraseFile),
  secretGroups: Schema.object({
    providerKeys: Schema.boolean().default(true), mcpEnv: Schema.boolean().default(true),
    oauthGrants: Schema.boolean().default(true), pluginTokens: Schema.boolean().default(true),
    secretsDir: Schema.boolean().default(true), homeEnv: Schema.boolean().default(true),
  }).default({}),
})

/** 补齐默认 + 加载期校验（非法配置响亮失败，绝不半可用）。 */
export function resolveConfig(config = {}) {
  const c = { ...DEFAULTS, ...config }
  if (c.repo !== '' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(c.repo)) throw badConfig(`repo must be "owner/name" (got ${JSON.stringify(c.repo)})`)
  if (!(c.intervalMinutes >= 5 && c.intervalMinutes <= 1440)) throw badConfig(`intervalMinutes must be within 5..1440 (got ${c.intervalMinutes})`)
  if (!Number.isFinite(c.gitTimeoutMs) || c.gitTimeoutMs < 10_000) throw badConfig(`gitTimeoutMs must be >= 10000 (got ${c.gitTimeoutMs})`)
  if (!Object.values(CONFIRM_LEVELS).includes(c.confirmLevel)) throw badConfig(`confirmLevel must be one of ${Object.values(CONFIRM_LEVELS).join('|')}`)
  c.secretGroups = { ...Object.fromEntries(Object.values(SECRET_GROUPS).map((g) => [g, true])), ...(c.secretGroups ?? {}) }
  return c
}

/** 状态行 schema（对外导出是为了让"⊇ emptyState()"守卫有可测句柄）。 */
export const stateSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1).max(64).nullable(),
  confirmedOnce: z.boolean(),
  lastSyncedAt: z.number().int().nonnegative(),
  lastPushAt: z.number().int().nonnegative(),
  lastPullAt: z.number().int().nonnegative(),
  lastError: z.object({ code: z.string(), message: z.string().max(2000), at: z.number() }).nullable(),
  backoffUntil: z.number().int().nonnegative(),
  tombstones: z.record(z.string(), z.object({ at: z.number() })),
  history: z.array(z.record(z.string(), z.unknown())).max(50),
  settings: z.record(z.string(), z.unknown()).optional(),
})

export const omnisyncDomainSpec = defineDomain({ name: DOMAIN_NAME, version: 1, tables: { state: domainTable(stateSchema) } })
