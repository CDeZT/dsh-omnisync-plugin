# 第三轮团队自检报告（v0.9.0）· 精简专轮

> 4 名队友（`deepseek-v4.1-flash`）× 3 轮「记基线 → 精简 → 全量验证」，写范围互不重叠；
> Lead 负责度量标尺、安全守卫、跨范围裁决与最终验收。
>
> **实现 6647 → 5400 行（−1247，−18.8%）· 测试 345 → 426（+81）· 审计五节全 0 · 覆盖率 0 未认领**

---

## 一、最终数字

| 指标 | 基线 | 终值 | 变化 |
|---|---|---|---|
| **实现总行数** | 6647 | **5400** | **−1247（−18.8%）** |
| ├ 代码行 | 4167 | 3845 | −322 |
| └ 注释行 | 1946 | 1555 | −391 |
| **`index.mjs`** | 461 | **299** | **−35%** |
| **`client.js`** | 291 | **231** | **−21%** |
| 合并内核（代码） | 1221 | **967** | **−20.8%** |
| 数据层（代码+注释） | 2015 | **1600** | **−20.6%** |
| 测试（既有 19 文件） | 5124 | 4872 | −252 |
| 测试用例 | 345 | **426** | **+81** |
| 未使用导出 | 13 | **0** | 收窄 API 面 |
| 死代码 / 重复实现 / 未测试模块 / 契约可疑 | — | **0 / 0 / 0 / 0** | 审计五节全清 |

**注释比全线下降**（超标模块从 9 个降到 0）：
`sessions 1.30→0.44`、`errors 1.38→0.45`、`rebind 1.09→0.58`、`sections 0.97→0.54`、
`secrets 0.97→0.38`、`crypto 0.96→0.34`、`sanitize 0.94→0.45`、`vault 0.87→0.43`。

---

## 二、精简是怎么做的（不是删注释凑数）

### 1. 抽掉的真重复（每类都 grep 验证零残留）

**实现层**
- `engine.mjs` 的**合并序列**（beginMerge → 裁决冲突 → commitMerge）原本在 pull 路径与
  push-重试路径**各写一遍**，两处的 report 累积方式还不一样（一个赋值、一个 push）——
  典型的"修了一处漏另一处"形态。抽成 `#mergeRemote` 单一实现。
- `git.mjs` 的 4 处 `#maybeSha` 样板 + 4 处 `split('\n').filter` → 两个私有 helper。
- **第 4 份深比较**：`credyaml.sameValue` 与 `mergers/equal.deepEqual` 同逻辑 → 合一。
- **表归一重复**：`credyaml.toMap` 与 `credentials.snapshotOf` 各写一份"→ Map" → 抽到 `equal.mjs`。
- `patch-yaml` 的 4 处同段逻辑（单侧缺失镜像分支、字段合并 4 次重复、内联判据两份、remove 渲染）。
- `keepboth`/`tree`/`json` 的镜像分支与手写循环 → 参数化。
- `rebind` 的 `templatizeValue`/`detemplatizeValue` 是**逐字相同**的双递归 → 合并成 `mapValue`。

**测试层**（`test/helpers.mjs` 199 行，唯一来源）
- 临时目录样板：11 文件 / 30 处 → `tmpRoot`/`tmpHomeTree`
- 真 git runner：**5 份逐字节相同**的 `nativeRun` → `nativeGit`
- **假 storageDomain 收敛为一份忠实副本** —— 它就是早先 `table.set is not a function` 事故的源头，
  以前有多份拷贝，现在只有一份
- `treeCtx/applyCtx` 字面量：6 处 8~13 行 → `fsCtx`
- 逐字节相同的 `fakeGit`（2 份）、`secretGroupOf`（2 份）、`caps`（2 份近似副本）→ 各合一
- `rejectsCode`：11 处错误码谓词样板 → 统一（**锁 code 而非"抛了就行"，强度不降反升**）

### 2. 注释瘦身的原则

**保留**：踩坑换来的"为什么"。judgment 标准是「删掉后新人还能不能明白这段为什么这么写」。
**删除**：复述代码在做什么（`// 遍历文件列表` 后就是 `for (const f of files)`）、
`@param` 签名复述、`research/*.md §N` 引用、设计散文、与代码无关的背景。

