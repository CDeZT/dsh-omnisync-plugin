// lib/errors.mjs — SyncError 家族（稳定 code + details，零依赖）。
//
// 脱敏兜底放在**构造函数**里：早先的纪律是"调用方先脱敏"，但漏过一次 ——
// git stderr 里的令牌经 gitFailed() 进 message，而 message 随 lastError
// 同步上云。纪律靠不住，底层兜底才靠得住（重复脱敏幂等，无害）。
// details 只装机器可读事实（动词/路径/类别），绝不装原始 stderr 或密文。

import { redactText } from './sanitize.mjs'

/** 领域错误码：值=键，UI/日志按它路由；只增不改。 */
export const ERROR_CODES = Object.freeze({
  BAD_CONFIG: 'BAD_CONFIG',
  BAD_INPUT: 'BAD_INPUT',
  GIT_FAILED: 'GIT_FAILED',
  PUSH_REJECTED: 'PUSH_REJECTED',
  AUTH_BLOCKED: 'AUTH_BLOCKED',
  PATH_UNSAFE: 'PATH_UNSAFE',
  SNAPSHOT_CORRUPT: 'SNAPSHOT_CORRUPT',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  BACKEND_UNSUPPORTED: 'BACKEND_UNSUPPORTED',
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
})

/**
 * 插件领域错误基类。
 * @param {string} code - ERROR_CODES 之一。
 * @param {string} message - 面向用户的说明（构造时自动脱敏）。
 * @param {object} [details] - 结构化事实，兜底 {} 保证消费方无需判空。
 */
export class SyncError extends Error {
  constructor(code, message, details) {
    super(redactText(typeof message === 'string' ? message : String(message)))
    this.name = 'SyncError'
    this.code = code
    this.details = details ?? {}
  }
}

/** git 命令失败（verb/tail 供 UI 定位到具体动作）。 */
export function gitFailed(verb, tail) {
  return new SyncError(ERROR_CODES.GIT_FAILED, `git ${verb} failed: ${tail}`, { verb, tail })
}

/** push 被远端拒绝 → 调用方拉取后重试，绝不强推。 */
export function pushRejected(tail) {
  return new SyncError(ERROR_CODES.PUSH_REJECTED, `git push rejected (never force-pushed): ${tail}`, { tail })
}

/** 拼接前拒绝：绝不把根外的路径写进工作树或报告。 */
export function pathUnsafe(op, rel) {
  return new SyncError(ERROR_CODES.PATH_UNSAFE, `unsafe path refused (${op}): ${rel}`, { op, rel })
}

/** 认证通道被阻断 —— 失败关闭，绝不降级成匿名或明文。 */
export function authBlocked(kind) {
  return new SyncError(ERROR_CODES.AUTH_BLOCKED, `auth blocked: ${kind}`, { kind })
}

/** 解密失败 —— 绝不把密文当明文降级使用。 */
export function decryptFailed(what) {
  return new SyncError(ERROR_CODES.DECRYPT_FAILED, `decrypt failed: ${what}`, { what })
}

/** 后端不可用（网盘未挂载 / 只读 / 同步中 / 非裸仓）。 */
export function backendUnsupported(reason, detail) {
  return new SyncError(ERROR_CODES.BACKEND_UNSUPPORTED, `backend unavailable: ${reason}${detail === undefined ? '' : ` (${detail})`}`, { reason })
}

/** 加密面入参非法 —— 响亮拒绝而非静默，绝不带病加密。 */
export function badInput(what) {
  return new SyncError(ERROR_CODES.BAD_INPUT, `bad input: ${what}`, { what })
}

/** 配置非法（加载期响亮失败，绝不半可用）。 */
export function badConfig(message) {
  return new SyncError(ERROR_CODES.BAD_CONFIG, `omnisync config: ${message}`)
}
