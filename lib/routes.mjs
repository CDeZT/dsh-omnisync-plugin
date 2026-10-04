// lib/routes.mjs — HTTP 路由（client 设置页的数据面）。
//
// 设计：路由只是「引擎 + 状态」的薄适配层 —— 不持有业务逻辑，全部转发。
// 这样 UI / 命令 / 模型工具三条入口的行为天然一致（单一真相源）。
//
// 回包统一 `{ok, data|error}`；错误按 code 分流（BAD_CONFIG → 400，其余 500）。

import { NAMESPACE, SECRET_GROUPS, CONFIRM_LEVELS, LIB_REV } from './constants.mjs'
import { badConfig, badInput } from './errors.mjs'
import { t } from './i18n.mjs'

const PREFIX = `/${NAMESPACE}/api/v1`

/**
 * 注册全部路由。
 * @param {object} ws - webServer 服务（需有 register）。
 * @param {object} api - { engine, state, repo: () => string, branch, cfg, runSync, writeToken, plugins }。
 */
/**
 * 把用户可能粘进来的各种写法归一成 `owner/name`。
 *
 * 为什么需要：用户看到"仓库"第一反应是**把浏览器地址栏粘进来**（`https://github.com/o/r`），
 * 而原先的正则只认 `owner/name` → 报 `repo must be owner/name`。那是最自然的操作却失败，
 * 属于把实现细节推给用户。这里把常见写法都收掉。
 * @param {string} input
 * @returns {string|null} 归一结果；无法识别时返回 null（调用方报错）。
 */
export function normalizeRepo(input) {
  let s = String(input ?? '').trim()
  if (s === '') return null
  // 两种带主机的写法要**分开**处理：
  //   `https://host/owner/name` —— 主机是首段，删掉后剩 2 段 ⇒ 删之前必须是 3 段；
  //   `git@host:owner/name`     —— 主机在**前缀**里，删掉后本就只剩 2 段。
  // 早先一律要求 3 段，把 `git@` 形态误判成非法（实测踩到）。
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(s)
  const hadScp = /^git@/iu.test(s)
  s = s.replace(/\.git$/iu, '').replace(/\/+$/u, '')
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '').replace(/^git@[^:]+:/iu, '')
  const parts = s.split('/').filter((x) => x !== '')
  if (hadScheme) {
    // `https://github.com/only-one` 只剩 2 段：若照收就成了 `github.com/only-one`
    // （把主机名当 owner）—— 必须拒。
    if (parts.length !== 3 || !/[.:]/u.test(parts[0])) return null
    parts.shift()
  } else if (!hadScp && parts.length === 3 && /[.:]/u.test(parts[0])) {
    parts.shift() // `github.com/owner/name`：省略 scheme 的写法
  }
  if (parts.length !== 2) return null
  return parts.every((x) => /^[A-Za-z0-9._-]+$/u.test(x)) ? parts.join('/') : null
}