**删除清单里保留的"为什么"**（auditor-data 自查后列出，我复核）：
UNC 必须显式挡 / lstat 会误判云盘挂载点 / 无口令的一轮不得删既有密文袋 /
组关闭≠明文上传 / `:1`/`:10` 占位符前缀碰撞 / `${CMD:}` 必须先于 home 替换 /
1 MiB 会话备份阈值 / fork 绝不覆盖 / `existsLocal` 与 `exists` 的名字陷阱 /
多帧 zstd 静默截断 / 原子写为 chokidar / 无条件 chmod 0600 …

**两处边界删除（如实报）**：`paths.mjs` 头部"三步顺序铁律"删了，但理由移进了函数体内（离代码更近）；
`crypto.mjs` 一句"随机性来自 randomBytes"删了，改由新测试断言（事实变成可执行的）。

---

## 三、我做了什么（Lead 关键路径）

### 新增 `test/guards.test.mjs`（11 条）—— **精简轮的刹车**

精简轮最大的风险不是"测试红了"（立刻发现），而是**有人删掉一处没有测试覆盖的防御性检查**：
代码更短、测试全绿、安全性静默下降。所以我为 11 条安全不变量写了**行为级**断言，每条注明"删掉它会怎样"：

1. 路径越界必须拒绝（绝对/穿越/盘符/**UNC**/NUL）
2. 硬排除清单必须覆盖秘密与设备身份
3. **关掉的密级分组必须整份跳过**（绝不降级明文 —— 真实事故）
4. 口令错必须抛 `DECRYPT_FAILED`（不半写）
5. 错误消息必须脱敏（含插件自己用的 `github_pat_`）
6. 篡改的附件对象必须被拒（零写入）
7. git 动词白名单必须挡住强推/改历史/切分支
8. 无确认通道必须 fail closed
9. **状态 schema 必须覆盖 `emptyState()` 的每个键**（漏键 = 每次重启静默丢状态，踩过两次）
10. 会话路径裁决必须挡住穿越与宿主产物
11. **凭据经同步路径合并后值必须完全等价**

### 我自己的模块

- `engine.mjs`：合并序列消重（见上）
- `git.mjs`：两处样板消重
- `index.mjs` 导出 `stateSchema`（守卫 9 需要可测句柄）
- `sections.mjs`：删死参数 `vars`（形参 + 内部调用点）
- 收窄最后一个未使用导出（`expandSectionPath`）

### 度量标尺 `scripts/size.mjs`

把「代码 / 注释 / 空行」三分并给出注释比 —— 否则"精简"很容易变成"删注释"。
新增 `npm run size` / `npm run coverage`。

---

## 四、我裁决的三件事

### ① 撤回一个**我定错的指标**

我给测试精简定的 `≤3800 行` 是拍脑袋估的（依据是"重复 setup 很多"这个**未经验证的估计**）。
slim-tests 实测出：setup 只有约 725 行，测试体 4243 行 —— **3800 在"断言不许降 + 用例不许减"下数学上不可达**。

**我的裁决：接受地板值 4872，禁止"多行断言折叠"。** 那是行数游戏不是精简 —— 把 5 行断言压成
一行 200 字符，行数少了、可读性差了。**指标定错是我的问题，不该让队友用降低质量来凑数。**

### ② 批准 `lib/config.mjs`

auditor-core 指出：`index.mjs` 要减到 ≤300，但 `Config`/`DEFAULTS`/`stateSchema` 等纯声明
在他范围的 8 个文件里**没有内聚落点**（塞进任一个都是错位）。我批准新建一个只放声明的模块，
并要求：对外 API 逐字不变、只放声明不放行为、`stateSchema ⊇ emptyState` 不变量连同注释一起搬。

### ③ 一处行为修正：确认是对的

auditor-core 发现 `client.js` 错误分支是 `head, banner, banner` —— **同一个节点传了两次**。
那是**我**写反馈条时留下的复制粘贴 bug（msg 非空时渲染两遍）。他按"重复节点=bug"去重，
并补了渲染冒烟测试。**批准**。

---

## 五、队友的自我纠错（三轮的价值所在）

- **auditor-core**：`makeRebuildDeps` 用了 `badConfig` 却没 import → `/deps` 路由会抛
  `ReferenceError` 而不是 `BAD_CONFIG`。**被他自己的测试抓住**。另修好一处文档错位
  （`decryptFailed` 的 JSDoc 被相邻的 `backendUnsupported` 挤掉）。
- **slim-tests**：`rejectsCode` 迁移的正则太松，把 audit-backend 一个**复合谓词**吞了。
  全量跑红时抓到，逐处审计 11 个调用点，只此 1 处受损，已还原并加注释说明为何不能简化。
  **教训：正则迁移必须锚定谓词结尾。**
