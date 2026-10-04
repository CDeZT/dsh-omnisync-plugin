// scripts/dev-link.mjs — 把 peer 依赖软链到本机 DSH 安装，供本地跑测试。
//
// 为什么需要：插件的 peer 依赖（@deepseek-ai/*）不随包发布，运行时由 DSH
// 安装目录提供（Electron 会透明读 app.asar）。本地跑 `node --test` 时没有
// 那个解析锚点，所以临时链一份过来。
//
// 用法：node scripts/dev-link.mjs [dsh源码根]
//   默认按顺序探测常见位置；找不到就报错退出（不静默）。

import { existsSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 候选锚点：已解包的 app.asar 或任意含 node_modules/@deepseek-ai 的目录。 */
const CANDIDATES = [
  process.argv[2],
  join(root, '..', 'dsh-src-extracted/extracted/dsh/node_modules'),
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules',
  join((process.env.HOME ?? process.env.USERPROFILE ?? homedir()), '.dsh/profiles/desktop/node_modules'),
].filter(Boolean)

const source = CANDIDATES.find((p) => existsSync(join(p, '@deepseek-ai')))
if (source === undefined) {
  console.error(`dev-link: 找不到 DSH 包目录。试过：\n  ${CANDIDATES.join('\n  ')}\n请传入源码根：node scripts/dev-link.mjs <路径>`)
  process.exit(1)
}

const target = join(root, 'node_modules')
rmSync(target, { recursive: true, force: true })
mkdirSync(join(target, '@deepseek-ai'), { recursive: true })

let linked = 0
for (const [scope, dir] of [['@deepseek-ai', join(source, '@deepseek-ai')], ['', source]]) {
  if (!existsSync(dir)) continue
  for (const entry of readdirSync(dir)) {
    const from = join(dir, entry)
    const to = join(target, scope, entry)
    if (existsSync(to) || !existsSync(join(from, 'package.json'))) continue
    symlinkSync(from, to, 'dir')
    linked += 1
  }
}
console.log(`dev-link: 已从 ${source} 链入 ${linked} 个包 → ${target}`)
