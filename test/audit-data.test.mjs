// test/audit-data.test.mjs — 数据流转层审计（task-3）。
//
// 纪律：每个「修复」都先在这里留下一个能复现它的失败测试。
// 覆盖范围：lib/state.mjs、lib/secrets.mjs、lib/sanitize.mjs、lib/crypto.mjs、
//           lib/apply.mjs、lib/vault.mjs、lib/paths.mjs、lib/sections.mjs、lib/sessions.mjs。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { emptyState, migrateState, updateTombstones, deriveDeviceId } from '../lib/state.mjs'
import { extractSecrets, restoreSecrets, SECRET_PATTERNS, REDACT_PLACEHOLDER } from '../lib/secrets.mjs'
import { redactText, sanitizeRemote } from '../lib/sanitize.mjs'
import { encryptBag, decryptBag, KDF } from '../lib/crypto.mjs'
import { applyToLocal, applyToWorktree } from '../lib/apply.mjs'
import { VAULT_FILE, open } from '../lib/vault.mjs'
import { sectionForPath, SECTION_BY_ID } from '../lib/sections.mjs'
import { NEVER_SYNC, HOST_ARTIFACT_NAME_RE } from '../lib/constants.mjs'
import { assertRelPath, resolveLivePath, templatize, detemplatize, projectKey, encodeSegment, isWithin } from '../lib/paths.mjs'
import { rebindText, needsRebind } from '../lib/rebind.mjs'
import { isSessionPath, SESSION_RE } from '../lib/sessions.mjs'
import { tmpRoot, secretGroupOf } from './helpers.mjs'

/* ═══════════ 第 3 轮 ═══════════ */

test('apply: 写本机前自动备份（README:74 的承诺，只备份会被改动的文件）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-backup-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await mkdir(join(home), { recursive: true })
  await mkdir(tree, { recursive: true })
  // 本机旧内容 + 远端新内容；另有一个两边完全一致的文件（不该被备份/重写）。
  // 刻意不用 storages/workspace.json：它属重定基分区，会被 JSON 规范化改写，
  // 不适合当"逐字节一致"的样本。
  await mkdir(join(home, 'jet-hub'), { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), '# OLD local\n')
  await writeFile(join(home, 'jet-hub/state.json'), '{"same":1}')
  await mkdir(join(tree, 'jet-hub'), { recursive: true })
  await writeFile(join(tree, 'AGENTS.md'), '# NEW from remote\n')
  await writeFile(join(tree, 'jet-hub/state.json'), '{"same":1}')

  const backupDirs = []
  const backedUp = []
  const base = await realCtx(home, tree, { passphrase: 'pw' })
  const ctx = {
    ...base,
    backupDir: async (kind) => { const d = join(home, 'omnisync/backups', `${kind}-1`); backupDirs.push(d); return d },
    // 与 workspace.mjs 的 backupFile 同形：从本机读旧内容写进备份目录（保持相对结构）。
    backupFile: async (rel, dir) => {
      const buf = await readFile(join(home, rel)).catch(() => null)
      if (buf === null) return null
      backedUp.push(rel)
      await mkdir(join(dir, rel, '..'), { recursive: true })
      await writeFile(join(dir, rel), buf)
      return join(dir, rel)
    },
    logger: { warn() {} },
  }

  const written = await applyToLocal(ctx)

  // ① 被覆盖的文件：旧内容必须能在备份目录里取回。
  assert.equal(backupDirs.length, 1, '一轮只应开一个备份目录')
  assert.equal((await readFile(join(backupDirs[0], 'AGENTS.md'), 'utf8')), '# OLD local\n',
    '备份里必须是**旧**内容（写前备份，写后就晚了）')
  assert.equal((await readFile(join(home, 'AGENTS.md'), 'utf8')), '# NEW from remote\n', '本机应被更新')
  assert.equal(written, 1)
  // ② 内容一致被跳过的文件不得备份（否则每轮堆垃圾）。
  assert.deepEqual(backedUp, ['AGENTS.md'], `只该备份真正被改动的文件，实际：${backedUp.join(', ')}`)
})

