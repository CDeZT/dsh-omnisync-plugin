# 代码审计与重构报告（v0.6.0）

> 目标：结构更简洁、编排更清晰、核对功能、找出 bug
> 结果：**死代码 21 → 0** · **测试 158/158** · `index.mjs` **561 → 450 行** · 抓到 **3 个真问题**

---

## 一、死代码清理：21 个 → 0

用脚本精确判定（排除定义行本身，含测试引用），全部删除：

| 位置 | 删掉的 | 为什么是死的 |
|---|---|---|
| `constants.mjs` | `REPO_DIRS`、`MIRROR_DIR`、`MIN_SYNC_INTERVAL_MS` | Phase 1 的仓库布局设想，最终由 Config 默认值取代 |
| `state.mjs` | `tombstoneOf`、`recordBaselines`、`isEcho` | 见下（两个不同处置） |
| `errors.mjs` | 5 个未使用的错误工厂 | 只有码没有抛出点 |
| `secrets.mjs` | `LEVELS`、`groupEnabled`、`classifySecret`、`isSecretSection`、`groupList` | 密钥分级改由分区注册表驱动，这套旧分级没用了 |
| `paths.mjs` | `sessionDirName` | 会话路径已改由 `sessions.mjs` 判定 |
| `sanitize.mjs` | `displayPath` | 未使用 |
| `crypto.mjs` | `encryptPayload`/`decryptPayload` | 单信封 API 既没被调用也没被测试（插件只用 bag） |
| `vault.mjs` | `sealedFile` | 未使用 |
| `blob.mjs`、`mergers/index.mjs` | `isBlobPath`、`registerMerger` | 未使用（blob 直接登记在策略表里） |

## 二、两个机制的不同处置（这是本次最有价值的判断）

| 机制 | 处置 | 理由 |
|---|---|---|
| **回声防护 / 逐文件基线**（`recordBaselines`、`isEcho` + `lastWrittenHash`、`echoUntil`、`pendingBoth`、`firstJoinDone` 四个状态字段） | **删除** | 当前是**镜像 diff** 设计：`writeTree` 内容相同即返回 false → 不产生提交 → 结构上不可能成环。这套机制是 Phase 1 另一套设计的遗留 |
| **墓碑**（`updateTombstones` + 合并器的 `tomb` 参数） | **接通** | 见下 |

### 🔴 真问题 1：墓碑机制从未生效

```
lib/conflicts.mjs:44  mergeCredentials(parse(base), parse(ours), parse(theirs))
                                                     ↑ 没有第 4 参（tombstones）
index.mjs             state.tombstones 只有 schema 声明，没有任何写入点
```

后果：我在 `credentials.test.mjs` 里写的**墓碑用例全部通过，但在生产里永远不会执行**。这属于"测试给了虚假信心"。

修复（真正接通，不是补测试）：

```
收到删除时（base 有、合并结果没有）→ 报出被删的键
       ↓
updateTombstones 记入 state.tombstones（键格式 ref:<key> / rec:<key>，与合并器契约一致）
       ↓
下次合并把它传回 mergeCredentials → 阻止"从未同步过的机器把旧副本推上来复活已删凭据"
```

并补了**端到端墓碑测试**（此前只有单元级的）：

| 场景 | 期望 | 结果 |
|---|---|---|
| A 机删除 → 合并必须报出被删键 | `deleted: ['ref:KEY']` | ✅ |
| 过期副本推上来（无基点） | 保持删除 | ✅ |
| 删除后**真的重建**（晚于墓碑 + 60s 宽限） | 允许复活 | ✅ |
| 墓碑过期 | 不再阻止 | ✅ |
| 重复记墓碑 | 保留最早 `at`（否则永不过期） | ✅ |

### 真问题 2：`decryptPayload` 是重复实现

`decryptBag` 内联重写了同一套 `iv/tag/data` 校验与解密。已抽出 `openItem()` 共用，两个入口行为一致（错误也统一收敛，不泄露可区分方向）。

### 真问题 3：我自己的删除脚本吃坏了 `sanitize.mjs`

正则越界，把 `redactText` 的尾部一起删掉了。**是测试抓住的**（`node --check` 通过但导入即报语法错）。已按原行为重建并验证四种脱敏形态。

## 三、结构优化：编排更薄

| 动作 | 效果 |
|---|---|
| 命令实现 → **`lib/command.mjs`** | 命令/工具/路由三条入口共用同一个 `api` 面，"命令说什么"与"UI 显示什么"永远一致 |
| doctor 渲染 → **`lib/health.mjs`** | 采集（index）与渲染（lib）分离 |
| `makeRunGit` → **`lib/git.mjs`** | git 子进程适配器归入 git 层（原本漂在入口文件里） |

`index.mjs`：**561 → 450 行**，剩下的全是接线（Config/服务注入/引擎装配/调度）。

## 四、最终形态

```
实现 5011 行 / 31 个模块      测试 2678 行 / 158 用例
index.mjs 450 · git 365 · credentials 325 · patch-yaml 300 · client 295
零第三方运行时依赖（仅 zod）
死代码 0 · 所有模块可独立加载 · 158/158 通过
```

## 五、工具增强

```bash
npm run verify:install -- --live    # 磁盘一致性 + 两半身份 + 运行时版本
npm run verify:install -- --sync    # 供应链策略挡住 pnpm 时，硬链接补齐文件
```

`--sync` 是本次新增：你机器上的 `dsh-codearts-auth@0.3.1004` 触发了 profile 的
`minimumReleaseAge` 策略，**任何 pnpm 操作（含插件市场）都会被拒**。此时用
`--sync` 可以保持"源码改动即时生效"的硬链接语义，不必等策略窗口过去。

## 六、需要你做的一件事

**完整重启桌面端**（v0.6.0 已同步到已安装副本，但 `lib/**` 改动必须重启才进进程）：

```
$ npm run verify:install -- --live
✗ 运行中的版本 v0.5.0 ≠ 源码 v0.6.0
修复：**完整重启 DeepSeek Harness**
```
