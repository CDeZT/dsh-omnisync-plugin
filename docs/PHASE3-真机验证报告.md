# Phase 3 验收报告 —— 真机试装与真实数据闭环

> 目标：**自己装上跑一遍**，用真实数据验证，并把结论固化成测试。
> 结果：**130/130 测试通过** · 真实 `~/.dsh` 体检通过 · 端到端闭环通过
> 状态：代码已装进 desktop profile；**需重启桌面端激活最新修复**（见文末）

---

## 一、真机试装（做了，成功了）

```
dsh plugin --profile desktop add file:/Users/caliwater/Documents/dsh-sync/omnisync
→ dependencies 新增 @cdezt/dsh-omnisync
→ dsh.profile.bundles 新增 @cdezt/dsh-omnisync
→ node_modules/@cdezt/dsh-omnisync 就位
```

**装机前后零损失**（逐键 diff 过）：11 个已有依赖全在，bundles 只多不少，其他顶层键未变。
安装即**热挂载**——无需重启就注册了路由（`/omnisync/api/v1/messages` 返回 200）。

## 二、真机抓到 3 个只有装机才能发现的 bug

| # | 现象 | 严重性 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | 路由 500：`table.set is not a function` | 🔴 状态层全废 | 我按想当然写的 API 名。真实 API 是 `put()`（异步）/`get()`（**同步**）/`delete()`/`update()` | 改用 `put`/`get`；**并把测试桩换成忠实复刻**（见下） |
| 2 | 每次重启**静默丢全部状态** | 🔴 静默数据丢失 | storageDomain 加载记录时按 schema 解析，**未声明的键被 zod 剥掉**；我的 schema 漏了 `version` → `migrateState()` 判定"版本不符"→ 重置 | schema 补齐 `emptyState()` 全部字段；加"schema ⊇ emptyState"守卫 |
| 3 | 每次同步白遍历 29431 个文件 | 🟠 性能 | `walk()` 只做逐文件 ignore，仍会下潜 `node_modules`(18316)/`agy-accounts`(10867) | **目录级剪枝**：29431 → 223 文件，**19ms** |

第 1 个的修法值得记：光改代码不够，**测试桩必须与真接口同形**。现在的桩是照
`dsh-storage-domain/lib/index.js:236-292` 逐方法复刻的，还加了一条契约测试
——从真实源码解析方法名，断言"真实 API 没有 `set`"。

第 2 个是本次最有价值的发现：它不会报错、不会崩溃，只是每次重启后设备 ID、
确认状态、同步时间全部归零。

## 三、测试体系升级：从"自造桩"到"真实栈"

新增 `test/domain.test.mjs`：挂载**官方真实三件套**
（`dsh-storage` 中枢 + `dsh-storage-json` 真实 JSON 后端 + `dsh-storage-domain`），
与 `dsh-base/cordis.patch.yml:165-176` 的生产装配一致，只把 `root` 指向临时目录。

于是这些事变成了可测的：
- 接口误用（`set` vs `put`）→ 立刻失败
- **真的落盘**（去 `root` 下读文件确认）
- **跨重启保留**（关掉整个 ctx 再挂一遍，同一 root）
- schema 校验的真实时机（**在开域加载时，不在 put 时** —— 与直觉相反，已固化）

顺带学到的真实语义：真实后端是**节流写**，所以测试用"轮询磁盘条件"而不是魔法 sleep。

## 四、真实 `~/.dsh` 体检（`npm run verify`）

```
文件总数 173（29.8MB）· 已识别 145 · 未识别 28
```

未识别的 28 项逐条确认后**都该排除**：用户自己的 `backup-*/` 快照、
`dsh-config-manager` 内部状态、`.anonymous-user-id`（遥测 ID，设备绑定）、
`agy-accounts/**`（浏览器 profile+cookies）、`dsh-builtin-browser-host/history.jsonl`
（浏览历史）、`.plugin-manager/logs/**`（纯噪声）。

**体检驱动出两个真实缺口（已补）**：
1. `profiles/{name}/cordis.yml` —— profile 定义文件，之前完全没覆盖
2. `profiles/{name}/.dsh-market/state.json` —— 里面记着 `disabled: ["dsh-config-manager"]`，
   **就是"哪些插件被禁用"**，正是"同一桌面"体验的核心之一

## 五、端到端闭环（真实数据副本 + 本地裸仓）

```
镜像 14 项 → 提交 9f181a95 → 推送成功（仓库内 14 个文件）
✓ 仓库内无明文密钥（git grep sk-/tvly-/ghp_/AKIA/私钥 全部为空）
B 机克隆 → 落地 17 个文件
✓ profiles/desktop/package.json     逐字节一致
✓ profiles/desktop/cordis.patch.yml 逐字节一致
✓ profiles/desktop/pnpm-lock.yaml   逐字节一致
✓ .credentials.yaml                 逐字节一致（密文出门，明文还原）
```

`14 镜像 → 17 落地` 的差额正是 3 条走密文袋的记录（整文件秘密 + 2 条文本内嵌 key）。

## 六、守卫测试（把体检结论固化，防复发）

| 守卫 | 防的是什么 |
|---|---|
| 桩与真接口同形（从真实源码解析方法名） | 再出现 `set`/`put` 类误用 |
| schema ⊇ `emptyState()` 全部键 | 再出现"重启静默丢状态" |
| 遍历必须剪枝重量级目录 | 性能回退 |
| `NEVER_SYNC` 每条都必须判为不同步 | 硬排除清单被悄悄绕过 |
| 真实缺口已覆盖 + 敏感项仍排除 | 分区表漂移 |

## 七、当前状态与下一步

**已就绪**：插件装在 desktop profile，`/omnisync` 命令、设置页面板、三个模型工具、
定时同步、密文载荷、分区冲突裁决、依赖重建——全部代码就位，磁盘上是最新修复版。

**需要你做一件事**：**重启桌面端**。原因是 DSH 的热挂载只对**新装**插件生效；
已存在插件的代码变更必须重启（`pluginManager` 明确返回 `restart-required`）。
我没有自己重启，因为那会中断你正在用的这个窗口。

重启后验证（预期全绿）：
```
/omnisync status          # 应显示 state/device/remote/dirty，不再报 table.set
```
然后到 **设置 → Omnisync** 填 PAT 与仓库名即可开始真正同步。

**回滚方式**（如需）：profile 备份在 `~/Documents/dsh-sync/install-backup-20261004-115637/`，
或执行 `dsh plugin --profile desktop remove @cdezt/dsh-omnisync`。

## 八、仍留给 Phase 4

- Windows 实机验证（MSYS 防护、无 0600 的文件系统）
- 附件 blob 仓（内容寻址去重；当前走普通文件路径）
- 会话 fork 落盘到**本机**（当前落在镜像/工作树侧）
- npm 发布（`@cdezt/dsh-omnisync` 名字已确认可用）
- 口令的 UI 输入（当前经 `OMNISYNC_PASSPHRASE` 环境变量注入）
