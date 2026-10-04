// client.js — Omnisync 设置页面板（零构建懒加载 CJS，纯 React.createElement）。
//
// 挂载方式与 dshmarket 同款（desktop 已验证可用）：
//   window.__ModuleLoader__.load({id, factory})
//   ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))
// 数据面全部走 host 的 HTTP 路由（`/omnisync/api/v1/*`）——client 不直接碰 fs。
//
// 边界：本文件只管渲染与 fetch；一切决策（合并/写盘/确认）在 host 侧。
// CSS 用宿主主题变量自绘（--dsw-alias-*），不引组件库、不打包。

window.__ModuleLoader__.load({
  id: '@cdezt/dsh-omnisync',
  factory: function (require) {
    'use strict'
    // 懒 CJS：factory 内自建 module/exports（宿主只提供 require）。
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = '/omnisync/api/v1'

    /** 统一 fetch（JSON 信封 {ok, data|error}）。 */
    function call(path, body) {
      var opt = body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      return fetch(API + path, opt).then(function (r) { return r.json().catch(function () { return { ok: false, error: { code: 'BAD_JSON', message: 'invalid response' } } }) })
    }

    function useStatus(pollMs) {
      var [state, setState] = React.useState({ loading: true })
      React.useEffect(function () {
        var alive = true
        var load = function () {
          call('/status').then(function (res) { if (alive) setState(res.ok ? { data: res.data, loading: false } : { error: res.error, loading: false }) })
            .catch(function (e) { if (alive) setState({ error: { code: 'NETWORK', message: String(e && e.message || e) }, loading: false }) })
        }
        load()
        var timer = setInterval(load, pollMs || 30000)
        return function () { alive = false; clearInterval(timer) }
      }, [])
      return [state, setState]
    }

    var S = {
      card: { border: '1px solid var(--dsw-alias-border, #d0d7de)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
      row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '4px 0' },
      label: { opacity: 0.75, fontSize: 13 },
      val: { fontVariantNumeric: 'tabular-nums', fontSize: 13 },
      btn: { padding: '5px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border, #d0d7de)', background: 'transparent', cursor: 'pointer', fontSize: 13 },
      btnPrimary: { padding: '5px 12px', borderRadius: 6, border: '1px solid transparent', background: 'var(--dsw-alias-accent, #0969da)', color: '#fff', cursor: 'pointer', fontSize: 13 },
      input: { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border, #d0d7de)', background: 'transparent', color: 'inherit', fontSize: 13 },
      bad: { color: 'var(--dsw-alias-danger, #cf222e)' }, good: { color: 'var(--dsw-alias-success, #1a7f37)' }, warn: { color: 'var(--dsw-alias-warning, #9a6700)' },
      // 同一形态出现 5+ 次的版式，收进表里（改一处即全局一致）。
      btnRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      grid: { display: 'grid', gap: 8, margin: '0 0 12px 28px' },
      stepOff: { margin: '0 0 12px 28px' },
      stepDot: { width: 20, height: 20, borderRadius: 10, fontSize: 12, lineHeight: '20px', textAlign: 'center' },
    }

    // 面板中文为主；英文由 host 的 i18n 表提供（client 不内置第二份）。
    var t = function (zh) { return zh }

    function cardTitle(text, mb) { return h('div', { style: { fontWeight: 600, marginBottom: mb === undefined ? 4 : mb } }, text) }
    function cardHint(text) { return h('div', Object.assign({}, S.label, { marginBottom: 8 }), text) }
    /** 卡片外壳：标题 + 说明 + 内容（同一形态 5 次，收成一处免得各自漂移）。 */
    function card(title, hint) { return h('div', { style: S.card }, cardTitle(title), hint === null ? null : cardHint(hint), [].slice.call(arguments, 2)) }

    /** 状态色：idle=正常，error=红，退避中=黄。 */
    function stateColor(d) {
      if (d === undefined) return S.label
      return d.state === 'error' ? S.bad : (d.backoffUntil > Date.now() ? S.warn : S.good)
    }

    function Row(props) {
      return h('div', { style: S.row }, h('span', { style: S.label }, props.label), h('span', Object.assign({ style: S.val }, props.valueStyle), props.value))
    }

    function Panel() {
      var [st, setSt] = useStatus(30000)
      var [busy, setBusy] = React.useState(false)
      var [msg, setMsg] = React.useState(null)
      var d = st.data

      var act = function (fn) {
        setBusy(true); setMsg(null)
        Promise.resolve(fn()).then(function (r) {
          setMsg(r && r.ok === false ? { bad: true, text: (r.error && r.error.message) || 'failed' } : { bad: false, text: t('完成') })
          return call('/status')
        }).then(function (res) { if (res && res.ok) setSt({ data: res.data, loading: false }) })
          .catch(function (e) { setMsg({ bad: true, text: String(e && e.message || e) }) })
          .then(function () { setBusy(false) })
      }

      var head = h('div', { style: { marginBottom: 10 } },
        h('div', { style: { fontWeight: 600, fontSize: 15 } }, t('Omnisync 全量云同步')),
        h('div', { style: Object.assign({}, S.label, { marginTop: 2 }) }, t('把本机 DSH 的全部状态同步到 GitHub 私有仓库 —— 换台电脑就是同一个桌面端')))

      // 反馈条：act() 会写 msg，此前它从未被渲染 —— 点按钮没有任何回显。
      var banner = msg === null ? null : h('div', {
        style: {
          marginBottom: 10, padding: '6px 10px', borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: msg.bad ? 'rgba(207,34,46,.12)' : 'rgba(26,127,55,.12)', color: msg.bad ? '#cf222e' : '#1a7f37',
        },
      }, msg.text)

      if (st.loading) return h('div', { style: { padding: 12 } }, head, h('div', { style: S.label }, t('读取中…')))

      if (st.error !== undefined) {
        return h('div', { style: { padding: 12 } }, head, banner,
          h('div', { style: S.card },
            h('div', { style: S.bad }, t('无法读取同步状态：') + st.error.message),
            h('div', Object.assign({}, S.label, { marginTop: 6 }), t('host 侧插件可能未启用或路由未挂载。'))))
      }

      var configured = d.repo !== ''
      var scope = [
        ['providerKeys', t('模型 Provider Key')],
        ['mcpEnv', t('MCP 服务的 env / URL 内嵌 Key')],
        ['oauthGrants', t('OAuth 登录凭证（按过期时间取新）')],
        ['pluginTokens', t('插件 Token（market / jet-hub 等）')],
        ['secretsDir', t('secrets/ 技能密钥目录')],
        ['homeEnv', t('家级 .env')],
      ]
      var levels = [
        ['first-run', t('首次确认一次，之后自动')],
        ['always', t('每次写本机都问我')],
        ['auto', t('全自动（首次仍会确认一次）')],
      ]

      return h('div', { style: { padding: 12 } }, head, banner,

        // ① 状态卡
        h('div', { style: S.card },
          h(Row, { label: t('状态'), value: d.state, valueStyle: stateColor(d) }),
          h(Row, { label: t('设备'), value: d.deviceId || '—' }),
          h(Row, { label: t('云端仓库'), value: configured ? d.repo + ' (' + d.branch + ')' : t('未配置') }),
          h(Row, { label: t('最近同步'), value: d.lastSyncedAt ? new Date(d.lastSyncedAt).toLocaleString() : t('从未') }),
          h(Row, { label: t('加密'), value: d.passphraseConfigured ? t('已启用') : t('未设置（秘密只留本机）'), valueStyle: d.passphraseConfigured ? S.good : S.warn }),
          d.lastError ? h(Row, { label: t('最近错误'), value: d.lastError.code, valueStyle: S.bad }) : null,
          h('div', { style: Object.assign({ marginTop: 10 }, S.btnRow) },
            h('button', { style: S.btnPrimary, disabled: busy || !configured, onClick: function () { act(function () { return call('/sync', { mode: 'sync' }) }) } }, t('立即同步')),
            h('button', { style: S.btn, disabled: busy || !configured, onClick: function () { act(function () { return call('/sync', { mode: 'push' }) }) } }, t('只推送')),
            h('button', { style: S.btn, disabled: busy || !configured, onClick: function () { act(function () { return call('/sync', { mode: 'pull' }) }) } }, t('只拉取预览')))),

        // ② 三步引导向导
        h(Wizard, { data: d, busy: busy, act: act }),

        // ③ 同步范围（逐分区）
        h(Sections, {}),

        // ④ 敏感项分组开关
        card(t('同步哪些敏感内容'), t('默认全部开启；关闭的分组只留本机、绝不明文上传'),
          scope.map(function (pair) {
            var key = pair[0]
            return h('label', { key: key, style: Object.assign({}, S.row, { cursor: 'pointer' }) },
              h('span', { style: S.val }, pair[1]),
              h('input', {
                type: 'checkbox', checked: d.secrets ? d.secrets[key] !== false : true, disabled: busy,
                onChange: function (e) { var v = e.target.checked; act(function () { return call('/secrets', { group: key, enabled: v }) }) },
              }))
          })),

        // ⑤ 确认级别
        card(t('自动化程度'), null,
          h('div', { style: S.btnRow },
            levels.map(function (pair) {
              return h('button', { key: pair[0], style: d.confirmLevel === pair[0] ? S.btnPrimary : S.btn, disabled: busy,
                onClick: function () { act(function () { return call('/confirm-level', { level: pair[0] }) }) } }, pair[1])
            }))),

        // ⑥ 依赖重建（换机后补齐插件依赖）
        card(t('插件依赖'), t('新机器上按云端清单补齐缺失的插件包（走官方安装通道，安装后需重启 DSH 生效）'),
          busy ? h('div', { style: S.label }, t('安装中…（可能需要几分钟）'))
            : h('button', { style: S.btn, onClick: function () { act(function () { return call('/deps', {}) }) } }, t('检查并补齐依赖'))),

        // ⑦ 历史
        (d.history && d.history.length > 0) ? card(t('最近同步记录'), null,
          d.history.slice(-6).reverse().map(function (entry, i) {
            return h(Row, {
              key: i,
              label: new Date(entry.at || Date.now()).toLocaleTimeString(),
              value: (entry.trigger || '') + ' · +' + (entry.pushed || 0) + ' / -' + (entry.pulled || 0) + (entry.error ? ' · ' + entry.error : ''),
              valueStyle: entry.error ? S.bad : S.val,
            })
          })) : null)
    }

    /**
     * 三步引导向导：① 连接仓库 ② 设置口令 ③ 首次同步方向。
     * 步骤状态由 /status 推导（已配置仓库/口令/是否首次），刷新后自动续上。
     */
    function Wizard(props) {
      var d = props.data
      var busy = props.busy
      var act = props.act
      var [token, setToken] = React.useState('')
      var [repo, setRepo] = React.useState(d.repo || '')
      var [pw, setPw] = React.useState('')
      var step = d.repo === '' ? 1 : (d.passphraseConfigured ? 3 : 2)

      var head = function (n, title) {
        var active = step === n
        var done = step > n
        var dot = Object.assign({}, S.stepDot, {
          background: done ? 'var(--dsw-alias-success,#1a7f37)' : active ? 'var(--dsw-alias-accent,#0969da)' : 'transparent',
          border: done || active ? '1px solid transparent' : '1px solid var(--dsw-alias-border,#d0d7de)',
          color: done || active ? '#fff' : 'inherit',
        })
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('span', { style: dot }, done ? '\u2713' : String(n)),
          h('span', { style: { fontWeight: active ? 600 : 400, opacity: active ? 1 : 0.7 } }, title))
      }
      var summary = function (text) { return h('div', { style: Object.assign({}, S.label, S.stepOff) }, text) }

      return card(t('连接云端仓库'), null,
        // ① 仓库 + PAT
        head(1, t('生成令牌并填入仓库')),
        step === 1 ? h('div', { style: S.grid },
          h('a', { target: '_blank', rel: 'noreferrer', style: S.label,
            href: 'https://github.com/settings/personal-access-tokens/new?name=dsh-omnisync&description=DSH%20full-state%20sync&expires_in=366' },
          t('→ 打开 GitHub 预填页面（只勾这一个仓库的 Contents 读写）')),
          h('input', { style: S.input, type: 'password', placeholder: t('粘贴令牌（只存本机 0600，绝不上云）'), value: token, onChange: function (e) { setToken(e.target.value) } }),
          h('input', { style: S.input, placeholder: t('仓库 owner/repo'), value: repo, onChange: function (e) { setRepo(e.target.value) } }),
          h('button', { style: S.btnPrimary, disabled: busy || token.trim() === '' || repo.trim() === '',
            onClick: function () { act(function () { return call('/token', { token: token.trim(), repo: repo.trim() }) }) } }, t('验证并保存')),
          h('div', Object.assign({}, S.label, { marginTop: 4, opacity: 0.75 }), t('或者：不用 GitHub，把网盘里的裸仓路径填到插件设置 folderRemote（iCloud/Dropbox/共享盘）—— 网盘客户端负责跨机复制该目录。')))
          : summary(d.repo),

        // ② 口令
        head(2, t('设置加密口令（两台机器必须一致）')),
        step === 2 ? h('div', { style: S.grid },
          h('div', { style: S.label }, t('用于加密凭据与密钥。丢了不致命：云端密文作废，但本机明文还在，重新推送即可重建。')),
          h('input', { style: S.input, type: 'password', placeholder: t('口令（建议 16 位以上）'), value: pw, onChange: function (e) { setPw(e.target.value) } }),
          h('button', { style: S.btnPrimary, disabled: busy || pw.trim().length < 8,
            onClick: function () { act(function () { return call('/passphrase', { passphrase: pw.trim() }) }) } }, t('保存口令')))
          : summary(d.passphraseConfigured ? (d.passphraseFromEnv ? t('已由环境变量提供') : t('已保存到本机 0600 文件')) : t('未设置')),

        // ③ 首次同步方向
        head(3, t('首次同步')),
        step === 3 ? h('div', { style: { margin: '0 0 4px 28px' } },
          h('div', Object.assign({}, S.label, { marginBottom: 8 }), t('第一台机器选「推送」（把本机铺上云）；新机器选「拉取」（把云落到本机）。')),
          h('div', { style: S.btnRow },
            h('button', { style: S.btnPrimary, disabled: busy, onClick: function () { act(function () { return call('/sync', { mode: 'push' }) }) } }, t('我是第一台，推送')),
            h('button', { style: S.btn, disabled: busy, onClick: function () { act(function () { return call('/sync', { mode: 'pull' }) }) } }, t('我是新机器，拉取'))))
          : summary(d.lastSyncedAt ? t('已完成首次同步') : t('等待首次同步')))
    }

    /**
     * 同步范围：逐分区开关。列表由宿主按注册表下发（新增分区自动出现），
     * 所以这里不需要硬编码任何分区名。
     */
    function Sections() {
      var [list, setList] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      React.useEffect(function () {
        call('/sections').then(function (r) { if (r && r.ok) setList(r.data) })
      }, [])
      if (list === null) return null

      var offIds = function (rows) { return rows.filter(function (s) { return s.enabled === false }).map(function (s) { return s.id }) }
      var toggle = function (id) {
        var next = list.map(function (s) { return s.id === id ? Object.assign({}, s, { enabled: !s.enabled }) : s })
        setBusy(true)
        call('/sections', { disabled: offIds(next) }).then(function (r) {
          if (r && r.ok) setList(r.data)
          setBusy(false)
        }).catch(function () { setBusy(false) })
      }

      var off = offIds(list).length
      return card(t('同步范围'), off === 0 ? t('全部 ' + list.length + ' 个分区都在同步') : t('已关闭 ' + off + ' / ' + list.length + ' 个分区'),
        h('div', { style: { display: 'grid', gap: 4 } },
          list.map(function (sec) {
            return h('label', { key: sec.id, title: sec.note || '', style: Object.assign({}, S.row, { cursor: busy ? 'default' : 'pointer' }) },
              h('span', { style: S.label },
                h('input', { type: 'checkbox', checked: sec.enabled !== false, disabled: busy, onChange: function () { toggle(sec.id) }, style: { marginRight: 6 } }),
                sec.id,
                sec.secretGroup ? h('span', { style: { opacity: 0.6 } }, ' \u00b7 ' + t('加密')) : null),
              h('span', { style: Object.assign({}, S.val, { opacity: 0.6, fontSize: 11 }) }, sec.note || ''))
          })))
    }

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined || slots === null) return
      // 文案表由 host 提供（单一来源，client 不内置第二份）。
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(function () { return ctx.locale.register('omnisync', { zh: { nav: 'Omnisync 全量同步' }, en: { nav: 'Omnisync' } }) }, 'omnisync: locale')
      }
      slots.inject('settings.section', function () {
        return slots.register({ name: 'settings.section', id: 'dsh-omnisync', order: 55, label: function () { return t('Omnisync 全量同步') } },
          function () { return h(Panel) })
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
