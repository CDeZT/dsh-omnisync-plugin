// test/guards.test.mjs — 安全不变量守卫（"守卫测试的守卫"）。
//
// 为什么需要：精简轮最大的风险不是"测试红了"（那会立刻发现），而是**有人删掉一处
// 没有测试覆盖的防御性检查** —— 代码更短了、测试全绿、安全性静默下降。
//
// 本文件对每条安全不变量做**行为级**断言（不是 grep 源码文本 —— 那样重构就会误报）。
// 每条都注明"删掉它会怎样"，方便后来者判断能不能动。

import { test } from 'node:test'
import assert from 'node:assert/strict'
// 本文件的守卫全部是**纯行为断言**（不建临时目录、不碰文件系统）——
// 需要落地场景的守卫已由各模块自己的测试覆盖（那些会建真目录）。

/* ── 不变量 1：路径越界一律拒绝 ─────────────────────────────────────
   删掉会怎样：远端可构造 `../../x` 写穿 $DSH_HOME（真发生过：密文袋回填直写）。 */

test('守卫: 路径越界必须拒绝（绝对/穿越/盘符/UNC/NUL）', async () => {
  const { assertRelPath } = await import('../lib/paths.mjs')
  for (const bad of ['/etc/passwd', '../../x', 'a/../../x', 'C:\\Windows\\x', '\\\\srv\\share\\x', 'a\0b']) {
    assert.throws(() => assertRelPath(bad), (e) => e.code === 'PATH_UNSAFE', `${bad} 必须被拒`)
  }
  assert.doesNotThrow(() => assertRelPath('sessions/p/s/x.jsonl'))
})

/* ── 不变量 2：硬排除清单真的生效 ───────────────────────────────────
   删掉会怎样：令牌/口令/设备身份/浏览器历史进通道并上云。 */

test('守卫: 硬排除清单必须覆盖秘密与设备身份', async () => {
  const { isNeverSynced, NEVER_SYNC_PATTERNS } = await import('../lib/constants.mjs')
  const { sectionForPath } = await import('../lib/sections.mjs')
  const must = [
    'omnisync/github.token',            // PAT 本体
    'omnisync/passphrase.vault',        // 口令本体
    'storages/omnisync.json',           // 本插件状态（deviceId/墓碑，按设备隔离）
    '.anonymous-user-id',               // 设备身份
    'agy-link/runtime-overrides.json',  // 本机端口/路径
    'dsh-builtin-browser-host/history.jsonl',
  ]
  for (const rel of must) {
    assert.equal(sectionForPath(rel, 'desktop'), null, `${rel} 不得被任何分区认领`)
    assert.equal(isNeverSynced(rel), true, `${rel} 必须被硬排除`)
  }
  assert.ok(NEVER_SYNC_PATTERNS.length > 0, '正则排除表不得为空')
})

/* ── 不变量 3：组关闭 = 整份跳过，绝不降级明文 ──────────────────────
   删掉会怎样：关掉加密开关后凭据/密钥原样明文上云（**真实事故**，实测三份 LEAKME 全在 tree 里）。 */

test('守卫: 关掉的密级分组必须整份跳过（绝不降级明文）', async () => {
  const { seal } = await import('../lib/vault.mjs')
  const files = [
    { rel: '.credentials.yaml', section: 'credentials', secretGroup: null, data: Buffer.from('LEAKME-1') },
    { rel: '.env', section: 'env-home', secretGroup: null, data: Buffer.from('LEAKME-2') },
    { rel: 'AGENTS.md', section: 'instructions', secretGroup: undefined, data: Buffer.from('# ok') },
  ]
  const { plain, bag, skipped } = seal(files, 'pw')
  // 组关闭的文件必须既不在明文里、也不在密文袋里 —— 是**整份丢弃**。
  const leaked = plain.filter((f) => f.data.toString('utf8').includes('LEAKME'))
  assert.equal(leaked.length, 0, `组关闭的文件必须被整份丢弃，实际泄漏：${leaked.map((f) => f.rel).join(',')}`)
  assert.deepEqual(skipped.sort(), ['.credentials.yaml', '.env'], '被跳过的必须留痕，不能静默')
  const bagText = bag === null ? '' : JSON.stringify(bag)
  assert.ok(!bagText.includes('LEAKME'), '也不得把关闭分组的明文塞进密文袋')
  assert.ok(plain.some((f) => f.rel === 'AGENTS.md'), '无密级的文件必须照常通过')
})

/* ── 不变量 4：口令错 → 响亮失败，绝不半写 ──────────────────────────
   删掉会怎样：用错口令把云端密文覆盖成垃圾 = 毁掉唯一副本。 */

