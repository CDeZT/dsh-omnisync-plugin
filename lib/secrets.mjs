// lib/secrets.mjs — 密钥形态识别与占位符回填（纯函数，零依赖）。
// 铁律：分组开关关掉 = 该组只留本机，**绝不明文上传**（没有任何"关了加密就明文"的路径）。

/** 已知密钥形态（导出时挖出 → 密文；导入时回填）。改这张表必须同步 sanitize.mjs 的脱敏前缀表。 */
export const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,          // OpenAI/DeepSeek
  /\btvly-[A-Za-z0-9_-]{8,}\b/gu,        // Tavily
  /\bsci_[A-Za-z0-9_-]{8,}\b/gu,         // SciVerse
  /\bghp_[A-Za-z0-9]{16,}\b/gu,          // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,  // GitHub fine-grained
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, // JWT
])

/** 占位符（导出时替换，导入时回填）。 */
export const REDACT_PLACEHOLDER = '<REDACTED-BY-OMNISYNC>'

/** 挖出文本里的密钥、替换为占位符并返回原值表（MCP 内嵌 key 住在 patch yaml 明文里，
 *  不挖出来就会直接进 git）。 */
export function extractSecrets(text) {
  let out = String(text)
  const found = []
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      const placeholder = `${REDACT_PLACEHOLDER}:${found.length}`
      found.push({ placeholder, value: match })
      return placeholder
    })
  }
  return { text: out, found }
}

/** 回填：把占位符换回原值。
 *  **必须长占位符优先**：`:1` 是 `:10` 的前缀，按发现顺序 split/join 会把 `<…>:10` 从中间
 *  劈开 —— 第 10 个秘密丢失、第 1 个被复制过去（MCP 内嵌 key 静默错位）。前缀关系必然意味着
 *  "更短"，按长度降序替换即可一次做对。 */
export function restoreSecrets(text, found) {
  // found 来自密文袋（外部数据）：形状不对就原样返回，绝不炸调用栈。
  const pairs = (Array.isArray(found) ? found : [])
    .filter((p) => typeof p?.placeholder === 'string' && p.placeholder.length > 0)
  const ordered = [...pairs].sort((a, b) => b.placeholder.length - a.placeholder.length)
  let out = String(text)
  for (const { placeholder, value } of ordered) out = out.split(placeholder).join(value)
  return out
}
