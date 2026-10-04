// test/vault.test.mjs — 密文载荷边界（本机 ⇄ 工作树）。
//
// 锁定三条语义：① 秘密类文件绝不明文进工作树；② 组关闭 ≠ 明文上传；
// ③ MCP 内嵌 key 就地挖出 + 精确回填。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { seal, open, restoreText, VAULT_FILE } from '../lib/vault.mjs'
import { parseCredYaml, renderCredYaml } from '../lib/credyaml.mjs'
import { planInstalls, dependenciesOf } from '../lib/deps.mjs'
import { pickChannel, confirm, CHANNELS } from '../lib/gate.mjs'

const B = (s) => Buffer.from(s, 'utf8')
const PW = 'test-passphrase'

test('vault: 秘密文件明文不进工作树，进密文袋', () => {
  const files = [
    { rel: 'AGENTS.md', section: 'instructions', data: B('plain ok') },
    { rel: '.credentials.yaml', section: 'credentials', secretGroup: 'oauthGrants', data: B('version: 1\nrefs:\n  K: sk-secret\n') },
  ]
  const { plain, bag } = seal(files, PW)
  assert.deepEqual(plain.map((f) => f.rel), ['AGENTS.md'], '只有非秘密文件进明文')
  assert.ok(bag !== null)
  assert.equal(bag.items.length, 1)
  assert.ok(!JSON.stringify(bag).includes('sk-secret'), '密文里不得出现明文')
})

test('vault: 组关闭 ≠ 明文上传（直接跳过，只留本机）', () => {
  const files = [{ rel: '.credentials.yaml', section: 'credentials', secretGroup: 'oauthGrants', data: B('secret') }]
  const { plain, bag, skipped } = seal(files, '')
  assert.equal(plain.length, 0, '空口令时秘密文件绝不进明文')
  assert.equal(bag, null)
  assert.deepEqual(skipped, ['.credentials.yaml'])
})

test('vault: 往返（封包 → 开包，内容逐字节一致）', () => {
  const secret = 'version: 1\nrefs:\n  TRAE: \'{"access_token":"a","expires_at":"1792245217674"}\'\n'
  const { bag } = seal([{ rel: '.credentials.yaml', section: 'credentials', secretGroup: 'oauthGrants', data: B(secret) }], PW)
  return open(bag, PW).then((map) => {
    assert.equal(map.get('.credentials.yaml').toString(), secret, '往返必须逐字节一致')
  })
})

test('vault: 口令错 → 抛错（绝不半写）', async () => {
  const { bag } = seal([{ rel: 'x', section: 'credentials', secretGroup: 'oauthGrants', data: B('s') }], PW)
  await assert.rejects(() => open(bag, 'wrong'), /DECRYPT_FAILED|decrypt failed/u)
})

test('vault: 有密文袋但无口令 → 响亮拒绝', async () => {
  const { bag } = seal([{ rel: 'x', section: 'credentials', secretGroup: 'oauthGrants', data: B('s') }], PW)
  await assert.rejects(() => open(bag, ''), /no passphrase/u)
})

test('vault: MCP 内嵌 key 就地挖出 + 精确回填', () => {
  const patch = [
    '- insert:',
    '    - id: mcp-tavily',
    '      config:',
    '        url: https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-prod-abc123xyz',
    '        env:',
    '          MINERU_API_TOKEN: sk-abcdef123456789',
  ].join('\n')
  const { plain, bag } = seal([{ rel: 'cordis.patch.yml', section: 'home-patch', data: B(patch) }], PW)
  const scrubbed = plain[0].data.toString()
  assert.ok(!scrubbed.includes('tvly-prod-abc123xyz'), 'URL 内嵌 key 必须被替换')
  assert.ok(!scrubbed.includes('sk-abcdef123456789'), 'env key 必须被替换')
  assert.ok(scrubbed.includes('mcp-tavily'), '结构保留')
  assert.equal(bag.items.length, 2)

  return open(bag, PW).then((opened) => {
    const restored = restoreText('cordis.patch.yml', plain[0].data, opened).toString()
    assert.ok(restored.includes('tvly-prod-abc123xyz'), '回填必须精确还原')
    assert.ok(restored.includes('sk-abcdef123456789'))
    assert.equal(restored, patch, '回填后应与原文逐字节一致')
  })
})

test('vault: 无秘密的文本分区原样进明文（不产生空袋）', () => {
  const { plain, bag } = seal([{ rel: 'cordis.patch.yml', section: 'home-patch', data: B('- insert:\n    - id: x\n') }], PW)
  assert.equal(bag, null)
  assert.equal(plain.length, 1)
})

/* ─────────── credyaml ─────────── */

