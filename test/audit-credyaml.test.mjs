// test/audit-credyaml.test.mjs — 凭据 YAML 解析器加固（task-8，3 轮自检）。
//
// 为什么单独开一个文件：test/credentials.test.mjs 锁的是**合并语义**（28 个用例，
// 不许改坏），这里锁的是**解析/渲染保真**。两者失败时的排查方向完全不同。
//
// 本文件的所有 fixture 都是**脱敏**的假值（LEAKME-*）。真实文件只在
// 「真实文件往返」一节里**只读**打开，且断言失败信息里绝不带文件内容
// （否则一次断言失败就会把用户的真令牌打进测试日志）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseCredYaml, renderCredYaml } from '../lib/credyaml.mjs'
import { decide, mergeCredentials, snapshotOf, expiryCandidates, merge as mergeCred } from '../lib/mergers/credentials.mjs'
import { resolveOne } from '../lib/conflicts.mjs'

/** 与 test/credentials.test.mjs 同形的两个小工具（那边是文件局部常量，导不出来）。 */
const C = (present, value) => (present ? { present: true, value } : { present: false })
const snap = (refs = {}, records = {}) => snapshotOf({ refs, records })

/** 只报结构、绝不报内容的往返断言（失败时也不会泄漏令牌）。 */
function assertByteIdentical(actual, expected, label) {
  if (actual === expected) return
  const a = actual.split('\n')
  const b = expected.split('\n')
  const details = []
  for (let i = 0; i < Math.max(a.length, b.length) && details.length < 8; i++) {
    if (a[i] !== b[i]) {
      details.push(`  L${i + 1}: got ${a[i] === undefined ? '<EOF>' : `len=${a[i].length}`} / want ${b[i] === undefined ? '<EOF>' : `len=${b[i].length}`}`)
    }
  }
  assert.fail(
    `${label}: 往返不逐字节相等（got ${Buffer.byteLength(actual)}B/${a.length}L, want ${Buffer.byteLength(expected)}B/${b.length}L）\n`
    + `  首个差异行：\n${details.join('\n')}`,
  )
}

/* ═══════════════════ 第 1 轮：真实形态取证 ═══════════════════
 *
 * 真实 ~/.dsh/.credentials.yaml 的两个形态与旧实现假设**不符**，两者都是
 * 「每轮同步静默改坏用户凭据文件」级别的问题：
 *
 *   ① record 的 `payload:` 在真实文件里是 **YAML 嵌套映射**（`      version: 1`），
 *      不是旧实现假设的 JSON 流式块。旧实现把它读成**字符串**，渲染时又
 *      JSON.stringify 成 `"version: 1\nsecret: xxx"` —— DSH 是**全拒式**解析，
 *      payload 变成字符串 = 整份 .credentials.yaml 被拒收 = 用户凭据全丢。
 *      连带后果：payload 是字符串时 expiryCandidates 挖不到任何时间戳，
 *      degraded() 也永远判不出退化 —— 记录级合并的两把刀同时失效。
 *   ② refs 里的长 JSON 值会被**折行**（`'{"a":"xx` + 4 空格续行 + `yy"}'`），
 *      YAML 语义是「折行 → 空格」。旧实现只读第一物理行 ⇒ 值被截断
 *      （实测最长的那个 ref 丢了 175 字符），JSON.parse 直接失败。
 */

const REAL_PAYLOAD_DOC = [
  'version: 1',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  "      token: 'LEAKME-account-token'",
  '      issuer: https://example.invalid/oauth',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  "      secret: 'LEAKME-session-secret'",
  '',
].join('\n')

test('R1: 真实形态 — record 的 payload 是 YAML 嵌套映射，必须读成对象（不是字符串）', () => {
  const { records } = parseCredYaml(REAL_PAYLOAD_DOC)
  const byKey = new Map(records)
  assert.deepEqual(
    byKey.get('deepseek-account-platform/default').payload,
    { version: 1, token: 'LEAKME-account-token', issuer: 'https://example.invalid/oauth' },
    'payload 是映射块；读成字符串会让 DSH 全拒式解析拒收整份文件',
  )
  assert.deepEqual(
    byKey.get('client-connection/browser-session').payload,
    { version: 1, secret: 'LEAKME-session-secret' },
  )
})

test('R1: 真实形态 — payload 是对象时过期时间才挖得到（否则记录级合并两把刀全失效）', () => {
  const doc = [
    'version: 1',
    'records:',
    '  acme/grant:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      access_token: LEAKME-at',
    '      expires_at: 1792245217674',
    '',
  ].join('\n')
  const rec = parseCredYaml(doc).records[0][1]
  assert.equal(
    expiryCandidates(rec).p, 1792245217674,
    'payload 读成字符串 ⇒ 永远挖不到 expires_at ⇒ 只能落到"隔离区"兜底',
  )
})

test('R1: 真实形态 — render 出来的 payload 必须仍是映射（不能变成带引号的字符串）', () => {
  const parsed = parseCredYaml(REAL_PAYLOAD_DOC)
  const back = parseCredYaml(renderCredYaml(parsed))
  const byKey = new Map(back.records)
  assert.deepEqual(
    byKey.get('deepseek-account-platform/default').payload,
    { version: 1, token: 'LEAKME-account-token', issuer: 'https://example.invalid/oauth' },
    '往返后 payload 必须还是对象 —— 变成字符串就是"整份文件被拒收"',
  )
})

