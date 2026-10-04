// test/slim-data.test.mjs — 数据流转层精简后的**行为护栏**（task-12）。
//
// 精简删掉的是"复述代码在做什么"的散文；那些"踩坑换来的为什么"改由这里的断言守着 ——
// 注释删了，行为不许动。每条测试对应一处被压缩过的注释里的事实。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { templatize, detemplatize, assertRelPath, resolveLivePath, projectKey, encodeSegment, platformCommand, isWithin } from '../lib/paths.mjs'
import { rebindText, needsRebind } from '../lib/rebind.mjs'
import { seal, open, restoreText, VAULT_FILE } from '../lib/vault.mjs'
import { encryptBag, decryptBag, KDF } from '../lib/crypto.mjs'
import { sessionTargetVerdict, applySessionsToLocal, mirrorSessions, SESSION_RE } from '../lib/sessions.mjs'
import { applyToWorktree, applyToLocal } from '../lib/apply.mjs'
import { hashOfObjectRel, isObjectRel, objectRelOf, verifyObjectData, extractRefs, extractRefsStrict, refStatus, assertRefsPresent, putObject, knownObjects, checkReferences } from '../lib/attachments.mjs'
import { isZstd, frameRanges, decompressZstd, decompressZstdText } from '../lib/zstd.mjs'
import { planForkLanding, landForks, localForkRel, isForkRel } from '../lib/forks.mjs'
import { walk, writeAtomic, makeFsDeps, pruneBackups } from '../lib/workspace.mjs'
import { redactText, sanitizeRemote } from '../lib/sanitize.mjs'
import { extractSecrets, restoreSecrets } from '../lib/secrets.mjs'
import { FORK_NAME_RE } from '../lib/constants.mjs'

const B = (s) => Buffer.from(s, 'utf8')
const H = (c) => c.repeat(64)
const tmpRoot = () => mkdtemp(join(tmpdir(), 'omni-slim-'))

/* ── rebind：两条递归函数已合并为一条 mapValue，结构必须原样保留 ── */

test('rebind: 嵌套结构/数组/类型在模板化与还原中逐一保留', () => {
  const vars = { home: '/Users/a', dshHome: '/Users/a/.dsh' }
  const doc = {
    tables: { workspaces: { u1: { path: '/Users/a/Documents/proj', title: 'p', nested: [{ deep: '/Users/a/.dsh/x' }] } } },
    count: 3, flag: true, nil: null, list: ['/Users/a/b', 7],
  }
  const tpl = JSON.parse(rebindText(B(JSON.stringify(doc)), 'templatize', vars).toString('utf8'))
  assert.equal(tpl.tables.workspaces.u1.path, '${HOME}/Documents/proj')
  assert.equal(tpl.tables.workspaces.u1.nested[0].deep, '${DSH_HOME}/x', '深层数组里的字符串也要换')
  assert.equal(tpl.count, 3)
  assert.equal(tpl.flag, true)
  assert.equal(tpl.nil, null)
  assert.deepEqual(tpl.list, ['${HOME}/b', 7], '数组里的非字符串原样保留')

  const back = JSON.parse(rebindText(B(JSON.stringify(tpl)), 'detemplatize', { home: '/Users/b', dshHome: '/Users/b/.dsh' }).toString('utf8'))
  assert.equal(back.tables.workspaces.u1.path, '/Users/b/Documents/proj', 'A 机路径 → B 机路径')
  assert.equal(back.tables.workspaces.u1.nested[0].deep, '/Users/b/.dsh/x')
  assert.equal(needsRebind('workspace'), true)
  assert.equal(needsRebind('home-patch'), false)
})

test('rebind: 非 JSON 原样返回（绝不破坏内容）', () => {
  const notJson = B('key: value\n  - not json at all\n')
  const out = rebindText(notJson, 'templatize', { home: '/x', dshHome: '/x/.dsh' })
  assert.equal(out.toString('utf8'), notJson.toString('utf8'), '解析失败必须原样返回')
  const broken = B('{broken')
  assert.equal(rebindText(broken, 'detemplatize', { home: '/x' }).toString('utf8'), '{broken')
})