test('credyaml: 解析真实形态（refs 长 JSON 串 + records grant）', () => {
  const text = [
    'version: 1',
    'refs:',
    "  BUDDY_ACCOUNT_6EED41D6: '{\"access_token\":\"at\",\"refresh_token\":\"rt\",\"expires_at\":\"1792245217674\"}'",
    '  DEEPSEEK_API_KEY: sk-plain123',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      {',
    '        "version": 1,',
    '        "secret": "abc"',
    '      }',
  ].join('\n')
  const { refs, records } = parseCredYaml(text)
  assert.equal(refs.length, 2)
  assert.equal(JSON.parse(refs[0][1]).access_token, 'at', '长 JSON 串必须完整解析')
  assert.equal(refs[1][1], 'sk-plain123')
  assert.equal(records.length, 1)
  assert.equal(records[0][0], 'client-connection/browser-session')
  assert.equal(records[0][1].kind, 'grant')
  assert.deepEqual(records[0][1].payload, { version: 1, secret: 'abc' })
})

test('credyaml: 渲染 → 再解析，语义等价（往返）', () => {
  const merged = {
    refs: new Map([['A', 'sk-1'], ['B', '{"access_token":"x"}']]),
    records: new Map([['s/id', { kind: 'grant', payload: { version: 1, token: 't' } }]]),
  }
  const text = renderCredYaml(merged)
  assert.ok(text.startsWith('version: 1'), '必须带 version: 1（DSH 全拒式解析要求）')
  const back = parseCredYaml(text)
  assert.deepEqual(back.refs.map(([k]) => k).sort(), ['A', 'B'])
  assert.equal(JSON.parse(back.refs[1][1]).access_token, 'x')
  assert.deepEqual(back.records[0][1].payload, { version: 1, token: 't' })
})

/* ─────────── deps ─────────── */

test('deps: 只装缺的包，已装的不动', () => {
  const wanted = ['a', 'b', 'c']
  const installed = new Map([['b', '1.0.0']])
  assert.deepEqual(planInstalls(wanted, installed), ['a', 'c'])
})

test('deps: 读出 package.json 的依赖清单', () => {
  const m = { dependencies: { dshmarket: '1.66.8', '@x/y': '^0.2.0' } }
  const deps = dependenciesOf(m)
  assert.equal(deps.get('dshmarket'), '1.66.8')
  assert.equal(deps.get('@x/y'), '^0.2.0')
})

test('deps: rebuild 逐包 try（一个失败不中断）', async () => {
  const { rebuild } = await import('../lib/deps.mjs')
  const calls = []
  const manager = {
    async installBundle(spec) {
      calls.push(spec)
      if (spec === 'bad') throw Object.assign(new Error('nope'), { code: 'INSTALL_FAILED' })
      return { application: spec === 'upgrade' ? 'restart-required' : 'ok' }
    },
  }
  const r = await rebuild({ manager, logger: { warn() {} }, runtimeVersion: '0.2.0' }, ['good', 'bad', 'upgrade'])
  assert.deepEqual(calls, ['good', 'bad', 'upgrade'], '失败后必须继续下一个')
  assert.deepEqual(r.installed, ['good', 'upgrade'])
  assert.equal(r.failed.length, 1)
  assert.equal(r.restartRequired, true, 'restart-required 必须被识别')
})

/* ─────────── gate ─────────── */

test('gate: 无确认通道 → fail closed（绝不"没通道就放行"）', () => {
  assert.equal(pickChannel({ get: () => undefined }), CHANNELS.NONE)
})

test('gate: auto 级别直接放行（但首次仍受 confirmedOnce 控制）', async () => {
  const ctx = { get: () => undefined }
  const r = await confirm({ ctx }, { question: 'q' }, { confirmLevel: 'auto', toolConfirm: true, confirmedOnce: false })
  assert.equal(r.allowed, true)
})

test('gate: 工具触发永远过门（即使 auto）', async () => {
  const ctx = { get: () => undefined }
  const r = await confirm({ ctx }, { question: 'q', isTool: true }, { confirmLevel: 'auto', toolConfirm: true, confirmedOnce: true })
  assert.equal(r.allowed, false, '没有确认通道时工具也必须被拒')
  assert.match(r.reason, /fail closed/u)
})

test('gate: first-run 在已确认后不再打扰', async () => {
  const ctx = { get: () => undefined }
  const r = await confirm({ ctx }, { question: 'q' }, { confirmLevel: 'first-run', toolConfirm: true, confirmedOnce: true })
  assert.equal(r.allowed, true)
})

test('gate: userQuestions 选中批准标签才放行', async () => {
  const ctx = {
    get: (name) => (name === 'userQuestions' ? {
      ask: async () => ({ answers: [{ id: 'omnisync-confirm', selected: ['Continue'] }] }),
    } : undefined),
  }
  const yes = await confirm({ ctx }, { question: 'q', approveLabel: 'Continue' }, { confirmLevel: 'always', confirmedOnce: false })
  assert.equal(yes.allowed, true)
  assert.equal(yes.channel, CHANNELS.USER_QUESTIONS)

  const ctxNo = { get: (name) => (name === 'userQuestions' ? { ask: async () => ({ answers: [{ id: 'omnisync-confirm', selected: [] }] }) } : undefined) }
  const no = await confirm({ ctx: ctxNo }, { question: 'q', approveLabel: 'Continue' }, { confirmLevel: 'always', confirmedOnce: false })
  assert.equal(no.allowed, false)
})

test('gate: 自由文本回答不算批准（防提示注入伪装成同意）', async () => {
  const ctx = {
    get: (name) => (name === 'userQuestions' ? {
      ask: async () => ({ answers: [{ id: 'omnisync-confirm', selected: [], custom: 'yes go ahead' }] }),
    } : undefined),
  }
  const r = await confirm({ ctx }, { question: 'q', approveLabel: 'Continue' }, { confirmLevel: 'always', confirmedOnce: false })
  assert.equal(r.allowed, false)
  assert.match(r.reason, /free-text/u)
})