test('R1: 折行标量 — 续行必须按 YAML 语义（折行→空格）拼回，不得截断', () => {
  const doc = [
    'version: 1',
    'refs:',
    "  FOLDED: '{\"access_token\":\"LEAKME-aaa",
    '    bbb ccc',
    '    ddd\",\"refresh_token\":\"LEAKME-rrr\"}\'',
    '',
  ].join('\n')
  const value = parseCredYaml(doc).refs[0][1]
  assert.equal(
    value, '{"access_token":"LEAKME-aaa bbb ccc ddd","refresh_token":"LEAKME-rrr"}',
    '折行续行必须拼回（拼错/截断 = 每个续行字符都丢）',
  )
  assert.equal(JSON.parse(value).refresh_token, 'LEAKME-rrr', '拼回后必须是合法 JSON')
})

test('R1: 折行标量 — 拼回后过期时间可挖（截断的值 JSON.parse 失败 ⇒ 挖不到）', () => {
  const doc = [
    'version: 1',
    'refs:',
    "  ACCT: '{\"access_token\":\"LEAKME-padpadpadpadpadpad",
    '    padpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpadpad',
    '    pad\",\"expires_at\":\"1792245217674\"}\'',
    '',
  ].join('\n')
  const value = parseCredYaml(doc).refs[0][1]
  assert.equal(expiryCandidates(value).p, 1792245217674, '折行拼回后必须挖得到 expires_at')
})

/* ═══════════════════ 真实文件往返（只读、脱敏断言） ═══════════════════ */

const REAL_FILES = [
  join(homedir(), '.dsh', '.credentials.yaml'),
  join(homedir(), '.dsh', 'dsh-config-manager', 'vault', '.credentials.yaml'),
]

for (const file of REAL_FILES) {
  test(`R: 真实文件 parse → render 逐字节相等 — ${file.replace(homedir(), '~')}`, (t) => {
    if (!existsSync(file)) return t.skip('真实文件不存在（可移植性：跳过而非失败）')
    const raw = readFileSync(file, 'utf8')
    const out = renderCredYaml(parseCredYaml(raw))
    assertByteIdentical(out, raw, '真实凭据文件往返')
  })
}

/* ═══════════════════ 第 2 轮：无墓碑时的删除语义 ═══════════════════
 *
 * 旧语义：`decide` 在「一方删除、另一方修改」且**无墓碑**时，只要存活方的
 * 过期时间不能证明比 base 新，就让**删除胜出**，存活方的改动记为 `deleted`。
 *
 * 判断：**这是用户可见的数据丢失**，依据有三条 ——
 *   ① 走到该分支必然 `dL && dR`，即存活方相对 base **确实变了** ⇒ 那是真改动，
 *      不是"陈旧的未刷新副本"；仅因为缺时间戳就丢掉它，属于"无从裁决即丢弃"。
 *   ② `report.quarantined` 在生产路径上**没有任何消费者**（conflicts.mjs 只读
 *      `report.conflicts.length`），所以"进隔离区"根本救不回值 —— 值只有留在
 *      合并结果里才不丢。
 *   ③ 更糟的是调用方会据 base 缺失反推墓碑（conflicts.mjs 的 `deleted`），
 *      把这次静默删除**钉成永久**：之后对端再也无法把它带回来。
 * 修法沿用本文件既有的 T2 兜底（"无从裁决 → 保住值 + 上报，绝不静默丢"）：
 * 存活方的改动留在结果里，并报成 conflict 让用户看见。
 */

const credDoc = (refLine) => [
  'version: 1',
  'refs:',
  ...(refLine === null ? ['  {}'] : [refLine]),
  '',
].join('\n')

test('R2: 本地改动（无时间戳）+ 远端删除 → 本地改动不得被静默丢弃', () => {
  const base = JSON.stringify({ access_token: 'LEAKME-old' })
  const localEdit = JSON.stringify({ access_token: 'LEAKME-old', scope: 'openid profile' })
  const d = decide('ref', C(true, base), C(true, localEdit), C(false))
  assert.equal(d.present, true, '用户的本地改动必须留在合并结果里（静默删 = 永久丢失）')
  assert.equal(d.value, localEdit, '留下的必须是本地改动后的值')
  assert.ok(d.reason.startsWith('ambiguous'), '无从裁决必须报成 ambiguous（让上层报冲突）')
})

test('R2: 对称 — 本地删除 + 远端改动 → 远端改动同样不得被静默丢弃', () => {
  const base = JSON.stringify({ access_token: 'LEAKME-old' })
  const remoteEdit = JSON.stringify({ access_token: 'LEAKME-old', scope: 'openid profile' })
  const d = decide('ref', C(true, base), C(false), C(true, remoteEdit))
  assert.equal(d.present, true, '哪一侧的改动都不能因为"另一侧删了"而消失')
  assert.equal(d.value, remoteEdit)
})

test('R2: mergeCredentials — 本地改动不得因对端删除而从合并结果里消失', () => {
  const base = snap({ ACCT: JSON.stringify({ access_token: 'LEAKME-old' }) })
  const local = snap({ ACCT: JSON.stringify({ access_token: 'LEAKME-old', scope: 'openid profile' }) })
  const remote = snap() // 对端删掉了这个凭据
  const { merged, report } = mergeCredentials(base, local, remote)
  assert.equal(merged.refs.has('ACCT'), true, '合并结果必须保住本地改动')
  assert.equal(JSON.parse(merged.refs.get('ACCT')).scope, 'openid profile')
  assert.equal(report.conflicts.length, 1, '必须报冲突（用户要能知道这次分歧）')
  assert.equal(report.deleted.length, 0, '不得记成"已删除"')
})

