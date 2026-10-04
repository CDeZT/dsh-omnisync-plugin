# 智能体团队三**轮**自检报告（v0.7.0）

> 4 名队友（全部 `deepseek-v4.1-flash`）× 3 轮「自检 → 写失败测试 → 修 → 复检」，
> 写范围互不重叠；Lead 负责关键路径、审计工具、跨范围裁决与最终验收。
>
> **结果：测试 158 → 258（+100）· 全绿 · 死代码 0 · 分区 18/18 可达 · 抓到约 40 个真问题**

---

## 一、最严重的 5 个（都真机复现过）

### 🔴 1. 组关闭 = 明文上传（安全事故）

`secretGroupOf()` 把"该分区**无**密级"和"声明了密级但用户**关掉了**"都返回 `null`，
而 `seal()` 只判 `!= null` → **关掉 `oauthGrants`/`homeEnv`/`secretsDir` 后，
`.credentials.yaml`、`.env`、`secrets/*.key` 原样明文进工作树并提交上云**。
实测三份 LEAKME 全在 tree 里，直接违反 README「组关闭 ≠ 明文上传」的承诺。

修法：`secretGroup` 改**三态** —— `undefined`=无密级 / `null`=组关闭→整份跳过 / `'<group>'`=加密，fail closed。
**Lead 独立端到端复验**：关掉三组后工作树零明文、非秘密文件照常同步。

### 🔴 2. 每次重启静默丢用户偏好

`emptyState()` 缺 `settings` 键，而 `migrateState()` 只回填该函数里存在的键
→ 每次重启把 repo/confirmLevel/secretGroups 全剥掉，`applySettings` 读到的永远是 undefined。

### 🔴 3. 脱敏表漏了插件**自己用的**令牌类型

`TOKEN_PATTERN` 缺 `github_pat_`（fine-grained PAT，正是本插件向导让用户创建的）与 `sci_`
→ git stderr 里的真 token 原样进日志，并经 `lastError` **同步上云**。

### 🔴 4. 确认门永远拒绝（approval 通道）

我按猜的契约写的：`approval.request()` 实际返回**字符串**（只有 `'allowed-once'` 是授权），
请求形状是 `{agent, toolName, reason}`。我写的 `result === true || result?.approved` **恒为假**。

### 🔴 5. 错误工厂不脱敏

契约是"调用方负责脱敏"，实测漏过 —— 令牌经 `gitFailed()` 进 message，
而 message 会写进体检报告并同步上云。改成**构造函数内兜底 `redactText`**（defense in depth）。

---

## 二、"验证是假的"—— 三处必须点名的自欺

| 问题 | 后果 |
|---|---|
| **e2e 测的不是生产路径** | e2e 走 `mirrorInto`（旧全量拷贝），**不封包秘密、不过滤分区、不重定基**。所谓"端到端已验证"验证的是另一条路。→ 改走 `applyToWorktree`+`applyToLocal`，并删掉 `mirrorInto` |
| **备份承诺是空的** | README 承诺"写本机前自动备份"，而 `backupFile`/`backupDir` **全仓库零调用点**。→ 接上（懒创建、只备份会改的文件、失败只 warn） |
| **keybindings 分区不可达** | 我上轮宣称"已修好"，实际只是让 `sectionForPath` 认得绝对路径；遍历只走 `$DSH_HOME`，**没有任何地方遍历 userData** → 分区永不参与同步。原测试只问注册表 = 假验证。→ 引入 `@userdata/` 虚拟外部根，测试改为**证明文件真被遍历捞到** |

---

## 三、其余真问题（按域）

**核心编排（auditor-core，6 个）**：确认门在落盘**之后**才问（拒绝也已写）；取消分支不复位状态（UI 假"同步中"）；`remember` 用分组对象覆盖整行状态（改一个开关即触发全量重置）；`beginMerge` 只在 stderr 找 "Already up to date"（git 打 stdout）；`listLocal` 漏排 `omnisync/mirror`（每轮白遍历全部会话）；请求体非 JSON 抛裸 SyntaxError → 500。

**合并内核（auditor-merge，15 个）**：`json.mjs` 顶层 undefined 写出字面量 `undefined`；`keepboth` 读不存在的 `verdict.forkPath`；`conflicts` 丢弃 `take-theirs` 的 data；删除裁决走 `checkout --ours` 失败后 `add -A` **把已删文件复活**；`patch-yaml` 丢 `remove:` 指令（被删配置复活）、三层嵌套渲染成 `[object Object]`；fork 一律冠远端设备 ID（同一分歧两机落到不同路径）；`credentials` 入口被喂 Buffer 时**静默返回 delete:true（删掉整份凭据文件）**；隔离区判定落在 keep-ours 之后（永不生效）；`credyaml` 把 record 的 `env:` 整块读丢、键名硬编码子集导致条目消失。

