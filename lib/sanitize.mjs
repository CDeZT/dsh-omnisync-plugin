// lib/sanitize.mjs — 展示/日志脱敏纯函数（零依赖）。
// 边界：可能携带凭据的文本（remote URL、git stderr、错误消息）在进入日志、命令结果或模型
// 可见面之前必须先过这里。全部函数不抛错、不碰 I/O；输入不合法时返回保守值，绝不原样透传。

/** URL 查询串中视为凭据的键名（值整体打码）。 */
const CREDENTIAL_QUERY_KEYS = /^(?:access_?token|token|key|secret|password|passwd|auth|credential|code|signature|x-amz-|sig)$/iu

/** 常见令牌形态：已知前缀 + 足够长的 secret 才认定，避免误伤短普通词。前缀表必须与
 *  secrets.mjs 的 SECRET_PATTERNS 对齐 —— `sci_` 与 `github_pat_`（**本插件自己用的
 *  fine-grained PAT**）曾在这里缺失，git stderr 里的真 token 就原样进了日志。 */
const TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|tvly-[A-Za-z0-9_-]{8,}|sci_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|authorization:\s*[A-Za-z0-9._~+/=-]{8,})/giu

/** JWT：eyJ 即 `{"` 的 base64 前缀。整段不足 40 字符不认定——短的 eyJ 开头串极易是普通文本。 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_.-]{37,}/gu

/** key=value 形态的凭据（值整体打码，键保留以便排障）。 */
const CREDENTIAL_ASSIGNMENT = /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|auth|password|passwd|client[_-]?secret|private[_-]?key)\s*=\s*)([^\s&;,]+)/giu

/** URL userinfo（user:password@）——git stderr 可能回显远端地址。 */
const URL_USERINFO = /\/\/([^/\s:@]+):([^/\s@]+)@/gu

/** 脱敏 remote URL：userinfo 密码与凭据查询键的值打码。scp 语法（user@host:path）不含密码，
 *  原样保留（用户名不是秘密）；非法输入 '<unset>'，URL 解析失败原样返回（无凭据可打码）。 */
export function sanitizeRemote(remote) {
  if (typeof remote !== 'string' || remote.length === 0) return '<unset>'
  try {
    const url = new URL(remote.trim())
    if (url.password !== '') url.password = '***'
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_QUERY_KEYS.test(key)) url.searchParams.set(key, '***')
    }
    return url.toString()
  } catch {
    return remote
  }
}

/** 文本脱敏：令牌、Bearer/authorization 头、key=value 凭据、URL userinfo 全部打码。非字符串
 *  先强转再脱敏 —— 强转结果同样可能携带秘密，绝不跳过管线。 */
export function redactText(text) {
  const input = typeof text === 'string' ? text : safeString(text)
  return input
    .replace(TOKEN_PATTERN, '***')
    .replace(JWT_PATTERN, '***')
    .replace(CREDENTIAL_ASSIGNMENT, '$1***')
    .replace(URL_USERINFO, '//$1:***@')
}

/** 恶意 toString 会让 String() 抛错——退到占位符，绝不炸调用栈。 */
function safeString(value) {
  try {
    return String(value)
  } catch {
    return '<non-text>'
  }
}