test('R2: resolveOne — 冲突路径写回的凭据文件里必须还有本地改动', () => {
  const out = resolveOne({
    sectionId: 'credentials',
    base: Buffer.from(credDoc("  ACCT: '{\"access_token\":\"LEAKME-old\"}'")),
    ours: Buffer.from(credDoc("  ACCT: '{\"access_token\":\"LEAKME-old\",\"scope\":\"openid profile\"}'")),
    theirs: Buffer.from(credDoc(null)), // 对端删除
    path: '.credentials.yaml',
  })
  const merged = new Map(parseCredYaml(out.data.toString()).records.concat(parseCredYaml(out.data.toString()).refs))
  assert.equal(merged.has('ACCT'), true, '写回的文件里必须还有本地改动（否则用户改的东西凭空消失）')
  assert.equal(JSON.parse(merged.get('ACCT')).scope, 'openid profile')
  assert.equal(out.kind, 'conflict', '无从裁决必须报 conflict，不能静默当 merged')
})

test('R2 守卫: 单边删除（对端未改）仍必须保持删除 —— 登出不得被复活', () => {
  // 这条是旧语义里**唯一真正需要"删除优先"**的场景，改语义时绝不能碰坏。
  const d = decide('ref', C(true, 'base-value'), C(false), C(true, 'base-value'))
  assert.equal(d.present, false, '本地删除 + 对端原封不动 → 必须保持删除')
})

test('R2 守卫: 有墓碑时删除仍然胜出（墓碑闸门不受本次改动影响）', () => {
  const tomb = { at: Date.parse('2026-01-01T00:00:00Z') }
  const d = decide('ref', C(true, 'base-value'), C(false), C(true, 'base-value'), tomb)
  assert.equal(d.present, false, '有墓碑 → 删除胜出（防"删了又复活"）')
  assert.equal(d.reason.startsWith('tombstone'), true)
})

test('R2 守卫: 存活方确实比 base 新（真刷新）→ 仍然干净复活，不报冲突', () => {
  const base = JSON.stringify({ access_token: 'LEAKME-old', expires_at: '1792000000000' })
  const fresh = JSON.stringify({ access_token: 'LEAKME-new', expires_at: '1792245217674' })
  const d = decide('ref', C(true, base), C(true, fresh), C(false))
  assert.equal(d.present, true)
  assert.equal(d.reason.startsWith('revive'), true, '真刷新应走 revive 快路径（不制造假冲突）')
  assert.equal(d.quarantine, undefined)
})


/* ═══════════════════ 第 3 轮：可移植的真实形态回归语料 ═══════════════════
 *
 * 下面这份 fixture 是 ~/.dsh/.credentials.yaml **脱敏后的逐结构副本**：
 * 值一律按字符类替换（字母→字母、数字→数字，引号/花括号/冒号/逗号/缩进/换行
 * 原样），键名保留（provider/账号标识符，不是凭据材料；只把键尾的十六进制
 * 摘要替换掉）。因此折行位置、引号风格、plain 与 quoted 的混用、段序、JSON
 * 合法性与标量类型全部与真实文件一致，而**值位**一个原始字符都不剩
 * （已按 ≥10 字符连续片段全量比对，值位泄漏 0 处）。
 *
 * ⚠ 键名必须保留：上一版把键名也替换了，段名就不再是 refs/records，整份文件
 *   退化成一段 raw，往返"通过"却根本没走到解析器 —— 假阳性。下面那条形态
 *   自检就是为拦住它而写的。
 *
 * 为什么值得内联这 8.9KB：真实文件只在本机存在，CI/别人的机器上会被 skip；
 * 而"折行 + records 在前 + payload 是嵌套映射"正是最容易回归的三件事。
 * 有了它，"往返逐字节相等"这条验收标准在任何机器上都被锁住。
 */