/* ── paths：CMD 必须先于 home 替换，否则 ${CMD:} 对 home 下的命令形同虚设 ── */

test('paths: 命令路径模板化优先于 home（Windows 的 npx 与各平台 uvx）', () => {
  // Windows：{APPDATA} 展开后落在 home 之下 —— 先换 home 就再也匹配不上 ${CMD:npx}。
  const win = templatize('C:\\Users\\a\\AppData\\Roaming\\npm\\npx.cmd', 'C:\\Users\\a', 'C:\\Users\\a\\.dsh')
  assert.ok(win.includes('${CMD:npx}'), `应模板化为 ${'${CMD:npx}'}，实际：${win}`)
  assert.equal(detemplatize(win, '/Users/b', '/Users/b/.dsh', 'darwin'), '/opt/homebrew/bin/npx')

  const mac = templatize('/Users/a/.local/bin/uvx', '/Users/a', '/Users/a/.dsh')
  assert.ok(mac.includes('${CMD:uvx}'), 'home 下的 uvx 同样要先认出来')
  assert.equal(detemplatize(mac, 'C:\\Users\\b', 'C:\\Users\\b\\.dsh', 'win32'), 'C:\\Users\\b\\.local\\bin\\uvx.exe')

  // $DSH_HOME 仍必须先于 ${HOME}：否则 /Users/a/.dsh 会被 /Users/a 先吃掉。
  const t = templatize('/Users/a/.dsh/storages/x.json', '/Users/a', '/Users/a/.dsh')
  assert.equal(t, '${DSH_HOME}/storages/x.json')
  assert.equal(platformCommand('no-such', '/Users/a', 'darwin'), null)
})

test('paths: 越界拒绝 + isWithin 段边界 + 官方 encodeSegment/projectKey 语义', () => {
  for (const bad of ['../x', 'a/../../x', '/abs', 'C:/x', 'a\0b', '', 'a/..']) {
    assert.throws(() => assertRelPath(bad), (e) => e.code === 'PATH_UNSAFE', `应拒绝 ${JSON.stringify(bad)}`)
    assert.throws(() => resolveLivePath(bad, '/tmp/r'), (e) => e.code === 'PATH_UNSAFE')
  }
  assert.equal(resolveLivePath('a/b.txt', '/tmp/r'), '/tmp/r/a/b.txt')
  assert.equal(isWithin('/a/b', '/a/bc'), false, '字符串前缀不是包含关系')
  assert.equal(isWithin('/a/b/', '/a/b/c'), true)
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('a b'), 'a~0020b')
  assert.equal(projectKey('/Users/x/proj'), '--Users-x-proj--')
  assert.equal(projectKey('C:\\a\\b'), '--C-a-b--', 'Windows 分隔符同口径')
  assert.equal(projectKey('/'), '--root--')
})

/* ── vault：secretGroup 三态（组关闭 = 整份跳过，绝不降级明文）── */

test('vault: secretGroup 三态判定（无密级 / 组关闭 / 组开启）', () => {
  const files = [
    { rel: 'AGENTS.md', section: 'instructions', data: B('plain') },                        // undefined = 无密级
    { rel: '.env', section: 'env-home', secretGroup: null, data: B('K=sk-LEAK-12345678') }, // null = 组关闭
    { rel: '.credentials.yaml', section: 'credentials', secretGroup: 'oauthGrants', data: B('version: 1\n') },
  ]
  const { plain, bag, skipped } = seal(files, 'pw')
  assert.deepEqual(plain.map((f) => f.rel), ['AGENTS.md'], '关掉的组绝不能落到明文分支')
  assert.deepEqual(skipped, ['.env'], '组关闭必须留痕（skipped）')
  assert.equal(bag.items.length, 1)
  assert.equal(bag.items[0].rel, '.credentials.yaml')
  assert.ok(!JSON.stringify(bag).includes('LEAK'), '密文里不得出现明文')
})

