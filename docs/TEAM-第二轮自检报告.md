# 第二轮团队自检报告（v0.8.0）

> 4 名队友（`deepseek-v4.1-flash`）× 3 轮「自检 → 写失败测试 → 修 → 复检」，
> 写范围互不重叠；Lead 负责覆盖率审计、接线与最终验收。
>
> **测试 259 → 345（+86）· 全绿 · 覆盖率 0 未认领 · 审计五项全清 · 新增 2 个功能**

---

## 一、功能覆盖：从"以为覆盖了"到"逐文件证明覆盖了"

你要求「所有我想要的都能同步起来」。我先做了一次**逐文件覆盖率审计**，结果发现两件事：

### ① 我上一轮的覆盖率统计**骗了我**

旧脚本按"顶层目录分组、取组内首文件的归属"统计，于是 `profiles/desktop` 因组内首文件
（市场缓存）未覆盖而被**整组标红** —— 我差点给 5 个**已经覆盖**的文件重复加分区。

新脚本（`npm run coverage`）改成**逐文件判定**，三态归属：分区 / 硬排除 / **未认领（必须为 0）**。

### ② 真实缺口（逐文件审计后修掉的）

| 缺口 | 处置 | 理由 |
|---|---|---|
| `profiles/desktop/cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | **拆出 `profile-yaml` 分区** | 它们**早已**在 `profile-manifest` 里，但那个分区用 `json` 合并器 —— 实测把 YAML 判成 `invalid JSON` → **每次分叉都 conflict + 远端被隔离 = 永不合并**。缺 `pnpm-workspace.yaml` 新机器还会**再次被供应链策略挡住** |
| `dsh-config-manager/vault/.credentials.yaml` | 收进**凭据分区** | 与 live 文件**同格式**（`version: 1` + `records:`）→ 走同样的记录级合并与加密 |
| `dsh-config-manager/sync/*` | 新增 `config-manager` 分区 | UI 偏好、备份计划（跨机一致） |
| `jet-hub/auto-checkin.json` | 并入 `jet-hub-state` | 用户配置（此前只覆盖 state/permanent-locks） |
| `backup-*/`（5 个目录 14 文件） | **硬排除（正则）** | 用户自己的回滚快照，跨机传播 = 旧版覆盖新版 |
| `dsh-config-manager/{boot-state,transactions,migration-history,exports}`、`.anonymous-user-id`、`environment-fingerprint.token`、`browser-host/history.jsonl`、`agy-link/runtime-overrides.json`、`storages/omnisync.json` | **硬排除（正则）** | 设备身份 / 机器指纹 / 运行态 / 隐私 / 按设备隔离的插件状态 |

`NEVER_SYNC` 从"精确前缀表"扩为**精确表 + 正则模式**（`NEVER_SYNC_PATTERNS`，每条都写明理由），
因为 `backup-<时间戳>/` 这类名字不固定，前缀表表达不了。

**结果：251 个真实文件 → 237 已覆盖 / 26 硬排除 / 0 未认领**，并落成守卫测试。

---

## 二、新增功能

### 1. 文件夹后端：网盘即媒介（你原始需求里的 iCloud 那条）

```
iCloud Drive/dsh-omnisync.git/     ← 裸仓，网盘客户端负责跨机复制这个目录
```

**关键设计：不重写合并逻辑** —— 网盘目录里放一个 git 裸仓，只把 `remote` 从 URL 换成
本地绝对路径。三方合并、非 FF 拒绝、墓碑、fork **全部复用现有 `GitBackend`**。

`lib/backend-folder.mjs`（160 行）+ 19 个测试（**真临时目录 + 真 git 裸仓，零 mock**）：
- 8 种拒绝码：`NOT_MOUNTED` / `NOT_A_DIR` / `READ_ONLY` / `UNREADABLE` / `EVICTED`(`.icloud`) / `SYNCING`(`.part`) / `LOCKED` / `NOT_BARE`
- **绝不覆盖用户数据**：非裸仓有数据 → 拒绝；云盘根不存在 → 拒绝且**不创建**（mkdir 出来会是个"看着成功、永不同步"的本地目录）
- 冲突副本识别（iCloud ` 2` / Dropbox `(conflicted copy)` / `.conflict-*`）—— **只报告不删除**
- 自审抓到真 bug：云盘根常是**符号链接**，原先用 `lstat` 会把合法挂载点误判成"不是目录"

**Lead 做的 `allowInit` 决策**：只在**本机首轮**允许建仓。云盘客户端还没把对端裸仓同步下来时
目录可能"存在但空"，此时抢建空仓 = **与对端分叉**（两边各自成为根，再也合不到一起）。

### 2. 按分区选择同步（你原需求里的"逐项选择"）

20 个分区逐项开关，**注册表驱动**（新增分区自动出现在 UI，不需要改 UI 代码）。
关掉的分区等同"未分类" → 不进工作树。偏好持久化（`disabledSections`），重启仍生效。
Lead 顺带修了一个真 bug：**启动时没 hydrate 偏好** → 重启后开关显示开着、实际没生效。

---

## 三、最严重的 6 个 bug（都有失败测试复现）

| # | 问题 | 后果 |
|---|---|---|
| 1 | **多帧 zstd 只解第一帧**（Node 的 `zstdDecompressSync` 静默丢帧：34.4MB → 0.02MB） | 上一轮报"0 个附件引用"是**假阴性**，漏检 99.988% → 引用完整性检查形同虚设 |
| 2 | **真实引用形态是 `attachmentId: "sha256:<64hex>"`**，旧实现要求**裸** 64hex | 对真实形态返回 `[]` → 检查永不生效 |
| 3 | **`payload:` 被读成字符串**（真实是 YAML 嵌套映射） | DSH 全拒式解析 → **整份凭据文件被拒收 = 用户凭据全丢** |
| 4 | **CRLF 行尾让一行都解析不出来**（JS 正则 `.` 不匹配 `\r`） | 合并把空集写回 → **整份凭据消失**。CRLF 完全可能（Windows 写盘/传输） |
| 5 | **会话"本机领先"被旧树覆盖** | `omnisync pull`（pull 模式不跑 mirror）+ sync 模式远端领先的任何一轮 → **静默丢本机新对话** |
| 6 | **凭据文件段序/折行/引号风格被重排** | 真实文件往返 **0/5 相等** → 每轮同步都在改用户的凭据文件 |

第 3、4、6 条同属旗舰功能（凭据记录级合并），修后**真实文件往返 5/5 逐字节相等**，
并与真 YAML 库逐值交叉验证一致。

---

## 四、队友的自我纠错（这是"三轮"的价值）

- **credyaml-hardener**：第一版 fixture 把**段名也替换了**，导致整份文件退化成一段 raw、
  往返"通过"却**根本没走到解析器** —— 是那条形态自检测试抓出来的假阳性。
- **session-guard**：**用实测纠正了我的任务书** —— 我写"单文件最大 1.4MB"，实测 **4.48MB**；
  据此把备份阈值从建议的 4MB 改为 **1MiB**（>4MB 只有 1 个文件，阈值几乎不起作用；
  >1MiB 的 6 个文件占 42% 字节，而最大的文件恰恰改得最勤）。
- **attach-integrator**：**推翻了自己上一轮的结论**（"0 个引用"），找到根因是解压错。
- **backend-folder**：自审发现 `lstat` 误判符号链接挂载点。

---

## 五、最终验收（Lead 亲跑）

```
node --test test/*.test.mjs        → 345/345 全绿
node scripts/audit.mjs             → 死代码 0 · 重复实现 0 · 未测试模块 0 · 契约可疑 0
node scripts/coverage.mjs          → 237 覆盖 / 26 硬排除 / 0 未认领
node scripts/verify-install.mjs    → 36/36 文件一致 · 全部硬链接 · 两半身份正确
分区                               → 20 个，merger 全注册
```

规模：**36 个模块 / 6745 行实现 / 6340 行测试**，零第三方运行时依赖（仅 zod）。

Lead 本轮自查另修 4 个：`mountCtx` 测试桩用的是**不存在的 API**（`set` + 异步 `get`，
正是早先 `table.set is not a function` 事故的源头）、启动未 hydrate 偏好、
`pathUnsafe` 调用少传一个参数（消息印 `undefined`）、附件对象落本机**未经校验**。

---

## 六、仍存风险（诚实清单）

1. **凭据冲突路径拿不到原始形态**：`conflicts.mjs` 经 `snapshotOf` 中转丢了 `raw.chunks` →
   一旦 git 报冲突，整份文件走规范渲染（**值不丢**，但引号/折行/段序被重排）。
   要保真需把 `p.raw` 透传并随获胜方携带。
2. **宽版 `extractRefs` 的散文误报**：实测 281 处散文路径，当前恰好都指向存在的对象；
   一旦报告提到已删对象的路径就会误报。**生产已用 `strict: true`**（实测形态），风险已隔离。
3. **`mirrorSessions` 只追加、从不删除**：本机删了会话不会同步删除（保持 keep-both 语义）。
4. **网盘目录级合并非原子**：两台机器几乎同时 push，云盘可能在 `refs/heads/main` 上产生
   冲突副本 → 模块**报告但不自动裁决**（自动合并 refs = 拿历史赌博）。
5. **深层驱逐漏检**：`objects/ab/xxx` 被 iCloud evict 成 `.xxx.icloud` 时顶层扫描看不到 ——
   但 git 会**响亮失败**，不会静默损坏。
6. **Windows 实机未验证**、**npm 未发布**（`ENEEDAUTH`）。

---

## 七、需要你做的一件事

**完整重启桌面端**（v0.8.0 已同步到已安装副本，但 `lib/**` 改动必须重启才进进程）：

```
$ npm run verify:install -- --live
✗ 运行中的版本 v0.7.0 ≠ 源码 v0.8.0
修复：**完整重启 DeepSeek Harness**
```

重启后你会看到两个新东西：设置面板里的「**同步范围**」（20 个分区逐项开关），
以及插件配置里的 `folderRemote`（填网盘裸仓路径即可不用 GitHub）。
