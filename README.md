# @cdezt/dsh-omnisync

**DeepSeek Harness 桌面端全量云同步插件** —— 把本机 `$DSH_HOME` 的全部持久状态同步到
一个 GitHub 私有仓库。目标是"仿佛 DSH 部署在云主机：任意一台真实主机访问的都是同一个
desktop 桌面端"。

- 平台：macOS + Windows（desktop profile 专用，不使用 web profile）
- 通道：GitHub 私有仓库（HTTPS + fine-grained PAT）
- 代码：纯 ESM JavaScript，**零构建**，`lib/` 零 DSH 依赖（全部可单测）
- 依赖：仅 `node:` 内建 + `@deepseek-ai/*` peer（不引第三方运行时库）

---

## 它同步什么

**20 个分区，装好即全部同步**（想关哪个在「设置 → 同步范围」里逐项关掉，偏好持久化）。
列表由注册表驱动 —— 新增分区自动出现在 UI，不需要改前端。

| 分区 | 内容 | 合并策略 | 密级 |
|---|---|---|---|
| `home-patch` / `profile-patch` | 两处 `cordis.patch.yml` | 条目 id 级 | 🔑 |
| `profile-manifest` | profile 的 `package.json`、`compatibility.json` | key 级，**本地优先**（被远端覆盖 = crash loop） | — |
| `profile-yaml` | `cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | keep-both | — |
| `credentials` | `.credentials.yaml` + config-manager 的 vault 副本 | **记录级三方合并**（生态空白） | 🔑 |
| `workspace` | `storages/workspace.json` | key 级 + **路径跨机重定基** | — |
| `instructions` / `skills-dsh` / `skills-secrets` | `AGENTS.md`、技能树、技能密钥 | keep-both / 树级 | 🔑 |
| `env-home` | `.env` | keep-both（走加密） | 🔑 |
| `config-manager` | `dsh-config-manager/sync/*`（UI 偏好、备份计划） | key 级 | — |
| `keybindings` | **Electron userData 下的** `keybindings.json`（外部根） | key 级，按设备 | — |
| `attachments` | `attachments/v1/objects/**`（内容寻址） | blob：同路径即同内容，内容不同**硬失败** | — |
| `jet-hub-state` | 渠道账号索引 / 锁 / 自动签到 | key 级 | 🔑 |
| `browser-settings` / `agy-sessions` / `market-state` | 内置浏览器设置、agy 会话、市场状态 | key 级 | — |
| `device-health` | 每台机器的体检报告（**远程排障窗口**） | key 级 | — |
| `sessions` / `sessions-projcache` | 会话本体 + 投影缓存（**独立分支双向**） | 字节级 keep-both + fork | — |

**永不同步**（硬编码 + 正则，不可配置）：本插件的 `github.token` / `passphrase.vault`、
凭据锁文件、浏览器 cookies 与历史、活体 CDP 令牌、网关明文 key、`node_modules`、`cache`、
**用户自己的 `backup-*/` 回滚快照**、设备身份与机器指纹、其它插件的运行态（事务/迁移/导出）。

**覆盖率是逐文件审计的**（`npm run coverage`）：真实 `~/.dsh` 里**每个文件都必须有明确归属** ——
要么属于某个分区，要么在硬排除清单里（每条都写明理由）。未认领文件数必须为 0。

---

## 三条不可协商的安全铁律

1. **PAT 只经 `GIT_ASKPASS` 脚本注入**，且每条 git 命令前置 `-c credential.helper=` 置空
   —— 否则宿主机的 osxkeychain / Windows GCM 会顶掉 ASKPASS（本机实测），GCM 无人值守
   还会弹窗挂死。token 绝不进 argv、绝不进 `.git/config`。
2. **17 个 `GIT_*` 环境变量显式置空** —— `GIT_DIR` 之类会关闭仓库发现并让 git 指向别处。
3. **落盘后无条件 `chmod 0600`** —— git 不保存权限位，clone 出来必然是 0644，而 DSH 的
   `assertOwnerOnly` 会因此让凭据插件**整个挂掉**（实测）。

另外：首次接入**一律并集加入**，绝不"远端为准"覆盖本地（VSCode Settings Sync 删库事故的教训）。

---

## 安装

**从 GitHub 直接安装**（推荐；本包未发布到 npm）：

```
# 1) 找到桌面端 CLI
#    macOS : /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
#    Windows: <安装目录>\resources\runtime\cli\bin\dsh.cmd

# 2) 从公开仓库装（desktop profile）
dsh plugin --profile desktop add github:CDeZT/dsh-omnisync-plugin