test('vault: 空口令一律跳过秘密文件；有袋无口令是 DECRYPT_FAILED', async () => {
  const files = [
    { rel: '.env', section: 'env-home', secretGroup: 'homeEnv', data: B('K=v') },
    { rel: 'AGENTS.md', section: 'instructions', data: B('ok') },
  ]
  const { plain, bag, skipped } = seal(files, '')
  assert.deepEqual(plain.map((f) => f.rel), ['AGENTS.md'])
  assert.equal(bag, null)
  assert.deepEqual(skipped, ['.env'])

  const sealed = encryptBag([{ rel: 'x', plain: B('s') }], 'pw')
  await assert.rejects(() => open(sealed, ''), (e) => e.code === 'DECRYPT_FAILED')
  await assert.rejects(() => open(sealed, 'wrong'), (e) => e.code === 'DECRYPT_FAILED')
  assert.equal((await open(null, '')).size, 0, '无袋 → 空 Map，不抛')
})

test('vault: MCP 内嵌 key 就地挖出 + 精确回填（逐字节还原）', async () => {
  const patch = '- insert:\n    - id: mcp-x\n      url: https://h/?k=tvly-abcdefgh1234\n'
  const { plain, bag } = seal([{ rel: 'cordis.patch.yml', section: 'home-patch', data: B(patch) }], 'pw')
  assert.ok(!plain[0].data.toString().includes('tvly-abcdefgh1234'), '明文里不得留 key')
  const opened = await open(bag, 'pw')
  assert.equal(restoreText('cordis.patch.yml', plain[0].data, opened).toString(), patch, '必须逐字节还原')
  assert.equal(restoreText('other.yml', plain[0].data, opened).toString(), plain[0].data.toString(), '别的文件不碰')
})

/* ── crypto：信封自带 kdf 参数，篡改必须收敛到 DECRYPT_FAILED ── */

test('crypto: bag 往返 + 信封被篡改一律 DECRYPT_FAILED（绝不半写）', () => {
  const bag = encryptBag([{ rel: 'a', plain: B('x') }, { rel: 'b', plain: B('y') }], 'pw')
  assert.equal(bag.kdf.name, KDF.NAME)
  assert.notEqual(bag.items[0].iv, bag.items[1].iv, '同 key 不得重用 iv')
  assert.equal(decryptBag(bag, 'pw')[1].plain.toString(), 'y')
  assert.throws(() => decryptBag({ ...bag, kdf: { ...bag.kdf, N: 16384 } }, 'pw'), (e) => e.code === 'DECRYPT_FAILED')
  assert.throws(() => decryptBag({ ...bag, kdf: { ...bag.kdf, salt: 7 } }, 'pw'), (e) => e.code === 'DECRYPT_FAILED')
  assert.throws(() => decryptBag({ ...bag, v: 2 }, 'pw'), (e) => e.code === 'DECRYPT_FAILED')
  assert.throws(() => decryptBag({ ...bag, items: [{}] }, 'pw'), (e) => e.code === 'DECRYPT_FAILED')
  assert.throws(() => encryptBag([{ rel: 'a', plain: 'not-a-buffer' }], 'pw'), (e) => e.code === 'BAD_INPUT')
})

/* ── sessions：单点裁决 + 三方裁决 + 盲覆盖必须留痕 ── */

test('sessions: 单点裁决的五种 reason（越界/永不同步/宿主产物/非会话/正常）', () => {
  assert.equal(sessionTargetVerdict('sessions/a.jsonl').reason, 'ok')
  assert.equal(sessionTargetVerdict('storages/session_projcache/a.json').reason, 'ok')
  assert.equal(sessionTargetVerdict('sessions/../../etc/passwd').reason, 'unsafe')
  assert.equal(sessionTargetVerdict('sessions/a/../../b').reason, 'unsafe')
  // 绝对路径若压根不是会话形态 → 先被判 not-session（安全判据只在会话形态上跑）。
  assert.equal(sessionTargetVerdict('/abs/sessions/a').reason, 'not-session')
  assert.equal(sessionTargetVerdict('omnisync/github.token').reason, 'never-synced')
  assert.equal(sessionTargetVerdict('sessions/session.lock').reason, 'host-artifact')
  assert.equal(sessionTargetVerdict('AGENTS.md').reason, 'not-session')
  assert.equal(sessionTargetVerdict('').reason, 'not-session')
  assert.equal(SESSION_RE.test('sessions/a'), true)
})