**数据流转（auditor-data，12 个）**：`restoreSecrets` 占位符前缀碰撞（`:1` 吃掉 `:10` → **第 10 个秘密丢失 + 第 1 个被复制**）；袋回填无路径/注册表/NEVER_SYNC 校验（远端可构造 `../../escape.txt`）；`templatize` 顺序错致 `${CMD:}` 永不匹配；**无口令的一轮删掉工作树里既有的密文袋 = 毁掉云端唯一副本**；袋回填缺幂等；袋 JSON 损坏抛裸 SyntaxError。

**Lead**：另加 `client.js` 的 `setMsg` 被调用 4 次但 `msg` **从未渲染**（所有按钮反馈对用户不可见）、`forks.mjs` UNC 路径逃逸（`\\server\share\x` 放行，Windows 上写网络共享）。

---

## 四、审计工具本身的缺陷（最省时间的一条）

auditor-data 发现我的 `audit.mjs` 契约检查**成片假阳性**，会让 3 名审计员白改签名：

1. **嵌套括号截断**：`\bfn\(([^)]*)\)` 遇到 `fn(a(b), c)` 读成 1 个实参 → 改**括号配平**扫描
2. **注释里的示例调用**被当真（`migrateState()` 出现在说明文字里）→ 加**去注释**
3. **依赖注入同名回调**（engine 从 deps 解构的 `applyToLocal`/`confirm` 不是 lib 里的函数）→ 列 `KNOWN_FALSE_POSITIVES`
4. **Merger 接口约定**：各实现同名 `merge` 是设计要求 → 列 `KNOWN_DUPE_INTERFACES`

修完「⑤ 契约可疑」从 10 → **0**，并把结论广播给全部队友。

---

## 五、补全的功能

| 模块 | 行数 | 作用 |
|---|---|---|
| `lib/attachments.mjs` | 118 | 附件内容寻址：路径即 `sha256`，**缺引用硬失败**（不静默跳过），引用完整性检查 |
| `lib/forks.mjs` | 98 | keep-both 的 fork **补落到本机**（此前只落镜像树/远端，用户不知道有过冲突、也取不回远端版本） |
| 外部根支持 | — | `@userdata/` 虚拟前缀，让 keybindings 真正可达 |

接线（Lead 完成）：`landForks` 挂在两处 `resolveConflicts`（**不能挂 `applyToLocal`** —— push 路径根本没有它）、`backupDir`/`backupFile`、`removeTree`（删除裁决）、`externalRoots`、`deviceId` 兜底改 `'unknown0'`（`'unknown'` 只有 7 位，fork 名不匹配协议常量）。

---

## 六、最终验收（Lead 亲跑）

```
node --test test/*.test.mjs          → 258/258 全绿
node scripts/audit.mjs               → 死代码 0 · 契约可疑 0
node scripts/verify-install.mjs      → 34/34 文件一致 · 全部硬链接 · 两半身份正确
node scripts/verify-install.mjs --live → 运行中 v0.6.0 ≠ 源码 v0.7.0（需重启）
分区可达性                            → 18/18（含外部根 @userdata/keybindings.json）
```

规模：**34 个模块 / 5646 行实现 / 4651 行测试**，零第三方运行时依赖（仅 zod）。

---

## 七、仍存风险（诚实清单）

1. **`extractRefs` 的引用形态是推断的**：解压全部 68 个会话 + 扫 projcache，**0 个 attachment 引用命中**（唯一 object 是孤儿）。三种形态按合理约定写的 —— 若 DSH 真实形态不同 → **漏检**（不误报卡死，因为刻意不收裸 hash）。
2. **zstd 解压未做**：`checkReferences` 的 `texts` 需已解压文本，而 sessions 是 `.jsonl.zstd`。接线时需决定在哪解压。
3. **`verifyObjectData` 尚未接入写入路径**：内容寻址的"写一次不可变"目前仍只靠 blob 合并器事后发现。
4. **`keybindings` 是 deviceScoped**：两台机器各推各的会互相覆盖（同一文件）。语义上"快捷键不该跨机覆盖"，但当前 json 合并器会按 key 级合并 —— 需要时再决定是否整份跳过。
5. **确认门的预估是干跑**：预估与实际写之间有极窄竞态窗口（仅本机自变更可触发，且落地幂等）。
6. **Windows 实机未验证**、**npm 未发布**（`ENEEDAUTH`）。

---

## 八、需要你做的一件事

**完整重启桌面端**（v0.7.0 已同步到已安装副本，但 `lib/**` 改动必须重启才进进程）：

```
$ npm run verify:install -- --live
✗ 运行中的版本 v0.6.0 ≠ 源码 v0.7.0
修复：**完整重启 DeepSeek Harness**
```
