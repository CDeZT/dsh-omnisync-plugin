// scripts/test-pure.mjs — 只跑**不依赖宿主**的测试（任何机器都能跑，无需 DSH）。
//
// 为什么需要：本插件是 DSH 插件，一部分测试天然需要宿主（`@deepseek-ai/*` peer 依赖，
// 不随仓库分发）与 `npm install`（zod）。于是"克隆下来直接 npm test"会红一片 ——
// 看着像插件坏了，其实只是缺宿主。这里把**能独立验证的部分**单独跑：
// 合并内核、凭据解析、路径、脱敏、加密、会话裁决、附件寻址、网盘后端、安全守卫 ——
// 也就是"最容易出错、也最值得先验证"的那部分。
//
// 用法：node scripts/test-pure.mjs   （或 npm run test:pure）

import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const TEST_DIR = join(ROOT, 'test')

/** 需要宿主或第三方依赖的模块（静态 import 链里出现这些即排除）。 */
// 精确锚定"插件入口 / 需要宿主的两个 lib 模块" —— 静态与动态 import 都要认。
// ★ 别用宽松的 /index\.mjs'/：它会命中 `lib/mergers/index.mjs`，把纯逻辑测试误伤掉
//   （实测一次误伤 10 个文件）。锚定 `../index.mjs` 这个具体路径才对。
const HOST_MARKERS = [
  /(?:from|import\()\s*'@deepseek-ai\//u,
  /(?:from|import\()\s*'zod'/u,
  /(?:from|import\()\s*'\.\.\/index\.mjs'/u,
  /(?:from|import\()\s*'\.\.\/lib\/(?:tools|config)\.mjs'/u,
]

/** 递归找静态 import 是否触及宿主依赖（只看 test/ 与 lib/ 的一跳链）。 */
function needsHost(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return false
  seen.add(file)
  const src = readFileSync(file, 'utf8')
  for (const re of HOST_MARKERS) if (re.test(src)) return true
  // 追一跳本地依赖
  for (const m of src.matchAll(/from '(\.[^']+)'/gu)) {
    const rel = m[1].replace(/^\.\.\//u, '').replace(/^\.\//u, '')
    const base = file.includes('/test/') ? join(ROOT, rel) : join(ROOT, 'lib', rel.replace(/^lib\//u, ''))
    if (needsHost(base, seen)) return true
  }
  return false
}

const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).sort()
const pure = files.filter((f) => !needsHost(join(TEST_DIR, f)))
const host = files.filter((f) => !pure.includes(f))

console.log(`纯逻辑测试 ${pure.length} 个文件（无需宿主、无需 npm install）`)
console.log(`需宿主的 ${host.length} 个：${host.join(', ')}`)
console.log('─'.repeat(60))

const child = spawn(process.execPath, ['--test', ...pure.map((f) => join(TEST_DIR, f))], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