const REAL_SHAPE_FIXTURE = `
version: 1
records:
  client-connection/browser-session:
    kind: LEAKM
    payload:
      version: 0
      secret: Ex1yz2qw3ertyu_iop4asdf5ghjklzx6c78v9b0nmLE
  deepseek-account-platform/device:
    kind: AKMEx
    payload:
      id: 123y4567-8z90-1qw2-3456-7e89r0123456
  deepseek-account-platform/default:
    kind: tyuio
    payload:
      version: 7
      token: pasdfghj8kl9zxcvbnmLEAKMExyzqw0e1rtyui2o+pas3456dfgh7j+klzxcv8bn
      issuer: mLEAK://MExyzqwe.rtyuiopa.sdf
refs:
  XIAOMI_API_KEY: gh-j9k0l123zx45cvbnmLEA6KMExyzq7wertyui8opa9s0df1gh
  OPENCODE_GO_API_KEY: jk_lz_23456789x0cv_1bn2mLE3A_KM_Ex4yzqwertyu56iop7a
  ANYSEARCH_API_KEY: sd_fg_8h90j12345klzxcvbn6m7L8E90123456
  BUDDY_ACCOUNT_7MEX89Y0: '{"xyzqwe_rtyui":"opasdfghjklzxcv1bnmLEAKMExy2zq34wer5tyu6i7opa8sdfghjklzxcv9bnmLEAKMExyzqwe0rt1yuiopas2dfghj3klzxcvbnm4LEAK.MExyz5qwertyuiopasdfg6hjkl7zxcvbnm8LEAKMExyzqwertyuio9p0asdfghjkl1zxcvbnmLEAKMExyzqwertyu2iopa34sdfghjk5lz67xc8vbnmLEAKMExy9zqwertyuiopasdfgh01jk2lzxcvbnm3LEAKMExyzqwertyuiopasdfghjklzxcvbnmLEAKMEx4yzqwertyuiopasdfghjkl5zxcvbnm6LEAKMExyzqw7ert8yui9opasdfghjkl0zxc1vbnmLE2AK3M4Exyzqwertyuiop5asd6fghjkl7zxcvbnmL8EA9KMEx01yzqwertyuiopa2sdfghjklzxcvbnmL34EAKMExyzqwertyuiopasdfghjkl5zxcvbnmLE67AKMExyzqwertyuiopasdfgh8jklzxc9vbn012mLEAKMExyzqwertyuiopas34dfghjk5lzxc6vbnmLEAKMExyzqwert78y9uiopasdfg0hjk1lzxcvbnmLEAKMExyzqwert2yuiopasdfghj3klzxcvbnmLEAKMExyzq4wertyu5iopasdfghjklzxc6vb7nmL8EAKMExyzqwer9tyuiop0asdfg1hj2klz34xcvbnmLEAKMExy5zq6wer7tyuiopasdfg8hjklz9xcvbn0mLEAK1MExyzq2we3rtyuiop4asdfghjk5lzxcvbn6mL7EAKM89Exyzqwertyuiopasdf0ghj1klzxcvb23nmLEA4KMExyzqwertyuiopasdfghjklzxcvbnmLEAK5ME6xyz7qwertyuiopasdfghjklzx8cvbnmLEAKMExyzq9wertyuiopa0sdfghjklzxcvbnmLEAKMExyzqwer1tyu2iop3asdfghj4klz5xcvbnmL6EA78KMExyzqwe9rtyuiopasdfghjklzxc0vbn1mLEAKMExy2zqwertyuiopas3dfg4hjklzxcvbnmLEAKMExyzqwertyui5.o-6pasdfgh7jklz8xcv9bnmL0EA_KMExyzq1_w-ertyuio2pas3df4gh5j6klzxcvbn7mLEAK8MExyzqw9ertyuiopa-s-df-gh0j1_2klzxcvb3n4mLEAKMExyzqwertyuio_pasdfghjk5lzxc_vbnmLEAKM6Exyzq7-wertyui8opasdfghjklzxcv9b0nmLEAKM1Exyzqwertyui234o5pasdfghjk6lz7xcvbn8mL9EAKMExyzqw0er1tyuiopas2dfghjklz_xc34v_bnmLEAKM_Exyzqwertyu5iopasdfg67-hjklz89xcvbnmL-0EAKMExyzqw1ert23y","uiopasd_fghjk":"lzxcvbnmLEAKMEx4yzqwertyuio5pa67sdf8ghj9k0lzx1cvbnmLEAKMEx2yzqwertyuiopasd3fg4hjklzxc5vbnmL6EAKMExyzq7wert.yuiopasdfghjklzxcvbnm8L9EA0KM1Exyzqwertyu23iopa4sd5fghjklzxcv67bnmLEAKMExyz8qwe9rtyuiopasdfghjklzxcvbnmLEAKME0xyzqwertyuiopasdfghjk1lzxcvbn2mLEAKMExyzq3wer4tyu5iopasdfghjk6lzx7cvbnmL8EA9K0MExyzqwertyuio1pas2dfghjk3lzxcvbnm4LE5AKME67xyzqwertyuiopas8dfghjklzxcv9bn01mLEAKME2xyzqwertyui3opa4s5dfghjkl67zxcvbnmLEA8KMEx9yzqw0ertyui1opasdf2ghjk3lz4xcvbnmLEAKM5Exyzqwertyuiopasdfghjklzxcv6bnmLEAKMExyzqwe7rtyu8iopasdfghjk9lzxcvb0nmLEAKME1xy2zqw3erty4uiopasdfghjklzxcvb5nmLEA6KM78Exyzqwertyuiopasdf9ghjklzxc0vbn1mLEAKMExyzqwert2y3u4iopasd5fghjklzx6cvbnmLE7AK8MExyzqwe9rtyuiopasdf0g1hjkl2zx3cvb4nmLEAKMExyzqwertyui5o6pasdfghjklz7xcv8bn9mLEAKMExyzq.wertyuiopa0sd1fghjklzxcvbnmLEAKMExyz2qwertyuiop3a45sdfg6hjk7lz_xcvbn8mLEA9K0MExyzqw1erty2ui3opasd45fghjklz6xcvbnmLEA7KM_E8xyzqwerty9ui0opasdf1gh-j2klzxcvbnm3LE4AK5MExyzqwertyui67o8pasdfghjklzx9cvbnmLE0AKM1Ex-2yzq3_wer_45tyu6i7o8pasdfgh9jkl01zxc2_3vbnmLEAK4MExyzqwertyuio5pa6sdfghjklzxc-vbn_78mLEAKMEx90yzqwertyuiop_asdf1ghjklzx23c4vbnmLE5AK6M","Exyzqwe_rt":"7890123456789","yuiopas_dfghjkl_zx":"0123456789012","cvbnm_LEAK":"MExyzq","werty":"uiopas
    dfghjkl zxcvbnm_LEAKME
    xyzqw","ertyui":"opa.sdfghjklz.xc","vbnm_LE":"34A5K678-M9E0-1234-5678-xyzq9012wert","yuiopasd":"fghjklzx","cvbnmLEAKM_Ex":"","yzqwert_yuio":"pasdfghj"}'
  WORKBUDDY_ACCOUNT_3YZQ4W56: '{"cvbnmL_EAKME":"xyzqwertyuiopas7dfghjkl8zxcvbnmLEAKMExyzq9werty0uiopasdfghjkl1zxcvb2nmLEAKMExyzqwe3rt4yuiopasdf5ghjklzx6cvb7nm8.LEAKMExyzqw9ertyuiopasdfghjklzx0cvb1nmLEAKMExyzqwer2ty34ui5opasdfghjklzxcvb6nmLEAKMExyzqwer7tyu8io9pasdfghj0klzxcvbnmL1EAKM2Exy3zqwertyuiopas4dfghjklzxcvbnmL5E6AK78M9Exyzqwertyuiopasd0fg1hjklzxcvbn23mLEAKMExyzqw4ert5yuiop678asdfghjklzxcvbnmLEAKM9Exyz0qwer1tyuiopasdfg2hj34klz5xcv6bnm7LEAKMEx8yzqwertyuiopasdfghjklzxcvbnmL90EA1KMExyzq2wertyui3opasdfghjklzxcvb45nmLEAKMExyzqwer6tyu7iopasdfghjklzxcvbnmLEAKMExyzqw89ertyu0iop1asdfg2hjklzx3cvbnmLEAKM4Exy5zqwer6tyuio7pasdf8ghjklzxcvbn9mLEAKMExyzqwe0rtyuiopa1sd2fgh3jklzx4cvbnmLE5AK6MExyzqwertyuiopasdfghj7klz8xcvbnmLEAKMEx9yzqwe012rtyuiopasd3fghjklzxcvbnmLEAKMExyz456qwertyuiop7as8dfghjkl9zxcv0bnm1LEAKMExyzqwertyuiopasdfghjk2lzxcvb3nmLEAKM4Exyzqwertyu5iopasdf6ghjklzxc7vb8nmL9EAKM0Exyzqwertyuiopa12sdfghjklzxc3vbn4mLEAKMExyzq5wertyuiopasdfghjklzxcvbnm6LEAKMExy7zqwert8yuiopasdfghjklzx9cvb0nmLEAKMExyz1qwertyuiopas2dfghjkl3zxcvbnm4LEAKMExyz56qwertyui7.op8as90dfghjklzxc1vbn2mLEAKM3Exyzqwertyuiop4asd-f56gh7jklzxcv8bn9mL_0EAKM1Exyzqwe2rtyuio3p4a5sdfghjk6lzxc7vb8nm90LE1AKM2Exyzqwert3yuiopasdfg45hj-klzxcv6bnm7LEAKMExyzqwertyui8opasdfgh9jkl0zxcv_bnmLEAKMExyzqwerty_uiopasdfghjklz_xcv1bnmLE2A3KMExyz4qwertyuiopasdfg5hj6klz78x9-cvb0nm1L2EAKME-3xyzqwer4t5yuiop6_7asdf8ghj9kl0zxcvb--nmLE1A2KMExyzqwer","tyuiopa_sdfgh":"jklzxcvbnmLEAKMExyzqwer3tyuiopasdfghjklzx4cvbnm5LEAKMEx6yzq7we8rtyu9iopasdfghjklzx01cvbnmLE2AKMExyzqwe.rtyuiopasdf3ghjklzxcvbnmLEAKMEx4yzq5wertyuiopasdfghjklzxc6vbnmLEAKMEx7y8zq90wer1tyu2iopasdfghjk3lzxcvbn4mLEAKMExyzqwert5yui6op78a9sdf01gh2j3klz4xcvbn5m6LEAKMExyzq7we8rtyuiop9asdfghjklzxcvbnmLEAKMEx0y1zq23w4ertyuiopasdfghjkl5zx6cvbnmLEAKM78Exyzqwertyui9opa0sdf1ghjkl2z3xcv4bnmLEAK5ME6xyzqwertyuiopasdfghjklzxcvbn7mLE8AK9MExyzqwertyuiopasdfghj01kl2zxcvbnm3LEAKMEx4yzqwertyuiopasdf56ghjklzxcvbnmLEA7KME8xyzqwertyuiop9asdfghjklzxcvbnmLEAKMExyzqw0ertyuiopasdfghj1klzx2cvbnmLEAKME3xyzqwe4rtyuiopa5sd6fgh7jklz8xcvbnmL.EA9KMExyzqwertyuiopasdf01ghjklzxcvbnmLEAK-ME2xyzqwe3rtyu4iop5asdf6gh_jkl78z9xcvbn0m1LE","AKMExyz_qw":"2345678901234","ertyuio_pasdfgh_jk":"5678901234567","lzxcv_bnmL":"EAKMEx","yzqwe":"rtyuio
    pasdfgh jklzxcv_bnmLEA
    KMExy","zqwert":"yui.opasdfghj.kl","zxcv_bn":"m89LEAK0-M123-4567-E890-1x23y45z67qw","ertyuiop":"asdfg","hjklzxcvbn_mL":"","EAKMExy_zqwe":"rtyuiopa"}'
  QODER_ACCOUNT_E89RT0Y1: '{"hjklzxcv_bnmLE_AKMEx":"yz-q23we4rtyuio5pasdfghjklz","xcvbnm_LEAKM":"Ex-y67zq8wertyu9iopasdfghjk","lzxcvbn_mLEAK":"MEx-yzqwe0rt1yuiopasdf23ghj4","klzxcv_bnmL":5678901234567,"EAKMExy_zqwer_tyuiop_asdf":8901234567890,"ghjklzx_cv":"1b23n4mL-56E7-8A90-K123-45ME6789xy01","zqw":"23e4rty5-67ui-8o90-12p3-a4s567d8f901","ghjklzxc":"vbnmL"}'
  QODERCN_ACCOUNT_23456SDF: '{"MExyzqwe_rtyui_opasd":"fg-hjklzxc7vbnmLEAKMExyzqwe","rtyuio_pasdf":"gh-jklzxcv8bnmLEAKMExyzqwer","tyuiopa_sdfgh":"jkl-zxcvbnmLEAK9MEx0yz1qwert","yuiopa_sdfg":2345678901234,"hjklzxc_vbnmL_EAKMEx_yzqw":5678901234567,"ertyuio_pa":"s8d9f0g1-h234-567j-kl8z-x901c234v5b6","nmL":"78E9A012-3K4M-567E-8901-2345xyz6q7we","rtyuiopa":"sdfg8901234567"}'
  ZCODE_ACCOUNT_890123W4: '{"jklzx_cvb":"nmLEAKMExyzqwer5tyuiopa6sdf7ghjklzx8.cvb9n0mLE1AKMExyzqwerty2uiopasd3fghjklzxcvb4n5mLEA67KMExyz8qwertyuiopasdfgh9jkl0zxc1vbnmLEA2KME3xyzqwertyui4opa5sdf6ghjkl78.zxcvbnmL9EAKMExyzqwer0tyuiop1as_dfg2hjklzxc","vbnmLE_AKM":"3E456x78-9yzq-0w12-e3r4-t5y67ui890op","asdf_gh":"12345678901234567","jklzxcvb_nmLEAK_MExyz":"qwertyuiopasdfghjkl8.zxc9v0bnm1L2EAKMExyzqwert34yuiopasdfghjkl5zxcv6bnmL7EAKME8xyzq9wertyuiopasdfgh0jklz1xcvbnmLEAKMExyzqwe2rtyuiopasdfg3hjklzx45cvbnmLEAKMExyzqwer6tyui7opasdfghjklzxcvbnmL8E90AKM1Exyz2qwe3rtyuiop4asd5fgh6jkl7zxcvbnmLEA8KMExyzqw9ertyuiopasd0.fgh1jklzxc2v3b45nmL6EAKMExy_zqw78er-ty9uio0p1a2sdfghjklzxcv3bnmLEAK4MExyzqwertyu5iopas","dfghjkl_zxcvb":"nmLEA678","KME_xyzqwer":"9.01.2","tyuiop":"asdfgh"}'
  TRAE_ACCOUNT_345678J9: '{"klzxcv_bnmLE":"AKMExyzqwertyui0opasdfg1hjk2lzxcvbn3.mLEAKMExyzq4wertyuiopas5dfg6hjk7lzx8cvb9nmLEAKMExyzqwer0tyuiopasd1fghj2klz3xcvbnm4LEA5KMExyzqwe6rtyui7opasdfghjkl8z9xcv0bnmLEAKME1xyzqwer2tyuiopas34dfghjk5lzxcvbnm6L7EAKMExyzq8wertyuiopa90s1dfghjkl23zxcv4bnm5LEAKMExyzqw6ertyuiopasdfghj7klzxcvbnmLE8AKMExyzqwertyuiopas9dfg0hjklzxcvbn1.mL2EA3KMExyzqwert4yuio5pas_6d7fghjklzxcvbnm8L9E0A1KMExyzqwert2yu3io4pas-dfghj5klzxcvbn6m78L9EAKMExy0zqwe1rtyuiopasdfghjklz2xcvbnmLEA3KMExyz-4qw5erty6uiop78asdfghjk9l0_zx1cvbnmLEAK2MExyzqwe34rtyuiopas5d6fg789_0hjklzx1cv2bnmLEAKMExyz3qwe4rty5uiopasd-fghjk6lzxcvbn7mLE8AKMEx90yzqwer1tyuiopa2_3sdf4g5-hjklzxcvbnm6LEAKMExyzqwer78tyuiopas9-dfg0hjk12l345zxcvbnmLEAK6MExyzqwertyuiopa7sdfghjkl8zxcvbn9mL0-1E2AK34MEx5yzqwe6rtyuiopasdfghjkl7-zxcvbnmLE8AKMEx9yzq0we1rt2yuiopasdfghjk3l456zxcvbnmLEAKM7Exyzqwertyuio8pasd-fghj9k01lzxcvbnmLEAKMExyzqw_e2rtyuiopasd_fg34hjklzxcvbn5mL_EA6KMExy7zqw89e01rtyuio2pasd-fghjk3l4zxcvbn5mL6EAKMExyzqwe7r-tyuiopa8sdfghj9klzxcvbnm0LEAK1M2Ex3yzqwerty4uio-p-asdfg5","hjklzxc_vbnmL":"EA6KMExyzqwerty7ui8o9p-as0dfghj1klzxcvbn23m=.45LE6789AK012ME3","xyzqwer_ty":"4567890123456","uio":"7890123456789012","pasdfghj":"用户34567890123","klzxc":"456******78","vbnmLEA_KM":"901E2345x67y890zq1wer2t34y5678u9","iopasd_fg":"0123hj4klzx567c89v0123b4nmL56E78","AKMExyzqwe_rt":"9y0u123i4op5a6"}'
  OPENCODE_ANON_RT7Y8U90: '{"hjk_lzx":"cvbnmL","EAKMExyz":"匿名通道"}'
`