test('守卫: 口令错必须抛 DECRYPT_FAILED（不半写、不静默清空）', async () => {
  const { encryptBag, decryptBag } = await import('../lib/crypto.mjs')
  const bag = encryptBag([{ plain: Buffer.from('secret') }], 'right-passphrase')
  assert.throws(() => decryptBag(bag, 'wrong-passphrase'), (e) => e.code === 'DECRYPT_FAILED')
})

/* ── 不变量 5：错误消息必须脱敏 ─────────────────────────────────────
   删掉会怎样：git stderr 里的令牌经 lastError 写进体检报告并**同步上云**。 */

test('守卫: 错误消息必须脱敏（含插件自己用的 github_pat_）', async () => {
  const { gitFailed, badInput } = await import('../lib/errors.mjs')
  const samples = [
    'token=ghp_aaaaaaaaaaaaaaaaaaaa',
    'token=github_pat_11ABCDEFG0abcdefghijklmn',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'sk-abcdefgh12345678',
  ]
  for (const s of samples) {
    const msg = gitFailed('push', s).message
    assert.ok(!/ghp_|github_pat_|eyJ|sk-[a-z]/u.test(msg), `未脱敏：${msg}`)
  }
  assert.ok(!badInput('sk-abcdefgh1234').message.includes('sk-abcdefgh1234'))
})

/* ── 不变量 6：内容寻址对象必须校验「路径 == sha256(内容)」───────────
   删掉会怎样：坏内容被写成一个"看起来合法"的对象路径，污染云端唯一副本。 */

test('守卫: 篡改的附件对象必须被拒（零写入）', async () => {
  const { verifyObjectData } = await import('../lib/attachments.mjs')
  const rel = `attachments/v1/objects/bb/${'b'.repeat(64)}`
  assert.throws(() => verifyObjectData(rel, Buffer.from('tampered')), (e) => e.code === 'SNAPSHOT_CORRUPT')
})

/* ── 不变量 7：git 命令白名单（绝不 force / 改历史 / 切分支）────────
   删掉会怎样：一次误调用就能强推覆盖对端历史。 */

test('守卫: git 动词白名单必须挡住强推与历史改写', async () => {
  const { assertSafe } = await import('../lib/git.mjs')
  for (const bad of [['push', '--force'], ['push', '-f'], ['reset', '--hard'], ['rebase', 'main'], ['filter-branch'], ['commit', '--amend']]) {
    assert.throws(() => assertSafe(bad), `${bad.join(' ')} 必须被拒`)
  }
  assert.doesNotThrow(() => assertSafe(['push', 'origin', 'HEAD:refs/heads/main']))
})

/* ── 不变量 8：确认门 fail closed ───────────────────────────────────
   删掉会怎样：没有确认通道时"默认放行"，等于确认门形同虚设。 */

test('守卫: 无确认通道时必须 fail closed（不写本机）', async () => {
  const { confirm } = await import('../lib/gate.mjs')
  const r = await confirm({ ctx: { get: () => undefined } }, { question: 'q' }, { confirmLevel: 'always', confirmedOnce: false })
  assert.equal(r.allowed, false, '没有通道就必须拒绝')
})

/* ── 不变量 9：状态 schema 必须覆盖 emptyState 的每个键 ──────────────
   删掉会怎样：storageDomain 在 load 时剥掉未声明的键 → migrateState 判版本不符
   → **每次重启静默重置全部状态**（真机事故，踩过两次：version 与 settings）。 */

test('守卫: 状态 schema 必须覆盖 emptyState 的每个键', async (t) => {
  const { emptyState } = await import('../lib/state.mjs')
  const { stateSchema } = await (async () => { try { return await import('../index.mjs') } catch { return {} } })()
  // 缺宿主依赖时 index.mjs 加载不了 → 这条无法核对，**跳过而不是假绿**。
  if (stateSchema === undefined) return t.skip('缺宿主依赖，本机无法加载 index.mjs')
  // zod 的 object schema：从 shape 取键。
  const schemaKeys = new Set(Object.keys(stateSchema.shape ?? {}))
  for (const key of Object.keys(emptyState())) {
    assert.ok(schemaKeys.has(key), `schema 缺 ${key} → 重启会静默丢它`)
  }
})

/* ── 不变量 10：会话落地必须过路径裁决 ─────────────────────────────
   删掉会怎样：树里的 `sessions/../pwned` 被照写（前缀匹配照样通过）。 */

test('守卫: 会话路径裁决必须挡住穿越与宿主产物', async () => {
  const { sessionTargetVerdict } = await import('../lib/sessions.mjs')
  assert.equal(sessionTargetVerdict('sessions/../pwned.jsonl').ok, false)
  assert.equal(sessionTargetVerdict('sessions/p/s/session.lock').ok, false)
  assert.equal(sessionTargetVerdict('sessions/p/s/x.jsonl').ok, true)
})