test('sessions: 三方裁决（无基点=盲覆盖留痕 / 远端未动=不写 / 双方都动=fork 不覆盖）', async () => {
  const mkCtx = (over = {}) => ({
    listTree: async () => ['sessions/a.jsonl'],
    readTree: async () => B('REMOTE'),
    readLocal: async () => B('LOCAL'),
    writeLocal: async () => { throw new Error('不该写主路径') },
    logger: { warn: () => {} },
    ...over,
  })

  // ① 无基点 → 树优先写，且必须 warn（本模块唯一会丢字节的路径）。
  const warns = []
  const w1 = []
  const blind = await applySessionsToLocal(mkCtx({
    writeLocal: async (rel, data) => { w1.push([rel, data.toString()]) },
    logger: { warn: (m) => warns.push(m) },
  }))
  assert.deepEqual(w1, [['sessions/a.jsonl', 'REMOTE']])
  assert.equal(blind, 1)
  assert.ok(warns.some((m) => /three-way base/u.test(m)), `盲覆盖必须留痕：${JSON.stringify(warns)}`)

  // ② 基点 == 远端 → 远端没动、本机领先 → 不写（下一轮 mirror 推上去）。
  const w2 = []
  assert.equal(await applySessionsToLocal(mkCtx({
    base: async () => B('REMOTE'),
    writeLocal: async (rel) => { w2.push(rel) },
  })), 0)
  assert.deepEqual(w2, [])

  // ③ 双方都动过 → 本机留主路径、远端转 fork；同名 fork 已存在时绝不覆盖。
  const w3 = []
  const written3 = await applySessionsToLocal(mkCtx({
    base: async () => B('BASE'),
    readLocal: async (rel) => (rel === 'sessions/a.jsonl' ? B('LOCAL') : null),
    writeLocal: async (rel, data) => { w3.push([rel, data.toString()]) },
    deviceId: () => 'abcd1234',
    now: () => 1700000000000,
  }))
  assert.equal(written3, 1)
  assert.equal(w3.length, 1)
  assert.match(w3[0][0], FORK_NAME_RE, 'fork 名必须是 <14 位 UTC 戳>-<8 位设备>')
  assert.ok(w3[0][0].endsWith('-abcd1234'), `设备位必须编码进名字：${w3[0][0]}`)
  assert.equal(w3[0][1], 'REMOTE', 'fork 里必须是远端版本')
  assert.equal(isForkRel(w3[0][0]), true)

  const w4 = []
  assert.equal(await applySessionsToLocal(mkCtx({
    base: async () => B('BASE'),
    readLocal: async (rel) => (rel === 'sessions/a.jsonl' ? B('LOCAL') : B('EXISTING')),
    writeLocal: async (rel) => { w4.push(rel) },
    deviceId: () => 'abcd1234',
    now: () => 1700000000000,
  })), 0)
  assert.deepEqual(w4, [], '同名 fork 已存在 → 绝不覆盖')
})

test('sessions: 树里越界路径响亮拒绝（PATH_UNSAFE），镜像方向只追加', async () => {
  await assert.rejects(() => applySessionsToLocal({
    listTree: async () => ['sessions/../../evil'],
    readTree: async () => B('x'),
    readLocal: async () => null,
    writeLocal: async () => true,
  }), (e) => e.code === 'PATH_UNSAFE')

  const calls = []
  const changed = await mirrorSessions({
    walkAll: async () => [{ rel: 'sessions/a.jsonl' }, { rel: 'AGENTS.md' }, { rel: 'sessions/session.lock' }],
    readLocal: async (rel) => B(rel),
    writeTree: async (rel) => { calls.push(rel); return true },
  })
  assert.equal(changed, 1)
  assert.deepEqual(calls, ['sessions/a.jsonl'], '只镜像会话文件，宿主产物/非会话不进')
})

/* ── attachments：宽/窄两套引用形态 + 写入口先校验后落盘 ── */