test('apply: 备份失败不得让整轮同步失败（记 warn 继续写）', async (t) => {
  const tmp = await tmpRoot(t, 'omni-bkfail-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await mkdir(home, { recursive: true })
  await mkdir(tree, { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), '# old\n')
  await writeFile(join(tree, 'AGENTS.md'), '# new\n')

  const warns = []
  const base = await realCtx(home, tree, { passphrase: 'pw' })
  const written = await applyToLocal({
    ...base,
    backupDir: async () => { throw new Error('disk full') },
    backupFile: async () => { throw new Error('disk full') },
    logger: { warn: (m) => warns.push(m) },
  })

  assert.equal(written, 1, '备份是后悔药，不是同步的前置条件')
  assert.equal((await readFile(join(home, 'AGENTS.md'), 'utf8')), '# new\n', '本机仍须更新')
  assert.ok(warns.some((m) => /backup/u.test(m)), `应记一条 warn，实际：${JSON.stringify(warns)}`)
})

test('apply: 备份目录（omnisync/**）绝不可能进通道（SELF_RE 锁）', async (t) => {
  // 备份是明文副本：一旦它被遍历进工作树，等于把"已经删掉的旧秘密"重新推上云。
  const tmp = await tmpRoot(t, 'omni-selfre-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await seedHome(home)
  await mkdir(tree, { recursive: true })
  await mkdir(join(home, 'omnisync/backups/pull-1'), { recursive: true })
  await mkdir(join(home, 'omnisync/repo'), { recursive: true })
  await writeFile(join(home, 'omnisync/backups/pull-1/AGENTS.md'), '# OLD LEAKME\n')
  await writeFile(join(home, 'omnisync/repo/AGENTS.md'), '# OLD LEAKME\n')

  await applyToWorktree(await realCtx(home, tree, { passphrase: 'pw' }))

  const files = await readTreeAll(tree)
  const escaped = files.filter(([p]) => p.includes('/omnisync/'))
  assert.deepEqual(escaped.map(([p]) => p), [], '备份/工作树自身绝不能进通道')
  assert.deepEqual(files.filter(([, t]) => t.includes('LEAKME')), [], '备份里的旧内容不得泄漏到工作树')
})

test('vault: 有袋无口令必须是领域错误码（不得抛裸 Error）', async () => {
  // errors.mjs 的契约是"每个错误都带稳定 code 供 UI 路由"，裸 Error 没有 code，
  // 也会绕过兜底脱敏。README 承诺的口令提示正是靠这条路径呈现给用户。
  const bag = encryptBag([{ rel: 'a', plain: Buffer.from('s', 'utf8') }], 'pw')
  await assert.rejects(() => open(bag, ''), (err) => {
    assert.equal(err.code, 'DECRYPT_FAILED', `code 应为 DECRYPT_FAILED，实际 ${err.code}`)
    assert.match(err.message, /passphrase/u)
    return true
  })
})

test('secrets: restoreSecrets 对非数组输入必须容错（不得抛 TypeError）', () => {
  // 占位符表来自密文袋，属于"外部数据"：形状不对时应原样返回，绝不炸调用栈。
  assert.equal(restoreSecrets('a<b>:0c', undefined), 'a<b>:0c')
  assert.equal(restoreSecrets('x', null), 'x')
  assert.equal(restoreSecrets('x', 'not-an-array'), 'x')
  assert.equal(restoreSecrets('x', [null, 42, { placeholder: '' }]), 'x')
  // 正常路径不受影响。
  assert.equal(restoreSecrets('a<R>:0b', [{ placeholder: '<R>:0', value: 'X' }]), 'aXb')
})

test('apply: 恶意 rel 无法写出 $DSH_HOME（真 fs 端到端证明）', async (t) => {
  // Lead 要求的安全证明：构造一个"远端可写"的密文袋，确认没有任何字节落到
  // $DSH_HOME 之外 —— 包括 `..` 穿越、绝对路径、NEVER_SYNC 项。
  const tmp = await tmpRoot(t, 'omni-escape-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await mkdir(home, { recursive: true })
  await mkdir(tree, { recursive: true })
  const passphrase = 'pw'
  const bag = encryptBag([
    { rel: '../outside.txt', plain: Buffer.from('pwned', 'utf8') },
    { rel: '../../outside.txt', plain: Buffer.from('pwned', 'utf8') },
    { rel: '/tmp/omnisync-absolute-pwned.txt', plain: Buffer.from('pwned', 'utf8') },
    { rel: 'omnisync/github.token', plain: Buffer.from('ghp_AAAAAAAAAAAAAAAAAAAA', 'utf8') },
    { rel: 'omnisync/passphrase.vault', plain: Buffer.from('pw', 'utf8') },
    { rel: 'unknown/not-registered.txt', plain: Buffer.from('pwned', 'utf8') },
    { rel: 'secrets/legit.key', plain: Buffer.from('legit', 'utf8') },
  ], passphrase)
  const base = await realCtx(home, tree, { passphrase })
  await applyToLocal({ ...base, readTree: async (rel) => (rel === VAULT_FILE ? Buffer.from(JSON.stringify(bag), 'utf8') : null) })

  // $DSH_HOME 之外只应有 home/tree 两个目录（不许出现 outside.txt / 绝对路径文件）。
  const top = (await readdir(tmp)).sort()
  assert.deepEqual(top, ['home', 'tree'], `$DSH_HOME 之外出现了新文件：${top.join(', ')}`)
  const inHome = await readdir(home)
  assert.deepEqual(inHome.sort(), ['secrets'], `只该落注册表内的 secrets/legit.key，实际：${inHome.join(', ')}`)
  assert.deepEqual(await readdir(join(home, 'secrets')), ['legit.key'])
})


/* ═══════════ 第 2 轮（含真 fs 的 ctx 助手）═══════════ */

/**
 * 真实 fs 的 applyToWorktree/applyToLocal deps。
 * 自带实现（不用 workspace.mjs 的 makeFsDeps）：审计期间那个文件正被别人改，
 * 测试不该因为别人的半成品而红；这里也刻意复刻生产的两条收口 ——
 * 写入前 assertRelPath、内容一致时 writeTree 返回 false。
 */
async function realCtx(home, tree, { passphrase = 'pw', disabledGroups = [] } = {}) {

  const safe = (root, rel) => {
    assertRelPath(rel)
    const abs = join(root, rel)
    if (!abs.startsWith(root + '/')) throw new Error(`escaped root: ${rel}`)
    return abs
  }
  const readMaybe = async (abs) => readFile(abs).catch(() => null)
  const listAll = async (root, skipGit) => {
    const out = []
    const walkDir = async (dir, prefix) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (skipGit && e.name === '.git') continue
        const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
        if (e.isDirectory()) await walkDir(join(dir, e.name), rel)
        else out.push(rel)
      }
    }
    await walkDir(root, '').catch(() => {})
    return out
  }
  const writeAt = async (abs, data, mode) => {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, data, { mode })
  }

  const groups = Object.fromEntries(['providerKeys', 'mcpEnv', 'oauthGrants', 'pluginTokens', 'secretsDir', 'homeEnv']
    .map((g) => [g, !disabledGroups.includes(g)]))
  return {
    // 刻意**不**在这里剪掉 omnisync/**：生产 walker 会剪，但 apply.mjs 自己的
    // SELF_RE 才是最后一道闸，测试要锁的是它（防御纵深）。
    walk: async () => (await listAll(home, false))
      .filter((rel) => !HOST_ARTIFACT_NAME_RE.test(rel.split('/').pop()))
      .map((rel) => ({ rel })),
    read: (rel) => readMaybe(safe(home, rel)),
    writeTree: async (rel, data) => {
      const abs = safe(tree, rel)
      const existing = await readMaybe(abs)
      if (existing !== null && existing.equals(data)) return false
      await writeAt(abs, data, 0o644)
      return true
    },
    removeTree: async (rel) => rm(safe(tree, rel)).then(() => true, () => false),
    listTree: () => listAll(tree, true),
    readTree: (rel) => readMaybe(safe(tree, rel)),
    readLocal: (rel) => readMaybe(safe(home, rel)),
    writeLocal: async (rel, data) => { await writeAt(safe(home, rel), data, 0o600); return true },
    sectionOf: (rel) => sectionForPath(rel, 'desktop')?.id ?? null,
    secretGroupOf: secretGroupOf(groups),
    passphrase,
  }
}