test('R3: 脱敏真实形态 fixture — parse → render 逐字节相等（可移植，不依赖本机文件）', () => {
  assertByteIdentical(renderCredYaml(parseCredYaml(REAL_SHAPE_FIXTURE)), REAL_SHAPE_FIXTURE, '脱敏 fixture 往返')
})

test('R3: 脱敏 fixture 的形态自检 — 折行/段序/payload 映射都真的在里面', () => {
  const raw = REAL_SHAPE_FIXTURE.split('\n')
  assert.deepEqual(
    raw.filter((l) => /^[a-zA-Z_]+:/u.test(l)).map((l) => l.split(':')[0]),
    ['version', 'records', 'refs'],
    '段序必须是 DSH 自己的产出序（实测 5/5 真实文件都是 records 在前）',
  )
  const folded = raw.filter((l) => /^ {2}[^\s:]+: '[^']*$/u.test(l))
  assert.equal(folded.length, 2, '必须有 2 个折行标量（真实文件里 BUDDY/WORKBUDDY 两个）')
  const { refs, records } = parseCredYaml(REAL_SHAPE_FIXTURE)
  const foldedKeys = refs.filter(([, v]) => v.length > 2000).map(([k]) => k)
  assert.equal(foldedKeys.length, 2, '折行标量必须被完整拼回（长度 >2000 才说明没截断）')
  for (const [, v] of refs) {
    if (v.startsWith('{')) assert.doesNotThrow(() => JSON.parse(v), '长 JSON ref 拼回后必须合法')
  }
  for (const [, rec] of records) {
    assert.equal(typeof rec.payload, 'object', `record 的 payload 必须是对象（${rec.kind}）`)
  }
})

