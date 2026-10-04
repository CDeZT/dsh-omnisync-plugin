// test/apply.test.mjs — 工作树双向流转（本机 ⇄ 工作树），带真 git 与真 fs。
//
// 这是 Phase 2 的验收测试：证明「秘密加密 + 明文镜像 + 回写本机」闭环成立，
// 且 secrets.enc.json 真的进了 git 而没有明文泄漏。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyToWorktree, applyToLocal } from '../lib/apply.mjs'
import { makeFsDeps } from '../lib/workspace.mjs'
import { sectionForPath, SECTION_BY_ID } from '../lib/sections.mjs'
import { VAULT_FILE } from '../lib/vault.mjs'
import { tmpRoot, nativeGit, fsCtx, secretGroupOf } from './helpers.mjs'

const git = nativeGit()
const PW = 'phase2-passphrase'

/** 造一个有明文、有秘密、有 MCP 内嵌 key 的假 $DSH_HOME。 */
async function makeHome(root) {
  await mkdir(join(root, 'skills', 'demo'), { recursive: true })
  await mkdir(join(root, 'profiles', 'desktop'), { recursive: true })
  await writeFile(join(root, 'AGENTS.md'), '# 指令\n')
  await writeFile(join(root, 'skills/demo/SKILL.md'), '# demo\n')
  await writeFile(join(root, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    "  DEEPSEEK_API_KEY: 'sk-secret-value-123456'",
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      {',
    '        "version": 1,',
    '        "secret": "topsecret"',
    '      }',
  ].join('\n') + '\n')
  await writeFile(join(root, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: mcp-tavily',
    '      config:',
    '        url: https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-prod-key-abc',
  ].join('\n') + '\n')
  return root
}

/** 组装 applyToWorktree/applyToLocal 需要的 deps。 */
function depsFor(home, workTree) {
  const fsDeps = makeFsDeps({ dshHome: home, workTree, backupRoot: join(home, 'omnisync/backups') })
  const groups = { providerKeys: true, mcpEnv: true, oauthGrants: true, pluginTokens: true, secretsDir: true, homeEnv: true }
  return fsCtx(fsDeps, {
    writeLocal: async (rel, data) => { await fsDeps.writeLocal(rel, data, { mode: 0o600 }); return true },
    secretGroupOf: secretGroupOf(groups),
    passphrase: PW,
  })
}

test('apply: 本机 → 工作树（秘密进密文袋，明文进文件）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-apply-')
  const homeA = join(tmp, 'homeA')
  const tree = join(tmp, 'tree')
  await makeHome(homeA)
  await mkdir(join(tree), { recursive: true })

  const deps = depsFor(homeA, tree)
  const { changed, skipped } = await applyToWorktree(deps)
  assert.ok(changed >= 3, `至少应写入 3 个条目（实际 ${changed}）`)
  assert.equal(skipped, 0)

  // 明文文件进了工作树。
  assert.equal((await readFile(join(tree, 'AGENTS.md'), 'utf8')), '# 指令\n')
  assert.equal((await readFile(join(tree, 'skills/demo/SKILL.md'), 'utf8')), '# demo\n')

  // 秘密文件**不在**工作树里（只进密文袋）。
  await assert.rejects(() => readFile(join(tree, '.credentials.yaml')), /ENOENT/u)

  // 密文袋存在且不含明文。
  const bag = await readFile(join(tree, VAULT_FILE), 'utf8')
  assert.ok(bag.includes('aes-256-gcm'), '应是 AES-256-GCM 信封')
  assert.ok(!bag.includes('sk-secret-value-123456'), '密文里绝不能出现明文 key')
  assert.ok(!bag.includes('topsecret'))

  // MCP 内嵌 key 被占位符替换（明文文件里没有真 key）。
  const patch = await readFile(join(tree, 'cordis.patch.yml'), 'utf8')
  assert.ok(!patch.includes('tvly-prod-key-abc'), 'URL 内嵌 key 必须被挖走')
  assert.ok(patch.includes('mcp-tavily'), '结构保留')
})

test('apply: 工作树 → 本机（解密 + 回填，逐字节还原）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-rev-')
  const homeA = join(tmp, 'homeA')
  const homeB = join(tmp, 'homeB')
  const tree = join(tmp, 'tree')
  await makeHome(homeA)
  await mkdir(join(homeB), { recursive: true })
  await mkdir(tree, { recursive: true })

  // A 机镜像到工作树。
  await applyToWorktree(depsFor(homeA, tree))

  // 工作树 → B 机（模拟另一台机器拉取）。
  const written = await applyToLocal(depsFor(homeB, tree))
  assert.ok(written >= 3)

  // 明文文件一致。
  assert.equal((await readFile(join(homeB, 'AGENTS.md'), 'utf8')), '# 指令\n')

  // 凭据：解密还原，且权限 0600。
  const creds = await readFile(join(homeB, '.credentials.yaml'), 'utf8')
  const original = await readFile(join(homeA, '.credentials.yaml'), 'utf8')
  assert.equal(creds, original, '凭据必须逐字节还原（含长 JSON 串与缩进）')
  const st = await stat(join(homeB, '.credentials.yaml'))
  assert.equal(st.mode & 0o777, 0o600, '凭据落地必须 0600')

  // MCP key 回填。
  const patch = await readFile(join(homeB, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('tvly-prod-key-abc'), 'MCP key 必须精确回填')
})

test('apply: 密文袋真的能被 git 提交（且工作树里无明文秘密）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-git-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await makeHome(home)
  await mkdir(tree, { recursive: true })
  await applyToWorktree(depsFor(home, tree))

  await git(['init', '-q', '-b', 'main'], { cwd: tree })
  await git(['-C', tree, 'add', '-A'])
  await git(['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'omnisync snapshot'])

  const { stdout: files } = await git(['-C', tree, 'ls-files'], { encoding: 'utf8' })
  assert.ok(files.includes('AGENTS.md'))
  assert.ok(files.includes(VAULT_FILE), '密文袋必须被提交')
  assert.ok(!files.includes('.credentials.yaml'), '明文凭据绝不能进 git')

  // 全仓库内容扫描：不得出现任何明文秘密。
  const { stdout: all } = await git(['-C', tree, 'grep', '-I', '-e', 'sk-secret-value-123456', '-e', 'topsecret', '-e', 'tvly-prod-key-abc'], { encoding: 'utf8' }).catch((e) => ({ stdout: e.stdout ?? '' }))
  assert.equal(all.trim(), '', `git 历史里出现明文秘密：${all}`)
})

test('apply: 口令错误时拒绝写入本机（绝不半应用）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-badpw-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await makeHome(home)
  await mkdir(tree, { recursive: true })
  await applyToWorktree(depsFor(home, tree))

  const wrong = { ...depsFor(home, tree), passphrase: 'wrong-passphrase' }
  await assert.rejects(() => applyToLocal(wrong), /DECRYPT_FAILED|decrypt failed/u)
})