test('attachments: 窄版只认实测形态，宽版兼容对象路径与 attachment://', () => {
  const hash = H('a')
  const strict = `{"type":"image","attachment":{"attachmentId":"sha256:${hash}"}}`
  assert.deepEqual(extractRefsStrict(strict), [hash])
  assert.deepEqual(extractRefs(strict), [hash])
  const wideOnly = `see attachments/v1/objects/${hash.slice(0, 2)}/${hash} and attachment://${hash}`
  assert.deepEqual(extractRefs(wideOnly), [hash])
  assert.deepEqual(extractRefsStrict(wideOnly), [], '散文形态在窄版里必须 0 命中（否则误报会卡死同步）')
  assert.deepEqual(extractRefs(`"doc_id":"${hash}"`), [], '裸 hash 不当引用（可能是 doc_id/校验和）')
  assert.deepEqual(extractRefs(Buffer.from(strict, 'utf8')), [hash], 'Buffer 也吃')
  assert.deepEqual(extractRefs(undefined), [])
})

test('attachments: 路径/hash 一致性 + 引用缺失硬失败', () => {
  assert.equal(hashOfObjectRel(`attachments/v1/objects/ab/${H('a')}`), null, '前缀与 hash 前两位不符 → null')
  assert.equal(hashOfObjectRel(`attachments/v1/objects/aa/${H('a')}`), H('a'))
  assert.equal(isObjectRel(`attachments/v1/objects/aa/${H('a')}`), true)
  assert.equal(objectRelOf(H('A').toLowerCase()), `attachments/v1/objects/aa/${H('a')}`)
  assert.throws(() => objectRelOf('nope'), (e) => e.code === 'BAD_INPUT')
  assert.throws(() => verifyObjectData(`attachments/v1/objects/aa/${H('a')}`, B('wrong')), (e) => e.code === 'SNAPSHOT_CORRUPT')
  assert.throws(() => verifyObjectData('not/an/object', B('x')), (e) => e.code === 'BAD_INPUT')

  const known = new Set([objectRelOf(H('a'))])
  assert.deepEqual(refStatus([H('a'), H('b')], known), { present: [H('a')], missing: [H('b')] })
  assert.deepEqual(assertRefsPresent([H('a')], known), { checked: 1 })
  assert.throws(() => assertRefsPresent([H('b')], known), (e) => e.code === 'SNAPSHOT_CORRUPT')
})

test('attachments: putObject 先校验后写、幂等、同路径异内容硬失败', async () => {
  const hash = H('b')
  const rel = objectRelOf(hash)
  const data = Buffer.alloc(0) // sha256('') ≠ H('b') → 先校验就该炸
  const writes = []
  await assert.rejects(() => putObject({ writeLocal: async () => { writes.push(1); return true } }, rel, data),
    (e) => e.code === 'SNAPSHOT_CORRUPT')
  assert.deepEqual(writes, [], '校验失败必须零写入')

  const good = (() => { const c = Buffer.from('payload'); return c })()
  const realRel = objectRelOf((await import('node:crypto')).createHash('sha256').update(good).digest('hex'))
  const local = new Map()
  const ctx = {
    readLocal: async (r) => local.get(r) ?? null,
    writeLocal: async (r, d) => { local.set(r, d); writes.push(r); return true },
  }
  const first = await putObject(ctx, realRel, good)
  assert.deepEqual(first.written, 1)
  const second = await putObject(ctx, realRel, good)
  assert.equal(second.written, 0, '已是同内容 → 幂等跳过')
  local.set(realRel, Buffer.from('other'))
  await assert.rejects(() => putObject(ctx, realRel, good), (e) => e.code === 'SNAPSHOT_CORRUPT')
  await assert.rejects(() => putObject({}, realRel, good), (e) => e.code === 'BAD_INPUT')
  await assert.rejects(() => knownObjects({}), (e) => e.code === 'BAD_INPUT')
})

/* ── zstd：多帧（Node 原生只解第一帧且不报错，所以必须自己走帧）── */