test('R3: 幂等 — render∘parse 跑两轮，第二轮逐字节不变', () => {
  const once = renderCredYaml(parseCredYaml(REAL_SHAPE_FIXTURE))
  const twice = renderCredYaml(parseCredYaml(once))
  assertByteIdentical(twice, once, 'render∘parse 幂等')
})

test('R3: 确定性 — 同一输入两次渲染逐字节相同', () => {
  const a = renderCredYaml(parseCredYaml(REAL_SHAPE_FIXTURE))
  const b = renderCredYaml(parseCredYaml(REAL_SHAPE_FIXTURE))
  assert.equal(a, b, '渲染必须确定性（Map 迭代序稳定）')
})

/* ── 第 3 轮：自检中发现的其余缺口 ── */

test('R3: 段内条目被删空时必须写成 refs: {} —— 裸 refs: 是 null，会被全拒式解析拒收', () => {
  const src = ['version: 1', 'refs:', "  ONLY: 'LEAKME-x'", 'records:', '  r/k:', '    kind: grant', ''].join('\n')
  const parsed = parseCredYaml(src)
  const out = renderCredYaml({ ...parsed, refs: new Map() })
  assert.ok(!/^refs:\s*$/mu.test(out), `空的 refs: 在 YAML 里是 null，不是空映射 ⇒ 整份文件可能被拒收。实际输出：\n${out}`)
  assert.equal(parseCredYaml(out).refs.length, 0)
  assert.equal(parseCredYaml(out).records.length, 1, '另一个段不受影响')
})