export function registerRoutes(ws, api) {
  const send = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
  const readJson = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      // 请求体是调用方的问题 → BAD_INPUT（400），不能混进 500 让 UI 以为插件炸了。
      throw badInput('malformed JSON body')
    }
  }
  const route = (path, fn) => ws.register({
    kind: 'exact',
    path: PREFIX + path,
    handler: async (req, res) => {
      try {
        send(res, 200, { ok: true, data: await fn(req, res) })
      } catch (error) {
        // 入参问题 → 400；其余（含未知码）→ 500，绝不把调用方的错报成插件故障。
        const clientFault = error?.code === 'BAD_CONFIG' || error?.code === 'BAD_INPUT'
        send(res, clientFault ? 400 : 500, {
          ok: false, error: { code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error) },
        })
      }
    },
  })
  /** POST-only 包装：自动读 body。 */
  const post = (fn) => async (req) => {
    if (req.method !== 'POST') throw badConfig('POST only')
    return fn(await readJson(req))
  }

  route('/status', async () => {
    const s = await api.state()
    return {
      libRev: LIB_REV,
      state: api.engine.state,
      deviceId: s.deviceId,
      repo: api.repo(),
      branch: api.cfg.branch,
      lastSyncedAt: s.lastSyncedAt,
      lastError: s.lastError,
      backoffUntil: s.backoffUntil,
      history: s.history?.slice(-10) ?? [],
      secrets: api.cfg.secretGroups,
      confirmLevel: api.cfg.confirmLevel,
      // 用可选调用：api 少给一个方法时退化为默认值，而不是整条路由 500
      // （真实事故：index 漏了 passphraseFromEnv → status 路由静默缺字段）。
      passphraseConfigured: api.passphraseConfigured?.() ?? false,
      passphraseFromEnv: api.passphraseFromEnv?.() ?? false,
    }
  })

  route('/messages', async () => (await import('./i18n.mjs')).allMessages())

  // 分区开关：列出全部分区 + 当前开关状态；POST 保存。
  // 分区开关：GET 读、POST 写。
  // ★ 必须传**函数**给 route()（它签名是 (path, fn)，内部 `await fn(req,res)` 并自己
  //   组装 {ok,data} 响应）。我第一版传了对象 `{ handler }` → 每次请求都
  //   `fn is not a function` → 500；而且我在里面又 send 了一次，会与包装器重复发送。
  route('/sections', async (req) => {
    if (req.method !== 'POST') return api.sections()
    const body = await readJson(req)
    if (!Array.isArray(body.disabled)) throw badConfig('disabled must be an array')
    await api.setDisabledSections(body.disabled)
    return api.sections()
  })

  // 口令：写本机 0600 文件（该文件在 NEVER_SYNC 里，绝不上云）。空串 = 清除。
  route('/passphrase', post(async ({ passphrase: value }) => {
    if (typeof value !== 'string') throw badConfig('passphrase must be a string')
    await api.savePassphrase(value.trim())
    return { configured: api.passphraseConfigured(), length: value.trim().length }
  }))

  route('/sync', post(async ({ mode }) => {
    const wanted = ['pull', 'push'].includes(mode) ? mode : 'sync'
    const report = await api.runSync(wanted, 'ui')
    return {
      mode: wanted, pushed: report.pushed ?? 0, pulled: report.pulled ?? 0,
      conflicts: report.conflicts ?? [], error: report.error ?? null, cancelled: report.cancelled === true,
    }
  }))

  route('/token', post(async ({ token, repo }) => {
    if (typeof token !== 'string' || token.trim() === '') throw badConfig('token required')
    if (typeof repo === 'string' && repo.trim() !== '') {
      const normalized = normalizeRepo(repo)
      if (normalized === null) throw badConfig('repo must be owner/name（也可以直接粘 GitHub 页面地址）')
      api.setRepo(normalized)
    }
    // 先落盘 token，再用 bootstrap 验通；失败会抛出（UI 据错误码提示）。
    await api.writeToken(token.trim())
    await api.verify()
    await api.remember({ repo: api.repo() })
    return { verified: true, repo: api.repo() }
  }))

  route('/secrets', post(async ({ group, enabled }) => {
    if (!Object.values(SECRET_GROUPS).includes(group)) throw badConfig('unknown secret group')
    const groups = await api.remember({ secretGroups: { [group]: enabled === true } })
    return { secretGroups: groups }
  }))

  route('/confirm-level', post(async ({ level }) => {
    if (!Object.values(CONFIRM_LEVELS).includes(level)) throw badConfig('unknown confirm level')
    await api.remember({ confirmLevel: level })
    return { confirmLevel: api.cfg.confirmLevel }
  }))

  route('/deps', post(async () => {
    const result = await api.rebuildDeps()
    return { ...result, restartHint: result.restartRequired ? t('deps.restart') : null }
  }))
}

/**
 * 挂载 HTTP 路由。webServer 是可选服务（缺席时静默跳过，插件照常可用）。
 * @param {object} ctx - 宿主上下文。
 * @param {object} api - 见 registerRoutes。
 */
export function mountRoutes(ctx, api) {
  ctx.inject?.(['webServer'], (hostCtx) => {
    const ws = hostCtx.get?.('webServer') ?? hostCtx.webServer
    if (typeof ws?.register !== 'function') return
    registerRoutes(ws, api)
  })
}