/* ── 不变量 11：凭据合并绝不丢值（哪怕形态被规范重排）─────────────────
   删掉会怎样：合并器丢字段 → 每轮同步静默丢凭据。
   这条**刻意断言"值等价"而不是"逐字节相等"** —— 同步路径经 snapshotOf 后
   raw.chunks 丢失，走规范重排（实测 8916→8989 字节）。字节相等只在直接
   parse→render 时成立（test/audit-credyaml.test.mjs 覆盖）。这里钉住的是
   真正要紧的那条：**一个值都不许丢**。 */

test('守卫: 凭据经同步路径合并后值必须完全等价（形态可变，值不可丢）', async () => {
  const { parseCredYaml, renderCredYaml } = await import('../lib/credyaml.mjs')
  const { mergeCredentials, snapshotOf } = await import('../lib/mergers/credentials.mjs')

  // 用真实形态的样本：长 JSON ref（折行）、嵌套 payload 映射、多种键名。
  const doc = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: LEAKME-REC',
    'refs:',
    "  openai: '{\"access_token\":\"LEAKME-A\",\"expires_at\":\"2099-01-01T00:00:00Z\"}'",
    "  Acme/Default: '{\"access_token\":\"LEAKME-B\"}'",
    '',
  ].join('\n')

  const p = parseCredYaml(doc)
  const snap = snapshotOf({ refs: Object.fromEntries(p.refs), records: Object.fromEntries(p.records) })
  // 三方相同（无改动）→ 合并结果必须与原文值等价。
  const { merged } = mergeCredentials(snap, snap, snap)
  const back = parseCredYaml(renderCredYaml(merged))

  assert.deepEqual(back.refs, p.refs, 'refs 一个都不许丢/改')
  assert.deepEqual(back.records, p.records, 'records 一个都不许丢/改')
  assert.equal(p.refs.length, 2)
  assert.equal(p.records.length, 1)
})

/* ── 不变量 12：家目录解析必须跨平台（Windows 无 HOME）───────────────
   删掉会怎样：`${process.env.HOME ?? ''}/.dsh` 在 Windows 上（HOME 常未设置）
   推出 `/.dsh` = **当前盘根下的目录**，插件读写一个完全错误的位置且不报错。 */

test('守卫: 家目录解析必须回退到 USERPROFILE / os.homedir（Windows 无 HOME）', async () => {
  const { userHome } = await import('../lib/paths.mjs')
  const real = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    // 模拟 Windows：HOME 不存在，只有 USERPROFILE。
    delete process.env.HOME
    process.env.USERPROFILE = 'C:\\Users\\demo'
    assert.equal(userHome(), 'C:\\Users\\demo', '必须回退到 USERPROFILE')
    // 两者都没有 → 必须回退到 os.homedir()，绝不能返回空串以外的错值。
    delete process.env.USERPROFILE
    const { homedir } = await import('node:os')
    assert.equal(userHome(), homedir(), '必须回退到 os.homedir()')
    assert.notEqual(userHome(), '', 'os.homedir() 拿不到时也必须是空串（调用方可判不可用），不能是 "/"')
  } finally {
    if (real.HOME === undefined) delete process.env.HOME; else process.env.HOME = real.HOME
    if (real.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = real.USERPROFILE
  }
})

/* ── 不变量 13：仓库输入必须接受用户自然会粘的写法 ───────────────────
   删掉会怎样：用户在"仓库"框里粘浏览器地址（最自然的操作）→ 报
   `repo must be owner/name` —— 把实现细节推给用户。 */

test('守卫: 仓库输入归一（接受 URL / git@ / .git / 空格，拒绝多段与空）', async () => {
  const { normalizeRepo } = await import('../lib/routes.mjs')
  const ok = [
    ['CDeZT/dsh-omnisync', 'CDeZT/dsh-omnisync'],
    ['https://github.com/CDeZT/dsh-omnisync', 'CDeZT/dsh-omnisync'],
    ['https://github.com/CDeZT/dsh-omnisync.git', 'CDeZT/dsh-omnisync'],
    ['git@github.com:CDeZT/dsh-omnisync.git', 'CDeZT/dsh-omnisync'],
    ['github.com/CDeZT/dsh-omnisync/', 'CDeZT/dsh-omnisync'],
    ['  CDeZT/dsh-omnisync  ', 'CDeZT/dsh-omnisync'],
  ]
  for (const [input, want] of ok) assert.equal(normalizeRepo(input), want, `${input} 应归一为 ${want}`)
  // 非法形态必须拒绝 —— 尤其 `a/b/c`（曾因无条件丢首段被误收成 `b/c`）。
  for (const bad of ['a/b/c', 'bad', '', '   ', 'owner/', '/name', 'https://github.com/only-one']) {
    assert.equal(normalizeRepo(bad), null, `${JSON.stringify(bad)} 必须被拒`)
  }
})