#    或先克隆再按本地路径装（便于改代码）
git clone https://github.com/CDeZT/dsh-omnisync-plugin
dsh plugin --profile desktop add file:<克隆目录的绝对路径>
```

也可用应用内「设置 → 插件」安装。

> **装完必须完整重启桌面端**：DSH 的热重载只重新 import 插件入口 `index.mjs`，
> `lib/**` 会留在 ESM 缓存里（磁盘是新版、进程是旧版）。重装**无效**，必须退出应用再打开。
> 用 `npm run verify:install -- --live` 可以检测这个状态。

### Windows 注意

- 路径分隔符与家目录已按平台处理（Windows 用 `USERPROFILE`，不是 `HOME`）—— 有守卫测试钉住。
- git 凭据走 `GIT_ASKPASS`，并显式清空 `credential.helper`，**不会**触发 GCM 弹窗。
- 会话文件是 `.jsonl.zstd`，多帧拼接；解压用自实现的多帧走帧（Node 内建只解第一帧且不报错）。

## 首次配置（5 分钟）

1. 打开 **设置 → Omnisync**
2. 点「打开 GitHub 预填页面」→ 生成 fine-grained PAT（**只勾选一个仓库的 Contents 读写**，366 天）
3. 粘贴令牌 + 填 `owner/repo` → 点「验证并保存」（插件会 `ls-remote` 验通后才落盘）
4. 在第一台机器上点「立即同步」→ 首次会确认一次 → 之后全自动

第二台机器重复 1-4，**密文口令与第一台保持一致**即可。

## 两台机器怎么"通信"

**它们不直接通信 —— 私有仓库就是通信媒介。**

```
        ┌──────────────────────────────┐
        │  GitHub 私仓（唯一媒介）        │
        │  main            ← 配置流      │
        │  mirror/sessions ← 会话流      │
        └──────────────────────────────┘
              ▲                  │
        push  │                  │  pull
              │                  ▼
         [Mac]                [Windows]
```

所以：不需要知道对方 IP、不开端口、不做 NAT 穿透、不用跑服务器，**也不需要同时在线**
（异步的，谁先谁后都行）。冲突由 git 自己算 base/ours/theirs，我们只在冲突路径上跑分区合并器。

## 远程排障（换台电脑出问题时看这里）

每台机器每次同步前写一份自己的健康快照到 `omnisync-devices/<deviceId>.json`，
它会像其他数据一样**被推上云**。于是 Windows 那边出错时，Mac 上 `/omnisync doctor`
就能看到对面怎么了 —— 否则你只能坐在一台机器前面猜。

报告只含**结构性事实**（版本/平台/错误码/计数），**不含**用户名、绝对路径、文件内容、密钥形态。

修复流程：`doctor` 看到 `code` → 改代码 → 发版 → 各机器经插件市场或 CLI 更新。
**代码不走同步通道**（那是配置数据）；但插件清单会同步，新机器能自动装齐同一套插件。

## 备份

`/omnisync pull` 在**覆盖本机文件之前**会先把原内容备份到
`$DSH_HOME/omnisync/backups/<时间戳>/`（保持相对路径结构，便于直接取回），
并按 `backupKeep` 保留最近若干份。备份目录在硬排除清单里，**绝不上云**。

## 同步范围（全部 20 个分区）

装好即**全部同步**；想关哪个在设置面板的「同步范围」里逐项关掉（偏好持久化，重启仍生效）。
列表由注册表驱动 —— 新增分区会自动出现，不需要改 UI。

| 分区 | 内容 | 合并策略 |
|---|---|---|
| `home-patch` / `profile-patch` | `cordis.patch.yml`（$DSH_HOME 与 profile 两处） | 条目 id 级 |
| `profile-manifest` | `package.json`、`compatibility.json` | key 级，**本地优先**（被远端覆盖 = crash loop） |
| `profile-yaml` | `cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` | keep-both（**YAML 绝不能走 json 合并器**：实测判 invalid JSON → 永不合并） |
| `credentials` | `.credentials.yaml` + config-manager 的 vault 副本 | **记录级三方合并**（生态空白） |
| `workspace` | `storages/workspace.json` | key 级 + **路径跨机重定基** |
| `instructions` / `skills-dsh` / `skills-secrets` | `AGENTS.md`、技能树、技能密钥 | keep-both / 树级 |
| `env-home` | `.env` | keep-both（走加密） |
| `config-manager` | `dsh-config-manager/sync/*`（UI 偏好、备份计划） | key 级 |
| `keybindings` | **Electron userData 下的** `keybindings.json`（外部根） | key 级，按设备 |
| `attachments` | `attachments/v1/objects/**`（内容寻址） | blob：同路径即同内容，内容不同**硬失败** |
| `jet-hub-state` | 渠道账号索引 / 锁 / 自动签到 | key 级（加密） |
| `browser-settings` / `agy-sessions` / `market-state` | 内置浏览器设置、agy 会话、市场状态 | key 级 |
| `device-health` | 每台机器的体检报告（**远程排障窗口**） | key 级 |
| `sessions` / `sessions-projcache` | 会话本体 + 投影缓存（**独立分支双向**） | 字节级 keep-both + fork |

**覆盖率是逐文件审计的**（`npm run coverage`）：真实 `~/.dsh` 里**每个文件都必须有明确归属** ——
要么属于某个分区，要么在硬排除清单里（精确表 + 正则模式，每条都写明理由）。未认领文件数必须为 0。

## 命令与工具

```
/omnisync status     # 状态（默认）
/omnisync push       # 镜像 → 提交 → 推送（被拒自动 reconcile 一次，绝不强推）
/omnisync pull       # fetch → 合并 → 应用（写本机前自动备份，见「备份」）
/omnisync diff       # 本机相对上次推送的变更
/omnisync log        # 仓库最近提交
/omnisync doctor     # 本机体检 + 其他机器的报告（远程排障）
```

模型工具（**永远过确认门**，不受 `confirmLevel=auto` 影响）：
`omni_sync_status`（只读）· `omni_sync_push` · `omni_sync_pull`

## 加密与口令

敏感分区（凭据、`secrets/`、`.env`、MCP 内嵌 key、插件 token）在**镜像边界**上
被抽出来加密成 `secrets.enc.json`（scrypt(N=32768,r=8,p=1) + AES-256-GCM），
明文永远不进 git。MCP 的 key 藏在 URL/env 里，会被就地挖出、替换为占位符，
拉取时精确回填。

口令经环境变量 `OMNISYNC_PASSPHRASE` 注入（不落盘、不同步）。两台机器用同一个
口令。**口令丢失 = 云端密文作废，但本机明文仍在**，重新推送一次即可重建密文。

## 冲突裁决

用 **git 当合并引擎**：无冲突路径由 git 自己合并，只有 git 报冲突的路径才走
下面的分区策略。

| 分区类型 | 策略 |
|---|---|
| 凭据 | **记录级**三方合并（按过期时间取新 + 墓碑防复活 + 隔离区兜底） |
| `cordis.patch.yml` | 条目 `id` 级合并；端口等实例字段保本地 |
| JSON 配置 | key 级递归三方；数组按标量整体裁决（绝不 union 乱序） |
| 会话 / 其余 | 字节级 keep-both：本地保留 + 远端转 `.remote-fork-<时间戳>-<设备>` |

任何情况下**两边的字节都不会被静默丢弃**——要么合并，要么留冲突副本。

## 配置项（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `repo` | `''` | `owner/repo`；留空 = 不自动同步，等向导 |
| `intervalMinutes` | `15` | 定时同步（5..1440） |
| `startupDelaySeconds` | `30` | 启动后延迟首轮（错开启动拥塞） |
| `confirmLevel` | `'first-run'` | `auto` / `first-run` / `always`；**首次启用无论如何都确认** |
| `toolConfirm` | `true` | 模型工具触发时永远过确认门 |
| `secretGroups.*` | 全 `true` | 六类敏感内容的开关；关掉 = 只留本机，**绝不明文上传** |
| `syncSessions` / `syncAttachments` / `syncSkills` / `syncKeybindings` | `true` | 范围开关 |

---

## 开发

```bash
npm test                # 134 个测试（自动链依赖后运行）
npm run verify          # 真实 ~/.dsh 体检 + 端到端同步闭环（只读，不写你的数据）
npm run verify:install  # 源码 ↔ 已安装副本一致性 + 两半身份核对
```

**改完代码后务必跑 `npm run verify:install -- --live`**，它会检查三件事：

1. **文件一致性** —— pnpm 对 `file:` 依赖是逐文件硬链接（改动过的文件会变独立
   inode），且**不认新增文件**：新增文件需要 `remove` 再 `add` 才会带上。
2. **两半身份** —— 前端注册 ID / `exports.inject` / 宿主 `name` 是否与包名一致。
3. **运行时版本** —— 进程里跑的到底是哪个版本。

> ⚠️ **改了 `lib/**` 必须完整重启桌面端。** DSH 的热重载只重新导入插件入口
> （`index.mjs`），`lib/` 下的相对导入仍留在 ESM 缓存里 —— 于是"磁盘新版、
> 进程旧版"是常态，而且**重装无效**。`--live` 探针会明确告诉你这一点。

测试分三层，都**不靠自造桩**：
1. **纯函数**：三方合并三不变量、凭据记录级裁决、YAML 往返、加密往返、路径防御
2. **真实栈**：挂载官方 `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`
   三件套（与生产装配一致），验证状态读写、真落盘、跨重启保留
3. **真 git**：本地裸仓做双机端到端，逐字节比对 + `git grep` 扫明文泄漏

另有**守卫测试**把"真机才发现的坑"固化下来：
- 桩必须与真接口同形（`put` 而非 `set`）
- 状态 schema 必须覆盖 `emptyState()` 全部键（漏 `version` → 每次重启静默丢状态）
- 遍历必须剪枝重量级目录（29431 → 223 文件）
- `NEVER_SYNC` 每条都必须判为不同步
- **前端注册 ID 必须等于包名**（不一致 → 宿主回退重复注册 → 桌面启动失败）
- **`exports.inject` 必须覆盖 apply 实际用到的服务**（从源码推导，不写死字面量）

> 这些守卫的共同点：**从单一真相源推导，不写死与实现相同的字符串**。
> 早期版本曾把 bug 写进断言（`assert.equal(inject.join(','), '')`），
> 导致 89 个测试全绿却启动失败——详见 [事故报告](INCIDENT-启动失败修复报告.md)。

架构与设计依据见仓库外的调研报告（`research/`）：12 份预研、4700+ 行、全部带 `file:line` 取证。

## 许可

MIT
