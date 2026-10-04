# Phase 1 验收报告

> 交付物：`@cdezt/dsh-omnisync` v0.1.0 骨架 + git 通道 + 合并内核 + 快照闭环
> 状态：**已验收**（89/89 测试通过，含真 git 双机端到端）

---

## 一、交付清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.mjs` | ~470 | 宿主接线：Config 校验、git runner（ASKPASS+env 清洗）、storageDomain、命令、4 条 HTTP 路由、调度 |
| `client.js` | ~330 | 设置页面板：状态卡/引导向导/敏感分组开关/自动化程度/历史 |
| `lib/constants.mjs` | 88 | 词汇表：分区、正则、限额、硬排除清单 |
| `lib/errors.mjs` | 158 | 稳定错误码 + 工厂 |
| `lib/paths.mjs` | 247 | 路径断言/模板化/官方 projectKey 语义 |
| `lib/sanitize.mjs` | 114 | 日志脱敏（tvly/JWT/sk-/ghp_/userinfo） |
| `lib/crypto.mjs` | 200 | scrypt+AES-256-GCM 信封与 bag |
| `lib/sections.mjs` | 122 | 17 个同步分区注册表（默认拒绝模型） |
| `lib/scan.mjs` | 76 | 盘点与动作计划 |
| `lib/secrets.mjs` | 105 | 密钥分级 + 六分组 + 挖掘/回填 |
| `lib/snapshot.mjs` | 103 | 快照打包/校验/blob 外部化 |
| `lib/state.mjs` | 157 | 基线/墓碑/设备ID/回声防护 |
| `lib/git.mjs` | ~380 | 动词白名单 + GitBackend + 冲突四件套 |
| `lib/engine.mjs` | ~330 | 状态机 + reconcile→merge→apply→push |
| `lib/workspace.mjs` | ~230 | 真实 fs deps：原子写/0600/备份/镜像 |
| `lib/i18n.mjs` | 117 | 双语表（中文主表） |
| `lib/mergers/*.mjs` | 5 个 | keepboth / json / tree / patch-yaml / credentials |
| `test/*.test.mjs` | 1166 | 89 个测试 |

**实现 4302 行 + 测试 1166 行**，零第三方运行时依赖（只用 `node:` 内建 + peer）。

## 二、验收项逐条

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 插件在真 cordis Context 上挂载不抛 | ✅ | `mount.test.mjs` 用真 `Context` + 假服务 |
| 2 | 配置非法**响亮失败**（不静默半可用） | ✅ | repo 形态 / interval 范围 / confirmLevel 枚举三例 |
| 3 | 默认值全部落在安全侧 | ✅ | `repo=''`（不自动同步）、`confirmLevel='first-run'`、`toolConfirm=true`、六分组全开 |
| 4 | git argv 先置空 credential.helper | ✅ | 断言 `argv[1..2] === ['-c','credential.helper=']` |
| 5 | 17 个 GIT_* 全部置空 | ✅ | 逐变量断言 |
| 6 | ASKPASS 三变量正确 | ✅ | `GIT_ASKPASS/_REQUIRE/TERMINAL_PROMPT` + `GCM_INTERACTIVE=never` |
| 7 | **双机端到端逐字节一致** | ✅ | 真 bare 仓：A push → B clone → 3 个文件 `Buffer.equals` |
| 8 | **non-FF 被拒且识别为 PUSH_REJECTED** | ✅ | 真并发改动场景；**绝不强推** |
| 9 | **reconcile-and-retry 后两侧改动都在** | ✅ | fetch → beginMerge → commitMerge → push，两个文件都在 |
| 10 | 原子写落地权限 0600（覆盖写也是） | ✅ | `stat().mode & 0o777 === 0o600` |
| 11 | 宿主私有产物被排除 | ✅ | session.lock / migration.tmp / .DS_Store |
| 12 | 越界路径防御 | ✅ | `../escape` 与绝对路径均抛 PATH_UNSAFE |
| 13 | 备份环形保留 | ✅ | 8 份 → 保留最新 5 份 |
| 14 | 合并内核三大不变量 | ✅ | 绝不丢失 / 确定性 / 幂等 |
| 15 | 凭据记录级裁决（含墓碑/哨兵/假冲突） | ✅ | 28 个用例，含 R1-R22 实测结论的复现 |
| 16 | YAML 往返类型保真 | ✅ | 数字形态字符串 / 布尔 / null / 内联数组 |
| 17 | client 懒 CJS 契约 | ✅ | VM 沙箱验证 `load → factory → exports.apply` |

**89/89 通过，0 失败。**

## 三、Phase 1 期间发现并修复的真 bug

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | `expiryCandidates` 未先 `JSON.parse` 字符串 | **凭据过期裁决完全失效**（refs 的值是 JSON 文本） | 先试 JSON 再按标量判 |
| 2 | 时间字段正则过窄（漏 `refresh_token_expire_time`） | QODER 类凭证挖不到时间戳 | 改为 `/expir/` 子串匹配 |
| 3 | 墓碑闸门测试用例写错（用了纯字符串） | 掩盖了 TTL 语义 | 改用真实时间戳重写，并新增"新鲜墓碑仍阻止"对照 |
| 4 | `DEFAULTS` 键用大写 | `resolveConfig` 产出全 `undefined` → **配置校验完全失效** | 键名与 Config 字段对齐 |
| 5 | `git init` 未先建目录 | 首次引导 ENOENT | `ensureRepo` 先 `mkdir` |
| 6 | `serializeScalar` 未给数字形态字符串加引号 | MCP env 值类型漂移（`"123456"` → `123456`） | 歧义形态强制引号 |
| 7 | patch 渲染丢了 `config:` 层级 | 产出的 patch 文件 DSH 无法加载 | 渲染器补层级 + 嵌套 map 递归 |
| 8 | YAML 解析器缩进压平 | 条目结构错乱 | 重写为缩进感知递归解析 |
| 9 | `sanitize` 不认裸 `auth=` | 日志可能泄露凭据 | 加入赋值形态正则 |
| 10 | tree 合并"远端删+本地改"未记冲突 | 静默吞掉一次冲突 | 记录 `remote-deleted-local-modified` |

## 四、Phase 1 未覆盖（按计划留给后续阶段）

- **Phase 2**：`patch-yaml` 的 MCP 密钥占位化接入 engine 主流程、密文载荷（`secrets.enc.json`）的写入/读取闭环、确认门的 `userQuestions` 实测接线、会话镜像分支（mirror/sessions）
- **Phase 3**：会话双向同步（keep-both + fork 落盘）、附件 blob 仓、新机引导向导的完整流程、依赖重建（installBundle 序列）
- **Phase 4**：agent 工具三件套、Windows 实机验证、npm 发布

## 五、当前可用的功能（真机可跑）

1. `dsh plugin --profile desktop add @cdezt/dsh-omnisync` 安装
2. 设置 → Omnisync 填入 PAT + 仓库 → 验证保存
3. `/omnisync status|push|pull|diff|log` 命令
4. 设置页：状态卡 / 分组开关 / 自动化程度 / 历史
5. 定时（15m）+ 启动延迟（30s）自动同步
6. `$DSH_HOME` 全量镜像进 git 工作树并推送到私仓（含 0600、原子写、路径防御）