- **auditor-merge**：写护栏测试时**自己的 8 处假设是错的**（裸数字不是时间源、TTL 只清出现过的键、
  `degraded` 吞 null…），已按真实行为校正 —— 这正是那批测试能当护栏的前提。
- **auditor-data**：核实我转达的 4 处"疑似重复"，**3 处驳回并给出理由**（paths/rebind 职责不重叠、
  sections 四函数各有消费者、apply/sessions 抽原语会造成循环 import），只认下 1 处真重复。
- **attach-integrator**：**用三条 grep 证据更正了我的转达前提**（helpers 从未调用过
  `expandSectionPath`），并报出那个数学上不可达的指标。另主动披露了一次越界触碰（无影响）。

---

## 六、一个必须说清的诚实问题

**凭据的"逐字节保真"只在直接 `parse → render` 时成立；同步路径走规范重排。**

`snapshotOf` 只返回 `{refs, records}`，`raw.chunks` 在那里就丢了 → 同步路径经
`canonicalDocument` 渲染。**我实测了真实文件**：

```
原文件 10 refs / 3 records  →  往返后 10 refs / 3 records
refs 值等价 ✓   records 值等价 ✓
逐字节相等 ✗（8916 → 8989 字节：引号风格/折行位置被规范化）
```

**结论：值一个不丢，只是格式会重排一次。** 我已：
1. 把这条边界写进 `lib/credyaml.mjs` 头部（**不能让文档说谎**）
2. 加守卫 11 钉住真正要紧的那条 —— **值必须完全等价**
3. 记为已知限制（要消掉它需把 `p.raw` 透传进 `snapshotOf` 并按获胜方携带，
   那会改动合并数据流，属独立变更，不在精简轮做）

---

## 七、最终验收（Lead 亲跑）

```
node --test test/*.test.mjs      → 426/426 全绿
node scripts/audit.mjs           → 死代码 0 · 未使用导出 0 · 重复实现 0 · 未测试模块 0 · 契约可疑 0
node scripts/coverage.mjs        → 237 覆盖 / 26 硬排除 / 0 未认领
node scripts/verify-install.mjs  → 文件一致 · 全部硬链接 · 两半身份正确
node scripts/verify-real-home.mjs → 真实数据端到端：镜像 16 项 · 落地 21 项 · 抽样 4/4 逐字节一致
                                    · 明文泄漏 0 · 结论"全部通过"
```

**真实数据端到端**（这是最强的一条）：在 190 个真实文件形态的副本上跑完整闭环，
`profiles/desktop/{package.json,cordis.patch.yml,pnpm-lock.yaml}` 与 `.credentials.yaml`
**逐字节一致**，密文解密还原一致，仓库内**零明文密钥**。

规模：**39 个模块 / 3845 代码行 / 426 个测试**，零第三方运行时依赖（仅 zod）。

---

## 八、仍存风险（诚实清单）

1. **凭据同步路径走规范重排**（见第六节）—— 值不丢，格式会变。
2. **`credentials.degraded` 吞 null**：`payload.access_token: null` 会被 `??` 链跳过，
   判"未退化"。语义上 null access 应算退化。auditor-merge 用护栏测试钉住了现状，未改（改了即改变行为）。
3. **`patch-yaml.parseSeq` 是 O(n²)**：`lines.slice()` 复制整份行数组。数千行的 patch 文件才有感，
   改成"改写-还原"会牺牲可读性，未动。
4. **`apply`/`sessions` 的落地骨架仍未统一**：要抽共同原语需先解开 `apply → sessions` 的单向依赖。
5. **注释比已接近下限**：`zstd 0.29`、`workspace 0.26`、`crypto 0.34` —— 后续再想 −20% 只能动代码结构，
   **不适合再按行数考核**。
6. **Windows 实机未验证**、**npm 未发布**（`ENEEDAUTH`）。

---

## 九、需要你做的一件事

**完整重启桌面端**（v0.9.0 已同步到已安装副本，但 `lib/**` 改动必须重启才进进程）：

```
$ npm run verify:install -- --live
✗ 运行中的版本 ≠ 源码 v0.9.0
修复：**完整重启 DeepSeek Harness**
```

新增的运维命令：`npm run size`（规模度量）、`npm run coverage`（逐文件覆盖率）、`npm run audit`（五项审计）。