/* ── 不变量 14：绝不能把路径型 GIT_* 置空（置空 = 弄坏 git）────────────
   删掉会怎样：线上真实故障 —— `GIT_WORK_TREE=''` 让 `git init` 报
   "The empty string is not a valid path"，插件首次引导直接失败。
   更险的是 `GIT_INDEX_FILE=''`：**不报错**，但索引变空 → 所有文件显示为已删除
   → 会让插件提交一次大规模误删。 */

test('守卫: 路径型 GIT_* 绝不出现在置空清单里（并真的能被 git 接受）', async (t) => {
  const { GIT_ENV_SCRUB, GIT_ENV_FORBIDDEN } = await import('../lib/git.mjs')
  // ① 两张表不许重叠 —— 重叠就意味着又把这些变量喂成空串。
  for (const k of GIT_ENV_FORBIDDEN) {
    assert.ok(!GIT_ENV_SCRUB.includes(k), `${k} 绝不能出现在置空清单里（置空会让 git 报错或索引变空）`)
  }
  assert.ok(GIT_ENV_FORBIDDEN.includes('GIT_DIR') && GIT_ENV_FORBIDDEN.includes('GIT_INDEX_FILE'))

  // ② 行为验证：按"可置空清单"构造 env 跑真 git，必须成功。
  //    （只断言表内容是不够的 —— 那样重构一下变量名就失效了。）
  const { tmpRoot, gitOut, writeAt } = await import('./helpers.mjs')
  const root = await tmpRoot(t, 'omni-gitenv-')
  const env = Object.fromEntries(GIT_ENV_SCRUB.map((k) => [k, '']))
  await gitOut(['init', '-q', '-b', 'main'], { cwd: root, env })
  await writeAt(`${root}/a.txt`, 'x')
  await gitOut(['add', '-A'], { cwd: root, env })
  const st = await gitOut(['status', '--porcelain'], { cwd: root, env })
  // 关键：索引必须是**真的**写进去了 —— 若 GIT_INDEX_FILE 被置空，
  // 这里会看到 "D a.txt"（文件显示为已删除）而不是 "A  a.txt"。
  assert.ok(st.includes('A  a.txt'), `索引必须正常（实际：${JSON.stringify(st)}）`)
})

/* ── 不变量 15：仓库目录不存在时必须能自建（cwd 不存在 = spawn ENOENT）──
   删掉会怎样：全新机器首次引导失败，且报的是 `spawn git ENOENT`
   （看着像 git 没装），而不是"目录不存在"。 */

test('守卫: ensureRepo 必须在第一次 git 调用前建好仓库目录', async (t) => {
  const { GitBackend, GIT_ENV_SCRUB, GIT_ENV_FORBIDDEN } = await import('../lib/git.mjs')
  const { tmpRoot, nativeGit } = await import('./helpers.mjs')
  const root = await tmpRoot(t, 'omni-ensurerepo-')
  const repoDir = `${root}/nested/does/not/exist/yet`
  const run = nativeGit()
  const be = new GitBackend({ repoDir, remote: `${root}/remote.git`, branch: 'main', run })
  // 目录**不存在**时直接 bootstrap：必须自建成功，而不是 spawn ENOENT。
  await assert.doesNotReject(() => be.ensureRepo(), '目录不存在时必须能自建（mkdir 要在 isRepo 之前）')
  assert.equal(await be.isRepo(), true, 'bootstrap 后必须真的是个仓库')

  // 顺带把"可置空清单"整体过一遍**写操作序列** —— 只读命令验不出 GIT_CONFIG 那类问题
  // （`GIT_CONFIG=''` 只在写配置时才暴露：could not write config file : Is a directory）。
  const env = Object.fromEntries(GIT_ENV_SCRUB.map((k) => [k, '']))
  const { gitOut, writeAt } = await import('./helpers.mjs')
  const w = `${root}/wtest`
  await gitOut(['init', '-q', '-b', 'main', w], { env })
  await gitOut(['-C', w, 'config', 'core.autocrlf', 'false'], { env })
  await gitOut(['-C', w, 'config', 'user.email', 't@t'], { env })
  await writeAt(`${w}/a.txt`, 'x')
  await gitOut(['-C', w, 'add', '-A'], { env })
  const st = await gitOut(['-C', w, 'status', '--porcelain'], { env })
  assert.ok(st.includes('A  a.txt'), `索引必须正常（实际：${JSON.stringify(st)}）`)
  for (const k of GIT_ENV_FORBIDDEN) assert.ok(!GIT_ENV_SCRUB.includes(k), `${k} 不得在可置空清单里`)
})
