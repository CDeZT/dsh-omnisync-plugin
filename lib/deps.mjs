// lib/deps.mjs — 目标机依赖重建（走官方 pluginManager，不用 CLI）。
//
// 背景：desktop profile 禁止外部 CLI 改（bin.js 硬拦），但**装在 profile 里
// 的插件可以从内部调 ctx.pluginManager.installBundle()** —— 应用内「设置 →
// 插件」就是这条通道。
//
// 铁律：用**精确版本**（lockfile 里的），绝不用 @latest —— pnpm 的
// minimumReleaseAge 闸门会让 @latest 解析不到新版本，两台机器装出不同版本。

import { badConfig } from './errors.mjs'

/**
 * 对比 profile 依赖与已装清单，产出待装列表。
 * @param {string[]} wanted - package.json 的 dependencies 名。
 * @param {Map<string, string>} installed - 已装清单 name → version。
 * @param {Set<string>} exempt - 已知不可装/内置的包名（跳过）。
 * @returns {string[]} 待安装的 `name@version` 规格。
 */
export function planInstalls(wanted, installed, exempt = new Set()) {
  const specs = []
  for (const name of wanted) {
    if (exempt.has(name)) continue
    if (installed.has(name)) continue
    specs.push(name)
  }
  return specs
}

/**
 * 从 profile 的 package.json 读出依赖清单（name → spec）。
 * @param {object} manifest - package.json 解析结果。
 * @returns {Map<string, string>}
 */
export function dependenciesOf(manifest) {
  const deps = manifest?.dependencies ?? {}
  const out = new Map()
  for (const [name, spec] of Object.entries(deps)) out.set(name, String(spec))
  return out
}

/**
 * 执行重建（一串 installBundle，逐包 try，失败不中断）。
 * @param {object} deps - { manager: pluginManager 服务, logger, installed: () => Promise<Map> }。
 * @param {string[]} specs - `name@version` 或 `name`。
 * @returns {Promise<{installed: string[], failed: Array<{spec, code, message}>, restartRequired: boolean}>}
 */
export async function rebuild(deps, specs) {
  const installed = []
  const failed = []
  let restartRequired = false
  for (const spec of specs) {
    try {
      const result = await deps.manager.installBundle(spec)
      installed.push(spec)
      // 升级已存在的包会返回 restart-required（不崩，下次启动生效）。
      if (result?.application === 'restart-required' || result?.restartRequired === true) restartRequired = true
      if (Array.isArray(result?.pendingBuilds) && result.pendingBuilds.length > 0) {
        deps.logger?.warn?.(`${spec}: pending build approvals (native module)`)
      }
    } catch (error) {
      const code = error?.code ?? error?.kind ?? 'INSTALL_FAILED'
      failed.push({ spec, code: String(code), message: String(error?.message ?? error).slice(0, 400) })
      deps.logger?.warn?.(`installBundle(${spec}) failed: ${error?.message ?? error}`)
      // incompatible-version → 申请版本豁免后重试一次（不用 CLI）。
      if (String(code).includes('incompatible') && typeof deps.manager.setVersionExemption === 'function') {
        try {
          const [name, version] = spec.split('@').length > 2 ? [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)] : [spec, undefined]
          await deps.manager.setVersionExemption(`${name}@${version ?? ''}`, deps.runtimeVersion, true, true)
          await deps.manager.installBundle(spec)
          installed.push(spec)
          failed.pop()
          restartRequired = true
        } catch (retryError) {
          deps.logger?.warn?.(`exemption retry failed for ${spec}: ${retryError?.message ?? retryError}`)
        }
      }
    }
  }
  return { installed, failed, restartRequired }
}

/**
 * 从 profile manifest 重建依赖（读 package.json → 差值 → 逐包安装）。
 * 内部实现：对外只留 makeRebuildDeps 一个入口，避免同一条链路两个门。
 * @param {object} deps - { manager, readManifest: () => Promise<object>, logger }。
 * @returns {Promise<{installed: string[], failed: object[], restartRequired: boolean}>}
 */
async function rebuildProfile(deps) {
  const manifest = await deps.readManifest()
  const bundles = (await deps.manager.listBundles?.()) ?? []
  const installed = new Map(bundles.filter((b) => b.installed === true).map((b) => [b.name, b.version]))
  const wanted = [...dependenciesOf(manifest).keys()]
  return rebuild({ manager: deps.manager, logger: deps.logger, runtimeVersion: manifest.version }, planInstalls(wanted, installed))
}

/**
 * 路由 `/deps` 的入口：自己从宿主取 pluginManager（缺失 = 响亮失败，不静默跳过）。
 * @param {object} deps - { ctx, manifestPath, logger }。
 * @returns {() => Promise<object>}
 */
export function makeRebuildDeps(deps) {
  return async () => {
    const manager = deps.ctx.get?.('pluginManager')
    if (manager === undefined) throw badConfig('pluginManager unavailable')
    return rebuildProfile({
      manager,
      readManifest: async () => JSON.parse(await (await import('node:fs/promises')).readFile(deps.manifestPath, 'utf8')),
      logger: deps.logger,
    })
  }
}