/** 造一个含凭据/.env/secrets 的最小 $DSH_HOME。 */
async function seedHome(home) {
  await mkdir(join(home, 'secrets'), { recursive: true })
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'AGENTS.md'), '# ok\n')
  await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  K: sk-plain-LEAKME-123456\n')
  await writeFile(join(home, '.env'), 'HOME_TOKEN=tvly-LEAKME-abcdefgh\n')
  await writeFile(join(home, 'secrets/skill.key'), 'sci_LEAKME_abcdefgh\n')
}

/** 递归收集工作树里的全部文件内容（用于"明文泄漏"扫描）。 */
async function readTreeAll(tree) {
  const out = []
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push([p, (await readFile(p)).toString('utf8')])
    }
  }
  await walk(tree)
  return out
}

test('vault: 组关闭 ≠ 明文上传（关掉的组必须整份跳过，绝不降级明文）', async (t) => {
  // 铁律原文：关掉 = 只留本机，**绝不明文上传**。
  // 但 secretGroupOf() 把"该分区没有密级"和"声明了密级但用户关掉了"都返回 null，
  // 而 seal() 只判 `secretGroup != null` —— 于是关掉 oauthGrants 后
  // .credentials.yaml 会走"无密级"分支，原样明文写进工作树并提交上云。
  const tmp = await tmpRoot(t, 'omni-groupoff-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await seedHome(home)
  await mkdir(tree, { recursive: true })

  const { changed, skipped } = await applyToWorktree(
    await realCtx(home, tree, { disabledGroups: ['oauthGrants', 'homeEnv', 'secretsDir'] }))

  const files = await readTreeAll(tree)
  const leaked = files.filter(([, text]) => text.includes('LEAKME'))
  assert.deepEqual(leaked.map(([p]) => p), [],
    `关掉的组被明文上传了：${leaked.map(([p]) => p).join(', ')}`)
  assert.ok(!files.some(([p]) => p.endsWith('.credentials.yaml')), '凭据不得进工作树')
  assert.equal(skipped, 3, `三个关闭组的文件都应记为 skipped（实际 ${skipped}）`)
  // 非秘密分区照常同步（不能因为修这个就把正常路径也堵死）。
  assert.ok(files.some(([p]) => p.endsWith('AGENTS.md')), '非秘密分区必须照常进工作树')
  assert.ok(changed >= 1)
})

test('apply: 无口令的一轮不得删掉工作树里既有的密文袋（那是云端的唯一副本）', async (t) => {
  // passphrase 来源是 env 或 0600 文件，都可能临时读不到。此时秘密文件全部 skipped、
  // bag 为 null，而 applyToWorktree 的清理循环会把"不在 wanted 里"的条目删掉 ——
  // 于是 secrets.enc.json 被删并随下一次 push 提交，云端密文永久消失。
  const tmp = await tmpRoot(t, 'omni-nopw-')
  const home = join(tmp, 'home')
  const tree = join(tmp, 'tree')
  await seedHome(home)
  await mkdir(tree, { recursive: true })

  await applyToWorktree(await realCtx(home, tree, { passphrase: 'pw' }))
  const bagPath = join(tree, VAULT_FILE)
  const before = await readFile(bagPath, 'utf8')
  assert.ok(before.includes('aes-256-gcm'), '前置条件：密文袋应已生成')

  await applyToWorktree(await realCtx(home, tree, { passphrase: '' }))

  const after = await readFile(bagPath, 'utf8').catch(() => null)
  assert.equal(after, before, '无口令的一轮必须保留原密文袋（不得删除、不得改写）')
  // 同时：绝不能因为"没口令"就把秘密明文写进工作树。
  const files = await readTreeAll(tree)
  assert.deepEqual(files.filter(([, t]) => t.includes('LEAKME')), [], '无口令时也不得明文上传')
})

test('apply: 密文袋整文件回填必须幂等（内容一致就不得重写本机）', async () => {
  // 树文件回填有幂等检查（注释明确说：否则每轮重写全部本机文件 → 触发 DSH
  // chokidar 热重载、放大回声窗口），但密文袋的整文件回填没有 —— 每轮 pull
  // 都会重写 .credentials.yaml / .env / secrets/*，白触发一次热重载。
  const passphrase = 'audit-passphrase'
  const plain = Buffer.from('version: 1\nrefs:\n  K: sk-x\n', 'utf8')
  const bag = encryptBag([{ rel: '.credentials.yaml', plain }], passphrase)
  const writes = []
  const ctx = {
    passphrase,
    readTree: async (rel) => (rel === VAULT_FILE ? Buffer.from(JSON.stringify(bag), 'utf8') : null),
    listTree: async () => [],
    sectionOf: (rel) => sectionForPath(rel, 'desktop')?.id ?? null,
    readLocal: async (rel) => (rel === '.credentials.yaml' ? plain : null),
    writeLocal: async (rel) => { writes.push(rel); return true },
  }

  const written = await applyToLocal(ctx)
  assert.deepEqual(writes, [], '内容一致时不得重写（幂等）')
  assert.equal(written, 0)

  // 内容不同时仍必须落盘（幂等检查不能变成"永不更新"）。
  const ctx2 = { ...ctx, readLocal: async () => Buffer.from('old', 'utf8') }
  assert.equal(await applyToLocal(ctx2), 1)
  assert.deepEqual(writes, ['.credentials.yaml'])
})

test('apply: 密文袋 JSON 损坏 → 领域错误码（不得抛裸 SyntaxError）', async () => {
  // secrets.enc.json 会被 git 合并、可能带冲突标记或被截断。裸 SyntaxError
  // 没有 code，UI/日志无法路由，也绕过了 errors.mjs 的兜底脱敏。
  const ctx = {
    passphrase: 'pw',
    readTree: async (rel) => (rel === VAULT_FILE ? Buffer.from('<<<<<<< HEAD\n{broken', 'utf8') : null),
    listTree: async () => [],
    sectionOf: () => null,
    writeLocal: async () => true,
  }
  await assert.rejects(() => applyToLocal(ctx), (err) => {
    assert.equal(err.code, 'DECRYPT_FAILED', `应收敛为 DECRYPT_FAILED，实际 code=${err.code}（${err.message}）`)
    return true
  })
})


/* ═══════════ 第 1 轮 ═══════════ */

test('state: migrateState 必须保留 settings（否则每次重启静默丢用户偏好）', () => {
  // 真实链路：index.mjs 的 zod schema 声明了 settings（可选），
  // 用户偏好由 mergeSettings() 写进 state.settings，重启时 applySettings() 读它。
  // 但 migrateState() 只回填 emptyState() 里存在的键 —— settings 不在其中 → 被静默丢弃。
  const loaded = migrateState({ version: 1, settings: { repo: 'me/private', confirmLevel: 'auto' } })
  assert.deepEqual(loaded.settings, { repo: 'me/private', confirmLevel: 'auto' },
    'settings 被 migrateState 丢掉 → 用户每次重启都要重新配置')
})

test('state: emptyState 必须覆盖「会落盘的键」（settings 漂移守卫）', () => {
  // 与 domain.test.mjs 的「schema ⊇ emptyState」守卫互补：那条只能发现
  // emptyState 多出来的键，发现不了 schema 有、emptyState 没有的键（= 丢数据）。
  const persisted = ['version', 'deviceId', 'confirmedOnce', 'lastSyncedAt', 'lastPushAt',
    'lastPullAt', 'lastError', 'backoffUntil', 'tombstones', 'history', 'settings']
  const missing = persisted.filter((k) => !(k in emptyState()))
  assert.deepEqual(missing, [], `emptyState 缺少落盘键：${missing.join(',')} → migrateState 会剥掉它们`)
})

test('secrets: 11 个秘密必须精确回填（占位符互为前缀时不得错位）', () => {
  // 占位符是 `<REDACTED-BY-OMNISYNC>:<序号>`，而 `:1` 是 `:10` 的前缀。
  // 逐个 split/join 会把 `<…>:10` 从中间劈开 → 第 10 个秘密丢失 + 第 1 个秘密被复制。
  const values = Array.from({ length: 11 }, (_, i) => `tvly-key-${String(i).padStart(4, '0')}`)
  const original = values.map((v, i) => `key${i}=${v}`).join('\n') + '\n'

  const { text, found } = extractSecrets(original)
  assert.equal(found.length, 11, `应挖出 11 个秘密（实际 ${found.length}）`)
  assert.ok(!text.includes(values[10]), '第 11 个秘密必须已被占位符替换')
  assert.equal(found[10].placeholder, `${REDACT_PLACEHOLDER}:10`, '第 11 个占位符应为 :10')

  const restored = restoreSecrets(text, found)
  assert.equal(restored, original, '回填必须逐字节还原（占位符前缀碰撞会让 :1 吃掉 :10）')
  assert.ok(restored.includes(values[10]), '第 11 个秘密不得丢失')
})

test('sanitize: 脱敏必须覆盖 secrets.mjs 认得的全部密钥形态（单一真相源交叉核对）', () => {
  // 两份形态表曾漂移：sanitize 缺 sci_（SciVerse）与 github_pat_（fine-grained PAT，
  // 正是本插件自己用的形态）→ git stderr / 错误消息里的真 token 会原样进日志。
  // 样本表与 SECRET_PATTERNS 一一对应；条数不符即说明形态表变了、这里没跟上。
  const samples = [
    'sk-abcdefgh12345678',                                            // OpenAI/DeepSeek
    'tvly-abcdefgh12345678',                                          // Tavily
    'sci_abcdefgh12345678',                                           // SciVerse
    'ghp_ABCDEFGHIJKLMNOPQRST',                                       // GitHub classic PAT
    'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',              // GitHub fine-grained PAT
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ]
  assert.equal(samples.length, SECRET_PATTERNS.length,
    'secrets.mjs 的形态表变了 —— 请给新形态补样本（不是放宽这条核对）')
  for (const sample of samples) {
    assert.ok(extractSecrets(`k=${sample}`).found.length > 0, `secrets.mjs 认不得这个形态：${sample}`)
    const safe = redactText(`fatal: ${sample} rejected`)
    assert.ok(!safe.includes(sample), `sanitize 漏掉该形态 → 明文泄漏进日志：${sample}`)
  }
})

test('apply: 密文袋里的 rel 必须过路径安全 + 注册表校验（防远端构造越界写入）', async () => {
  // secrets.enc.json 是**远端内容**：旧版本插件、被篡改的仓库、或口令共享的
  // 另一台机器都能决定袋里的 rel。applyToLocal 的整文件秘密回填循环此前直接
  // writeLocal(key) —— 既不 assertRelPath 也不查注册表，连 NEVER_SYNC 都不拦。
  const passphrase = 'audit-passphrase'
  const bag = encryptBag([
    { rel: '../../escape.txt', plain: Buffer.from('pwned', 'utf8') },
    { rel: 'omnisync/github.token', plain: Buffer.from('ghp_AAAAAAAAAAAAAAAAAAAA', 'utf8') },
    { rel: '/etc/evil', plain: Buffer.from('pwned', 'utf8') },
    { rel: 'secrets/legit.key', plain: Buffer.from('legit', 'utf8') },
  ], passphrase)

  const writes = []
  const ctx = {
    passphrase,
    readTree: async (rel) => (rel === VAULT_FILE ? Buffer.from(JSON.stringify(bag), 'utf8') : null),
    listTree: async () => [],
    sectionOf: (rel) => sectionForPath(rel, 'desktop')?.id ?? null,
    readLocal: async () => null,
    writeLocal: async (rel, data) => { writes.push(rel); return true },
  }

  await applyToLocal(ctx)

  assert.deepEqual(writes, ['secrets/legit.key'],
    `只允许写注册表内且路径安全的条目，实际写了：${JSON.stringify(writes)}`)
})

/** 断言某次调用以指定领域错误码失败（code 才是稳定契约，message 不是）。 */
function throwsCode(fn, code) {
  try {
    fn()
  } catch (err) {
    assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}（${err.message}）`)
    return
  }
  assert.fail(`应当抛出 ${code}，但没有抛错`)
}

test('paths: 越界与非法 rel 一律 PATH_UNSAFE（绝对路径/穿越/NUL/盘符）', () => {
  const bad = ['../x', 'a/../../x', '/abs', 'C:/x', 'a\0b', '']
  for (const rel of bad) {
    throwsCode(() => assertRelPath(rel), 'PATH_UNSAFE')
    throwsCode(() => resolveLivePath(rel, '/tmp/root'), 'PATH_UNSAFE')
  }
  // 正常路径不受影响。
  assert.equal(assertRelPath('a/b/c.txt'), 'a/b/c.txt')
  assert.equal(resolveLivePath('a/b.txt', '/tmp/root'), '/tmp/root/a/b.txt')
  assert.equal(resolveLivePath('a/./b.txt', '/tmp/root'), '/tmp/root/a/b.txt', '单点段应被归一')
})

test('paths: isWithin 必须按段边界比较（/a/bc 不在 /a/b 内）', () => {
  assert.equal(isWithin('/a/b', '/a/b/c'), true)
  assert.equal(isWithin('/a/b', '/a/b'), true)
  assert.equal(isWithin('/a/b', '/a/bc'), false, '字符串前缀不是包含关系')
  assert.equal(isWithin('/a/b/', '/a/b/c'), true, '尾部分隔符不该改变结论')
})

test('vault: 口令错 → DECRYPT_FAILED（密文袋绝不半写）', () => {
  const bag = encryptBag([{ rel: 'a.txt', plain: Buffer.from('secret', 'utf8') }], 'right')
  assert.throws(() => decryptBag(bag, 'wrong'), /DECRYPT_FAILED|decrypt failed/u)
  assert.throws(() => decryptBag(bag, ''), /DECRYPT_FAILED|decrypt failed/u, '空口令必须拒绝而不是当成"没加密"')
  assert.throws(() => decryptBag({ ...bag, v: 99 }, 'right'), /DECRYPT_FAILED|decrypt failed/u, '版本不符必须拒绝')
  assert.throws(() => decryptBag({ ...bag, items: 'nope' }, 'right'), /DECRYPT_FAILED|decrypt failed/u)
})

test('crypto: 每条目独立随机 iv（同明文两次封包密文必不同）', () => {
  const items = [{ rel: 'x', plain: Buffer.from('same', 'utf8') }, { rel: 'y', plain: Buffer.from('same', 'utf8') }]
  const bag = encryptBag(items, 'pw')
  assert.notEqual(bag.items[0].iv, bag.items[1].iv, '同 key 重用 iv 会毁掉 GCM 安全性')
  const bag2 = encryptBag(items, 'pw')
  assert.notEqual(bag.kdf.salt, bag2.kdf.salt, '盐必须每次随机')
  // 往返仍逐字节一致。
  const back = decryptBag(bag, 'pw')
  assert.equal(back[0].plain.toString('utf8'), 'same')
  assert.equal(back[1].rel, 'y', '非 plain 字段必须原样透传')
})

test('state: 墓碑保留最早 at、过期清理、不改入参', () => {
  const now = 1_000_000_000_000
  const ttl = 1000
  const input = { old: { at: now - 5000 }, keep: { at: now - 100 } }
  const out = updateTombstones(input, ['keep', 'fresh'], now, ttl)
  assert.deepEqual(Object.keys(out).sort(), ['fresh', 'keep'], '过期墓碑必须退休')
  assert.equal(out.keep.at, now - 100, '已存在的墓碑必须保留最早 at（否则 TTL 永不到期）')
  assert.equal(out.fresh.at, now)
  assert.deepEqual(Object.keys(input).sort(), ['keep', 'old'], '不得改入参')
})

test('state: deriveDeviceId 确定性且非空（主机名缺失也必须有值）', () => {
  assert.equal(deriveDeviceId('host', 'darwin'), deriveDeviceId('host', 'darwin'))
  assert.notEqual(deriveDeviceId('host-a', 'darwin'), deriveDeviceId('host-b', 'darwin'))
  assert.match(deriveDeviceId(undefined, undefined), /^[0-9a-f]{8}$/u)
})

test('sections: 每个注册表条目的真实路径都能命中（17 条不许有孤儿）', () => {
  const probes = [
    ['cordis.patch.yml', 'home-patch'],
    ['profiles/desktop/package.json', 'profile-manifest'],
    ['profiles/desktop/cordis.patch.yml', 'profile-patch'],
    ['.credentials.yaml', 'credentials'],
    ['storages/workspace.json', 'workspace'],
    ['AGENTS.md', 'instructions'],
    ['skills/demo/SKILL.md', 'skills-dsh'],
    ['secrets/token.txt', 'skills-secrets'],
    ['.env', 'env-home'],
    ['attachments/v1/objects/ab/cdef', 'attachments'],
    ['jet-hub/state.json', 'jet-hub-state'],
    ['dsh-builtin-browser-host/settings.json', 'browser-settings'],
    ['agy-link/sessions.json', 'agy-sessions'],
    ['profiles/desktop/.dsh-market/state.json', 'market-state'],
    ['omnisync-devices/host.json', 'device-health'],
    ['sessions/abc.jsonl', 'sessions'],
    ['storages/session_projcache/x.json', 'sessions-projcache'],
  ]
  for (const [rel, id] of probes) {
    assert.equal(sectionForPath(rel, 'desktop')?.id, id, `${rel} 应命中 ${id}`)
  }
  assert.equal(sectionForPath('random/unknown.txt', 'desktop'), null, '注册表之外必须默认拒绝')
})

test('sections: NEVER_SYNC 每条都不得被任何分区命中（硬排除不许漏）', () => {
  for (const rel of NEVER_SYNC) {
    assert.equal(sectionForPath(rel, 'desktop'), null, `NEVER_SYNC 项 ${rel} 被注册表命中了`)
  }
})

test('sessions: isSessionPath 只认会话类路径（不误伤同名目录）', () => {
  assert.equal(isSessionPath('sessions/a.jsonl'), true)
  assert.equal(isSessionPath('storages/session_projcache/a.json'), true)
  assert.equal(isSessionPath('my-sessions/a.jsonl'), false, '前缀必须锚定在开头')
  assert.equal(isSessionPath('storages/workspace.json'), false)
  assert.equal(SESSION_RE.test('sessions'), false, '目录本身不是文件')
})

test('rebind: 模板化/还原对称，非 JSON 原样返回', () => {
  const vars = { home: '/Users/a', dshHome: '/Users/a/.dsh' }
  const doc = Buffer.from(JSON.stringify({ tables: { w: { path: '/Users/a/Documents/proj' } } }), 'utf8')
  assert.equal(needsRebind('workspace'), true)
  assert.equal(needsRebind('home-patch'), false)

  const tpl = rebindText(doc, 'templatize', vars)
  assert.ok(tpl.toString('utf8').includes('${HOME}/Documents/proj'), '绝对路径必须模板化')
  const back = rebindText(tpl, 'detemplatize', { home: '/Users/b', dshHome: '/Users/b/.dsh' })
  assert.equal(JSON.parse(back.toString('utf8')).tables.w.path, '/Users/b/Documents/proj',
    'A 机路径必须还原成 B 机路径')

  const notJson = Buffer.from('this is not json: {', 'utf8')
  assert.equal(rebindText(notJson, 'templatize', vars), notJson, '非 JSON 必须原样返回（不得损坏）')
})

test('paths: projectKey / encodeSegment 与官方语义一致（分隔符折叠、特殊字符转义）', () => {
  assert.equal(encodeSegment('a.b-c_d'), 'a.b-c_d')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a b'), 'a~0020b')
  assert.equal(encodeSegment('~'), '~007E')
  assert.throws(() => encodeSegment(''), /empty path segment/u)

  assert.equal(projectKey('/Users/x/proj'), '--Users-x-proj--')
  assert.equal(projectKey('/a//b'), '--a-b--', '连续分隔符折叠为一个 -')
  assert.equal(projectKey('C:\\a\\b'), '--C-a-b--', 'Windows 分隔符同口径')
  assert.equal(projectKey('/'), '--root--', '去前导 - 后为空则用 root')
  assert.throws(() => projectKey(''), /empty project path/u)
})

test('paths: 命令路径模板按平台还原（分隔符风格跟模板走）', () => {
  const win = templatize('C:\\Users\\a\\AppData\\Roaming\\npm\\npx.cmd', 'C:\\Users\\a', 'C:\\Users\\a\\.dsh')
  assert.ok(win.includes('${CMD:npx}'), `Windows 命令路径应被模板化：${win}`)
  assert.ok(!win.includes('Users\\a\\AppData'), '模板化必须真的替换掉')
  const back = detemplatize(win, '/Users/b', '/Users/b/.dsh', 'darwin')
  assert.equal(back, '/opt/homebrew/bin/npx', 'darwin 上应还原为 mac 的 npx 绝对路径')
})

test('crypto: KDF 参数不可被静默篡改（信封自带参数，解密按信封派生）', () => {
  assert.equal(KDF.NAME, 'scrypt')
  const bag = encryptBag([{ rel: 'a', plain: Buffer.from('x', 'utf8') }], 'pw')
  // 篡改 N 会让派生出的 key 不同 → 必须报 DECRYPT_FAILED，而不是静默解出垃圾。
  const tampered = { ...bag, kdf: { ...bag.kdf, N: 16384 } }
  assert.throws(() => decryptBag(tampered, 'pw'), /DECRYPT_FAILED|decrypt failed/u)
  // 盐被改成非法 base64：也必须收敛到同一个错误（不泄露失败方向）。
  const badSalt = { ...bag, kdf: { ...bag.kdf, salt: 12345 } }
  assert.throws(() => decryptBag(badSalt, 'pw'), /DECRYPT_FAILED|decrypt failed/u)
})

test('sanitize: remote URL 与自由文本脱敏不得漏（含 scp 语法与非字符串输入）', () => {
  assert.equal(sanitizeRemote('https://user:ghp_AAAAAAAAAAAAAAAAAAAA@github.com/o/r.git'),
    'https://user:***@github.com/o/r.git')
  assert.ok(sanitizeRemote('https://x.test/?access_token=ghp_AAAAAAAAAAAAAAAAAAAA').includes('***'))
  assert.equal(sanitizeRemote(''), '<unset>')
  assert.equal(sanitizeRemote(null), '<unset>')
  assert.equal(sanitizeRemote('git@github.com:o/r.git'), 'git@github.com:o/r.git', 'scp 语法无密码，原样保留')

  assert.ok(!redactText('Authorization: Bearer abcdefgh12345678').includes('abcdefgh12345678'))
  assert.ok(!redactText('api_key=abcdefgh12345678').includes('abcdefgh12345678'))
  assert.ok(!redactText('https://u:p4ssw0rd@host/x').includes('p4ssw0rd'))
  assert.equal(redactText(undefined), 'undefined', '非字符串先强转再脱敏（不得跳过管线）')
  // String(Symbol) 本身不抛错；真正的风险是恶意 toString —— 那条必须退到占位符。
  assert.equal(redactText(Symbol('s')), 'Symbol(s)')
  const hostile = { toString() { throw new Error('boom') } }
  assert.equal(redactText(hostile), '<non-text>', 'toString 抛错时绝不能炸调用栈')
})
