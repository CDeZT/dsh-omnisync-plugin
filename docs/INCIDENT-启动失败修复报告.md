# 启动失败事故报告与修复（2026-10-04）

> 症状：DeepSeek Harness Desktop 启动失败，`web boot: 1 entry did not activate`
> 定级：**我的 bug**（前端入口两处错误），且**我的测试把 bug 写进了断言**
> 现状：已修复并在真实桌面端验证通过（无需重启即生效）

---

## 一、事故链（日志实证）

| 时间 | 日志 | 含义 |
|---|---|---|
| 12:10 | `client-modules: duplicate factory registration for "dsh-omnisync" (bundle executed twice without invalidate?)` | 注册 ID 与包名不符 → 宿主按包名找不到 → 回退加载 → 同一 bundle 执行两次 |
| 12:10 | `@cdezt/dsh-omnisync: import failed` | 上一步的必然后果 |
| 12:15 | `@cdezt/dsh-omnisync: failed` | ID 已修，但 `exports.inject = []` 而 apply 用了 `slots`/`locale` → 初始化失败 |
| 之后 | 无新崩溃日志 | 修复生效 |

**两个 bug 的根因**：

1. **前端模块注册 ID 必须等于包名（含 `@scope`）**。`client-modules` 按包名索引 bundle；ID 不符会让宿主走回退路径重复执行同一脚本。
2. **`exports.inject` 必须声明 apply 用到的宿主服务**，宿主才会等依赖就绪后再初始化。

## 二、更严重的问题：测试锁死了错误实现

我原来的契约测试写的是：

```js
assert.equal(Array.from(out.inject).join(','), '')   // ← 断言"inject 是空的"
```

这不是"没测到"，而是**测试主动把 bug 固化了**——它断言了错误行为，所以 89 个测试全绿时我毫无察觉。
模块 ID 那条也一样：测试和实现**写死了同一个错字符串** `'dsh-omnisync'`，两边一起错。

## 三、修复

### 代码
```js
window.__ModuleLoader__.load({ id: '@cdezt/dsh-omnisync', ... })   // 与 package.json name 一致
exports.inject = ['slots', 'locale']                                // 声明 apply 用到的服务
```
（设置面板的 `id: 'dsh-omnisync'` 是 UI 标识，保留不动。）

### 测试（这次是真正的修法）

| 守卫 | 做法 | 能防什么 |
|---|---|---|
| **服务依赖从源码推导** | 正则扫出 apply 里 `ctx.get('X')` / `ctx.X` 实际用到的服务，断言 `inject` 覆盖它们 | 测试与实现同时写错的整类问题 |
| **ID 与包名一致性** | 读 `package.json` 的 `name` 比对，不写死字符串 | 同上 |
| **注册只出现一次** | 剥掉注释后数 `__ModuleLoader__.load(` | 重复注册导致整个 web boot 失败 |
| **两半身份一致** | 宿主导出 `name`、patch 的 specifier、前端注册 ID 三者都等于包名 | 跨半边的身份漂移 |
| **宿主 inject 覆盖** | 同第一行做法，对 `index.mjs` 也做一遍 | 宿主侧同类误用 |

**验证守卫真的有效**：临时把 `exports.inject` 改回 `[]`，测试立刻失败并直指
`apply 用了 ctx.locale 但 exports.inject 未声明 → 宿主不会等它就绪（启动会失败）`。

## 四、顺手消除同类隐患

参考实现（dshmarket / dsh-better-sidebar / dsh-mcp-panel）**都不导出宿主 `name`**，
而我导出了短名 `dsh-omnisync`。查证：`entry.options.name`（patch 的 specifier）才是
plugin-manager 的匹配依据，导出的 `name` 仅用于 cordis 诊断标签——所以这不是 bug，
但两半用同一个身份能消除一整类困惑。已改为 `export const name = PACKAGE_NAME`。

## 五、新增两个可执行检查（把你提的第 5、6 点固化）

```bash
npm run verify:install   # 源码 ↔ 已安装副本一致性 + 两半身份核对
npm run verify           # 真实 ~/.dsh 体检 + 端到端同步闭环
```

`verify:install` 实测发现的两个真问题（已修）：
- `package.json` 的 `files` 声明了 `LICENSE` 和 `types.d.ts`，**两个文件都不存在** → 已补齐
- `client.js` 与源码不一致 → 已重装对齐

**关于硬链接**：实测 pnpm 对 `file:` 依赖是**逐文件**处理的——未改动的文件保持硬链接
（源码改动即时生效），改动过的文件会被重新拷贝成独立 inode。所以"是否同步"不能靠假设，
必须用 `verify:install` 验。另外 **pnpm 不认 `file:` 依赖的新增文件**（`added 0`），
必须 `remove` + `add` 才能带上新文件。

## 六、验证结果（真实桌面端）

```
$ curl /omnisync/api/v1/status
{"ok":true,"data":{"state":"idle","deviceId":"5fc734cb","repo":"","branch":"main",
 "lastSyncedAt":0,"lastError":null,"secrets":{六个分组全开},"confirmLevel":"first-run"}}
```

| 项 | 结果 |
|---|---|
| 路由响应 | ✅ `ok:true`（不再是 500） |
| 设备 ID | ✅ `5fc734cb` 三次读取稳定（状态层工作） |
| 真实落盘 | ✅ `~/.dsh/storages/omnisync.json` 存在，`version: 1` **保住了**（我的修复生效） |
| 命令/面板路由 | ✅ `/messages` 200 |
| 新崩溃日志 | ✅ 无（最新仍是 12:15） |
| 测试 | ✅ **134/134** |

**并且不需要重启**：`remove` + `add` 会重新导入模块，所以修复当场生效。
（这也修正了我上一份报告的结论——不是"必须重启"，而是"必须让宿主重新导入模块"，
`remove`+`add` 就能做到。）

## 七、教训（写进流程）

1. **测试不能写死与实现相同的字面量** —— 该从单一真相源（`package.json`）推导，或从源码推导。
2. **契约测试要覆盖"声明"，不只是"形状"** —— 能导出 `apply` 不代表依赖声明正确。
3. **单元测试全绿 ≠ 能启动** —— 前端入口的正确性只有真机重启才能确认。
4. **改完必须验安装副本** —— 硬链接状态逐文件不同，且新增文件不会被 pnpm 带上。
5. **排查先看最近一次日志** —— `~/Library/Logs/DeepSeek Harness/crash-*-web-boot.log`
   的 `renderer console` 段直接给出了 `duplicate factory registration` 这条关键线索。
