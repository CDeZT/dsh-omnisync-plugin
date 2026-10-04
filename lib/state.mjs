// lib/state.mjs — 同步状态存取（纯函数：读写经 deps 注入的 domain 表）。
//
// 职责：基线（逐文件 pendingBoth）、墓碑（防删了又复活）、设备 ID、
// 确认级别的"已确认过"标记、最近错误。落盘由 index.mjs 的
// storageDomain 接线完成，这里只定义数据形状与迁移规则。
//
// 关键设计（全部有实证依据）：
// - 基线必须是 map<path, baseCommit>，不是单个 lastSyncedCommit
//   （dsh-sync 真机教训：基线推进到远端 tip 后，未解决文件的对端
//   改动会在下一次推送时被覆盖 —— pendingBoth 钉住每个未解决文件）。
// - 墓碑删除优先（用户登出不应被对端刷新复活），TTL 90 天。
// - confirmedOnce 一旦为 true 不回退（首次确认的不可降级性）。

/** 状态文档形状（storageDomain 的 singleton 行）。 */
export function emptyState() {
  return {
    version: 1,
    deviceId: null,            // hostname+platform 哈希 8 位
    confirmedOnce: false,      // 首次确认（不可回退）
    lastSyncedAt: 0,           // epoch ms
    lastPushAt: 0,
    lastPullAt: 0,
    lastError: null,           // {code, message, at}
    backoffUntil: 0,           // 退避到期（epoch ms；0 = 无退避）
    tombstones: {},            // key → {at}（凭据删除墓碑）
    history: [],               // 最近 N 轮摘要
    // settings 必须在这里：migrateState() 只回填 emptyState 里存在的键，
    // 漏一个就 = 每次重启静默丢掉它（用户偏好会反复要重新配置）。
    settings: {},              // { repo?, confirmLevel?, secretGroups? }
  }
}

/** 状态迁移：合并读到的旧行（缺字段补默认，多余字段忽略）。 */
export function migrateState(raw) {
  const fresh = emptyState()
  if (raw === null || typeof raw !== 'object') return fresh
  if (raw.version !== 1) return fresh // 版本不符 = 全新开始（不猜）
  for (const key of Object.keys(fresh)) {
    if (raw[key] !== undefined) fresh[key] = raw[key]
  }
  return fresh
}

/**
 * 记录一条历史（环形，保 20 条）。
 * @returns {string[]} 新数组。
 */
export function pushHistory(history, entry) {
  const next = [...(history ?? []), { at: Date.now(), ...entry }]
  return next.slice(-20)
}

/**
 * 墓碑记账：把本轮"消失的凭据键"记为删除墓碑，并清掉过期的。
 *
 * 为什么需要：git 三方合并能处理删除，但**合并基点丢失时**（历史重写/浅克隆）
 * 就退化成两方比较 —— 远端"没有这个键"和"从没存在过"无法区分，本机残留的
 * 旧值会被推回去（删除复活）。墓碑补上这个信息。
 *
 * @param {object} tombstones - 现有墓碑 map。
 * @param {string[]} deletedKeys - 本轮合并后消失的键。
 * @param {number} now - epoch ms。
 * @param {number} [ttlMs] - 墓碑有效期。
 * @returns {object} 新 map（不改入参）。
 */
export function updateTombstones(tombstones, deletedKeys, now, ttlMs = 90 * 24 * 3600_000) {
  const next = {}
  for (const [key, value] of Object.entries(tombstones ?? {})) {
    if (now - (value?.at ?? 0) <= ttlMs) next[key] = value // 过期即退休
  }
  for (const key of deletedKeys ?? []) {
    if (next[key] === undefined) next[key] = { at: now } // 保留最早 at，TTL 才会到期
  }
  return next
}

/**
 * 设备 ID 派生（确定性：hostname+platform 哈希取 8 位十六进制）。
 * 主机名不可用时回退 platform 常量（保证永远非空）。
 */
export function deriveDeviceId(hostname, platform) {
  const src = `${hostname ?? 'unknown-host'}|${platform ?? 'unknown-platform'}`
  // FNV-1a 32 位 ×2 轮拼接出 8 hex —— 零依赖且稳定。
  let h1 = 0x811c9dc5
  for (let i = 0; i < src.length; i++) {
    h1 ^= src.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  let h2 = 0x01000193
  for (let i = src.length - 1; i >= 0; i--) {
    h2 ^= src.charCodeAt(i)
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 8)
}

/**
 * 把用户偏好合并进状态（UI 唯一写入点，避免入口文件里堆 setter）。
 * @param {object} state - 当前状态。
 * @param {object} patch - { repo?, confirmLevel?, secretGroups? }。
 * @returns {object} 合并后的 settings。
 */
export function mergeSettings(state, patch) {
  const cur = state.settings ?? {}
  const next = { ...cur }
  if (patch.repo !== undefined) next.repo = patch.repo
  if (patch.confirmLevel !== undefined) next.confirmLevel = patch.confirmLevel
  if (patch.secretGroups !== undefined) next.secretGroups = { ...(cur.secretGroups ?? {}), ...patch.secretGroups }
  if (patch.disabledSections !== undefined) next.disabledSections = [...patch.disabledSections]
  state.settings = next
  return next
}

/** 把持久化的偏好套用到运行期配置（启动时一次）。 */
export function applySettings(cfg, settings) {
  if (settings === undefined || settings === null) return cfg
  if (settings.confirmLevel !== undefined) cfg.confirmLevel = settings.confirmLevel
  if (settings.secretGroups !== undefined) cfg.secretGroups = { ...cfg.secretGroups, ...settings.secretGroups }
  if (settings.disabledSections !== undefined) cfg.disabledSections = [...settings.disabledSections]
  if (settings.repo !== undefined && cfg.repo === '') cfg.repo = settings.repo
  return cfg
}