test('zstd: 多帧拼接解压（单帧原语会静默丢掉后面的帧）', () => {
  const f1 = zstdCompressSync(Buffer.from('{"a":1}\n'))
  const f2 = zstdCompressSync(Buffer.from('{"b":2}\n'))
  const multi = Buffer.concat([f1, f2])
  assert.equal(isZstd(multi), true)
  assert.equal(frameRanges(multi).length, 2, '必须定位到两帧')
  assert.equal(decompressZstdText(multi), '{"a":1}\n{"b":2}\n', '两帧都要解出来')
  assert.equal(decompressZstd(multi).toString('utf8'),
    decompressZstd(f1).toString('utf8') + decompressZstd(f2).toString('utf8'),
    '多帧结果 = 逐帧结果拼接（不是只解第一帧）')

  // 尾帧写了一半：只丢那一帧，已完整的帧照旧可读。
  const truncated = Buffer.concat([f1, f2.subarray(0, 6)])
  assert.equal(decompressZstdText(truncated), '{"a":1}\n')

  // 非 zstd：原样返回（调用方无需先判断）。
  assert.equal(isZstd(B('plain text')), false)
  assert.equal(decompressZstdText(B('plain text')), 'plain text')
  assert.equal(decompressZstd(null).length, 0)
})

/* ── forks：UNC 必须显式挡 + 只落 fork 形态 + 绝不覆盖 ── */

test('forks: UNC/绝对路径/上跳一律拒绝，落地方案确定性', () => {
  const plan = planForkLanding(
    ['a.md.remote-fork-17000000000000-abcd1234', '\\\\server\\share\\x.remote-fork-17000000000000-abcd1234', '../evil.remote-fork-17000000000000-abcd1234', 'plain.md'],
    new Set(['a.md.remote-fork-17000000000000-abcd1234']),
  )
  assert.deepEqual(plan.land, [], '已存在的 fork 不落')
  assert.deepEqual(plan.skip, ['a.md.remote-fork-17000000000000-abcd1234'])
  assert.equal(plan.reject.length, 3, `UNC/上跳/非 fork 形态都该 reject：${JSON.stringify(plan.reject)}`)
  assert.deepEqual(planForkLanding(['b.md.remote-fork-17000000000000-abcd1234'], new Set()).land,
    ['b.md.remote-fork-17000000000000-abcd1234'])
  assert.equal(isForkRel('x.remote-fork-17000000000000-abcd1234'), true)
  assert.match(localForkRel('a.md', 'abcd1234', 17000000000000), FORK_NAME_RE)
  assert.throws(() => localForkRel('//server/share/x', 'abcd1234', 17000000000000), (e) => e.code === 'PATH_UNSAFE')
})

test('forks: 缺引用上报 missing，绝不假装成功', async () => {
  const rel = 'a.md.remote-fork-17000000000000-abcd1234'
  const r = await landForks({
    readTree: async () => null,
    writeLocal: async () => { throw new Error('不该写') },
    existsLocal: async () => false,
  }, [rel])
  assert.deepEqual(r, { landed: [], skipped: [], rejected: [], missing: [rel] })
  await assert.rejects(() => landForks({}, [rel]), (e) => e.code === 'BAD_INPUT')
})

/* ── workspace：剪枝、原子写 0600、备份环形保留 ── */