test('R3: 部分删除时，同段其他条目必须保持原始形态（不被整体规范化）', () => {
  const src = [
    'version: 1',
    'refs:',
    '  KEEP_PLAIN: LEAKME-plain-value',
    "  KEEP_QUOTED: 'LEAKME-quoted'",
    "  DROP_ME: 'LEAKME-gone'",
    '',
  ].join('\n')
  const parsed = parseCredYaml(src)
  const refs = new Map(parsed.refs)
  refs.delete('DROP_ME')
  const out = renderCredYaml({ ...parsed, refs })
  assert.ok(out.includes('  KEEP_PLAIN: LEAKME-plain-value'), 'plain 形态不得被改成带引号')
  assert.ok(out.includes("  KEEP_QUOTED: 'LEAKME-quoted'"), 'quoted 形态必须原样')
  assert.ok(!out.includes('DROP_ME'), '被删的条目必须整块移除')
})

test('R3: env 的非字符串值不得被 quote 成 [object Object]（静默改坏用户数据）', () => {
  const parsed = parseCredYaml([
    'version: 1',
    'records:',
    '  acme/grant:',
    '    kind: grant',
    '    env:',
    '      ACME_ID: \'id-1\'',
    '',
  ].join('\n'))
  const rec = new Map(parsed.records).get('acme/grant')
  rec.env = { ACME_ID: 'id-1', ACME_META: { region: 'cn', retries: 3 }, ACME_LIST: ['a', 'b'] }
  const back = new Map(parseCredYaml(renderCredYaml({ refs: new Map(), records: new Map([['acme/grant', rec]]) })).records)
  assert.deepEqual(back.get('acme/grant').env, {
    ACME_ID: 'id-1', ACME_META: { region: 'cn', retries: 3 }, ACME_LIST: ['a', 'b'],
  }, 'env 的对象/数组值必须结构化往返，不能变成 \'[object Object]\'')
})

test('R3: record 白名单之外的字段不得丢（第三方插件写的字段也要留住）', () => {
  const src = ['version: 1', 'records:', '  acme/grant:', '    kind: grant', "    extra_field: 'LEAKME-extra'", ''].join('\n')
  const parsed = parseCredYaml(src)
  assert.equal(new Map(parsed.records).get('acme/grant').extra_field, 'LEAKME-extra', '解析侧必须收下白名单外字段')
  const back = new Map(parseCredYaml(renderCredYaml({ refs: new Map(), records: new Map(parsed.records) })).records)
  assert.equal(back.get('acme/grant').extra_field, 'LEAKME-extra', '渲染侧不得把它丢掉')
})