test('workspace: walk 下潜前剪枝 node_modules；writeAtomic 落 0600 且不留临时文件', async () => {
  const root = await tmpRoot()
  try {
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'x')
    await writeFile(join(root, 'sub/a.md'), 'a')
    await writeFile(join(root, '.DS_Store'), 'noise')
    const files = (await walk(root)).map((f) => f.rel).sort()
    assert.deepEqual(files, ['sub/a.md'], `剪枝 + 宿主产物过滤，实际：${JSON.stringify(files)}`)

    const target = join(root, 'sub/b.txt')
    await writeAtomic(target, 'hello', { mode: 0o600 })
    assert.equal(await readFile(target, 'utf8'), 'hello')
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600)
    assert.deepEqual((await readdir(join(root, 'sub'))).filter((n) => n.includes('omnisync-tmp')), [], '临时文件必须已 rename 掉')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace: backupFile 保留相对结构，pruneBackups 环形保留最近 keep 份', async () => {
  const home = await tmpRoot()
  try {
    await mkdir(join(home, 'storages'), { recursive: true })
    await writeFile(join(home, 'storages/workspace.json'), '{"old":1}')
    const deps = makeFsDeps({ dshHome: home, workTree: join(home, 'omnisync/repo'), backupRoot: join(home, 'omnisync/backups') })
    const dir = await deps.backupDir('pull')
    const dst = await deps.backupFile('storages/workspace.json', dir)
    assert.equal(await readFile(dst, 'utf8'), '{"old":1}', '备份必须是**旧**内容且保持相对结构')
    assert.equal(await deps.backupFile('not/there.json', dir), null, '本机没有的文件无旧字节可备份')

    for (let i = 0; i < 8; i++) {
      const d = join(home, 'omnisync/backups', `pull-${String(i).padStart(3, '0')}`)
      await mkdir(d, { recursive: true })
    }
    await pruneBackups(join(home, 'omnisync/backups'), 5)
    assert.equal((await readdir(join(home, 'omnisync/backups'))).length, 5, '环形保留最近 keep 份')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/* ── apply：三态透传 + 幂等 + 密文袋保留 + 对象校验 ── */

test('apply: 组关闭的文件不进工作树（applyToWorktree 端到端）', async () => {
  const home = await tmpRoot()
  const tree = await tmpRoot()
  try {
    await writeFile(join(home, 'AGENTS.md'), '# ok\n')
    await writeFile(join(home, '.env'), 'K=tvly-LEAKME-abcdefgh\n')
    const treeFiles = []
    const { changed, skipped } = await applyToWorktree({
      walk: async () => [{ rel: 'AGENTS.md' }, { rel: '.env' }],
      read: async (rel) => readFile(join(home, rel)),
      writeTree: async (rel, data) => { treeFiles.push([rel, data.toString()]); return true },
      removeTree: async () => false,
      listTree: async () => [],
      sectionOf: (rel) => (rel === 'AGENTS.md' ? 'instructions' : 'env-home'),
      secretGroupOf: () => null, // 组被用户关掉 → 三态里的 null
      passphrase: 'pw',
    })
    assert.equal(changed, 1)
    assert.equal(skipped, 1, '关掉的组必须留痕（skipped）')
    assert.deepEqual(treeFiles.map(([r]) => r), ['AGENTS.md'], '关掉的组绝不能进工作树')
    assert.ok(!treeFiles.some(([, d]) => d.includes('LEAKME')), '不得明文上传')
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(tree, { recursive: true, force: true })
  }
})

test('apply: applyToLocal 幂等 + 密文袋 rel 三重校验 + 对象哈希校验', async () => {
  const writes = []
  const bag = encryptBag([
    { rel: '../../escape.txt', plain: B('pwned') },
    { rel: 'omnisync/github.token', plain: B('pwned') },
    { rel: 'secrets/ok.key', plain: B('legit') },
  ], 'pw')
  const written = await applyToLocal({
    passphrase: 'pw',
    readTree: async (rel) => (rel === VAULT_FILE ? Buffer.from(JSON.stringify(bag)) : null),
    listTree: async () => [],
    sectionOf: (rel) => (rel === 'secrets/ok.key' ? 'skills-secrets' : rel === 'omnisync/github.token' ? null : null),
    readLocal: async () => null,
    writeLocal: async (rel) => { writes.push(rel); return true },
    logger: { warn: () => {} },
  })
  assert.deepEqual(writes, ['secrets/ok.key'], '越界与 NEVER_SYNC 都必须被挡')
  assert.equal(written, 1)

  // 幂等：内容一致不重写（树文件与袋条目两条路径都要）。
  const same = []
  await applyToLocal({
    passphrase: 'pw',
    readTree: async (rel) => (rel === VAULT_FILE ? Buffer.from(JSON.stringify(bag)) : B('same')),
    listTree: async () => ['AGENTS.md'],
    sectionOf: (rel) => (rel === 'AGENTS.md' ? 'instructions' : 'skills-secrets'),
    // 每个 rel 都返回它「应有的当前内容」→ 两条路径都该被幂等闸门跳过。
    readLocal: async (rel) => (rel === 'secrets/ok.key' ? B('legit') : B('same')),
    writeLocal: async (rel) => { same.push(rel); return true },
  })
  assert.deepEqual(same, [])

  // 内容寻址对象：内容 ≠ 路径哈希 → 拒绝落地（对象是云端唯一副本）。
  await assert.rejects(() => applyToLocal({
    passphrase: 'pw',
    readTree: async (rel) => (rel === VAULT_FILE ? null : B('wrong')),
    listTree: async () => [`attachments/v1/objects/aa/${H('a')}`],
    sectionOf: () => 'attachments',
    readLocal: async () => null,
    writeLocal: async () => true,
  }), (e) => e.code === 'SNAPSHOT_CORRUPT')

  // 损坏的袋 → 领域错误码，而不是裸 SyntaxError。
  await assert.rejects(() => applyToLocal({
    passphrase: 'pw',
    readTree: async (rel) => (rel === VAULT_FILE ? B('<<<<<<< HEAD\n{broken') : null),
    listTree: async () => [],
    sectionOf: () => null,
    writeLocal: async () => true,
  }), (e) => e.code === 'DECRYPT_FAILED')
})

/* ── sanitize / secrets：两张形态表不许再漂移 ── */

test('sanitize: 脱敏覆盖 secrets.mjs 认得的每一种形态', () => {
  const samples = [
    'sk-abcdefgh12345678', 'tvly-abcdefgh12345678', 'sci_abcdefgh12345678',
    'ghp_ABCDEFGHIJKLMNOPQRST', 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ]
  for (const s of samples) {
    assert.ok(extractSecrets(`k=${s}`).found.length > 0, `secrets.mjs 认不得：${s}`)
    assert.ok(!redactText(`fatal: ${s} rejected`).includes(s), `脱敏漏了：${s}`)
  }
  assert.equal(sanitizeRemote('https://u:pw@h/x'), 'https://u:***@h/x')
  assert.equal(sanitizeRemote(''), '<unset>')
  assert.equal(redactText('api_key=abcdefgh1234').includes('abcdefgh1234'), false)
})

test('secrets: 占位符互为前缀时回填不错位（:1 vs :10）', () => {
  const values = Array.from({ length: 11 }, (_, i) => `tvly-key-${String(i).padStart(4, '0')}`)
  const original = values.map((v, i) => `k${i}=${v}`).join('\n') + '\n'
  const { text, found } = extractSecrets(original)
  assert.equal(found.length, 11)
  assert.equal(restoreSecrets(text, found), original)
  assert.equal(restoreSecrets('x', 'not-an-array'), 'x', '形状防御：非数组原样返回')
  assert.equal(restoreSecrets('x', [null, 42, { placeholder: '' }]), 'x')
})

/* ── 端到端：真 fs 的 checkReferences（宽/窄 + 缺失硬失败）── */

test('attachments: checkReferences 端到端（缺对象硬失败，齐了才算过）', async () => {
  const home = await tmpRoot()
  try {
    const hash = (await import('node:crypto')).createHash('sha256').update('obj').digest('hex')
    const rel = objectRelOf(hash)
    const ctx = {
      listLocal: async () => [rel],
      listTree: async () => [],
    }
    assert.deepEqual(await checkReferences({ ...ctx, texts: [`"attachmentId":"sha256:${hash}"`] }), { checked: 1 })
    await assert.rejects(() => checkReferences({ ...ctx, texts: [`"attachmentId":"sha256:${H('c')}"`] }),
      (e) => e.code === 'SNAPSHOT_CORRUPT')
    // 目录不存在 → listLocal 返回空 → 引用即缺失（不是"没问题"）。
    await assert.rejects(() => checkReferences({
      listLocal: async () => [], listTree: async () => [],
      texts: [`"attachmentId":"sha256:${hash}"`],
    }), (e) => e.code === 'SNAPSHOT_CORRUPT')
    void home
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