test('R3: 空行 / 注释 / 未知顶层段也必须逐字节保留', () => {
  const src = [
    '# 手写注释',
    'version: 1',
    '',
    'refs:',
    "  A: 'LEAKME-a'",
    '',
    '# 段间注释',
    'records:',
    '  r/k:',
    '    kind: grant',
    '',
    'custom_section:',
    '  whatever: 1',
    '',
  ].join('\n')
  assertByteIdentical(renderCredYaml(parseCredYaml(src)), src, '注释/空行/未知段保真')
})

test('R3: 值被真正改动时走规范形态，且改后的值可被重新读回', () => {
  const src = ['version: 1', 'refs:', "  A: 'LEAKME-old'", "  B: 'LEAKME-keep'", ''].join('\n')
  const parsed = parseCredYaml(src)
  const refs = new Map(parsed.refs)
  refs.set('A', 'LEAKME-new')
  const out = renderCredYaml({ ...parsed, refs })
  const back = new Map(parseCredYaml(out).refs)
  assert.equal(back.get('A'), 'LEAKME-new')
  assert.equal(back.get('B'), 'LEAKME-keep', '未改动的条目必须原样保留')
  assert.ok(out.includes("  B: 'LEAKME-keep'"))
})

/* ═══════════════════ 第 3 轮续：CRLF（第 3 轮自检新发现） ═══════════════════
 *
 * JS 正则里 `.` **不匹配 `\r`**，而所有解析正则都以 `(.*)$` 收尾 ⇒ 一份 CRLF
 * 行尾的 .credentials.yaml 会**一行都解析不出来**：refs/records 全空。
 * 后果不是"少读一个字段"，而是合并时把空集当结果写回 ——
 * **整份凭据从文件里消失**。CRLF 完全可能（Windows 上的插件写盘、
 * 文件经 Windows 工具传输），所以必须按行尾无关来解析。
 */

const CRLF_DOC = [
  'version: 1',
  'records:',
  '  r/k:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  "      token: 'LEAKME-crlf-token'",
  'refs:',
  "  ACCT: '{\"access_token\":\"LEAKME-crlf\"}'",
  '',
].join('\r\n')

test('R3: CRLF 行尾必须照常解析（解析为空 = 合并写回时凭据全丢）', () => {
  const p = parseCredYaml(CRLF_DOC)
  assert.equal(p.refs.length, 1, 'CRLF 文件的 refs 不得解析为空')
  assert.equal(new Map(p.records).get('r/k').payload.token, 'LEAKME-crlf-token', 'CRLF 文件的 payload 不得解析为空')
  assert.equal(JSON.parse(p.refs[0][1]).access_token, 'LEAKME-crlf')
})

test('R3: CRLF 文件必须逐字节往返（否则每次同步都在重写用户的凭据文件）', () => {
  assertByteIdentical(renderCredYaml(parseCredYaml(CRLF_DOC)), CRLF_DOC, 'CRLF 往返')
})

test('R3: CRLF 文件走合并后凭据不得消失（端到端，后果最严重的一条）', () => {
  const doc = (v) => Buffer.from(`version: 1\r\nrefs:\r\n  ACCT: '${v}'\r\n`, 'utf8')
  const out = resolveOne({
    sectionId: 'credentials',
    base: undefined,
    ours: doc('LEAKME-local'),
    theirs: doc('LEAKME-remote'),
    path: '.credentials.yaml',
  })
  assert.equal(
    parseCredYaml(out.data.toString()).refs.length, 1,
    'CRLF 文件合并后凭据不得消失（解析为空 → 空集写回 = 全丢）',
  )
})

test('R3: 段内无法解析的子行不得触发凭空改写段头（保持逐字节）', () => {
  // Tab 缩进不是合法 YAML 缩进，解析器认不出来 —— 但认不出来也只能"原样留着"，
  // 不能顺手把 `refs:` 改写成 `refs: {}`（那是在用户文件里制造无谓的 diff）。
  const src = 'version: 1\nrefs:\n\tA: x\n'
  assertByteIdentical(renderCredYaml(parseCredYaml(src)), src, '未识别子行的保真')
})

test('R3: merge() 兜底 — 存活方是远端时必须 take-theirs（keepOurs 会把远端改动丢掉）', () => {
  // `merge()` 是 SECTION_MERGER 的登记入口，当前接线走不到（resolveOne 对
  // credentials 有专用分支），但登记了就得是对的：本地删除 + 远端改动时若返回
  // keepOurs，调用方会保留"本地那份删除"⇒ 远端的改动被丢。
  const out = mergeCred({
    ns: 'ref',
    base: { present: true, value: 'LEAKME-old' },
    ours: { present: false },
    theirs: { present: true, value: 'LEAKME-remote-edit' },
  })
  assert.notEqual(out.delete, true, '不得判成删除')
  assert.equal(out.kind, 'take-theirs', '存活方是远端 → 必须采纳远端')
  assert.notEqual(out.keepOurs, true, '绝不能 keepOurs（本地是删除）')
})

test('R3: merge() 兜底 — 存活方是本地时仍 keepOurs（原有语义不变）', () => {
  const out = mergeCred({
    ns: 'ref',
    base: { present: true, value: 'LEAKME-old' },
    ours: { present: true, value: 'LEAKME-local-edit' },
    theirs: { present: false },
  })
  assert.equal(out.kind, 'conflict')
  assert.equal(out.keepOurs, true, '存活方是本地 → 保住本地改动')
})
