import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { SCRIPT_CONFIG } from 'webgal-parser'

import { WEBGAL_ASSET_DIRECTORIES } from '@infrastructure/webgal/assetPath'
import { WebgalInfrastructureError } from '@infrastructure/webgal/WebgalInfrastructureError'

const require = createRequire(import.meta.url)

export const WEBGAL_COMPATIBILITY_PROFILE = {
  parserPackage: 'webgal-parser',
  enginePackage: 'webgal-engine',
  previewProtocol: 'webgal-editor-preview-sync.v1',
  previewProtocolRevision: 'cf73dd58535d3ef15bddf0852adee153fa92d7da',
  license: 'MPL-2.0',
  encoding: 'utf-8',
  entryScript: 'game/scene/start.txt',
  runtimeEntryFile: 'dist/index.html',
  previewPath: '/api/webgalsync',
  assetDirectories: WEBGAL_ASSET_DIRECTORIES,
  previewCommands: [
    'preview.command.sync-scene',
    'preview.command.run-scene-content',
    'preview.command.run-snippet',
    'preview.command.reload-templates',
    'preview.command.set-effect',
    'preview.command.set-component-visibility',
    'preview.command.set-font-optimization',
    'preview.command.set-text-read-mode'
  ]
} as const

/**
 * 返回锁定解析器声明可识别的脚本命令。
 * 运行时构建没有单独导出注册表，不能把这份名单当成“引擎已执行”。
 */
export function parserRecognizedCommands(): readonly string[] {
  return SCRIPT_CONFIG.map((item) => item.scriptString)
}

/**
 * 读取已安装包的版本。解析器版本跟随引擎，不在源码里写死。
 * @throws 版本缺失时抛出技术错误。
 */
export function installedPackageVersion(packageName: string): string {
  const manifest = require(`${packageName}/package.json`) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new WebgalInfrastructureError('incompatible-runtime', `无法读取 ${packageName} 的版本`)
  }
  return manifest.version
}

export interface WebgalRuntimeBuildEvidence {
  readonly packageVersion: string
  readonly engineVersion: string
  readonly license: string
  readonly entryFile: string
  readonly distFileCount: number
  readonly distBytes: number
  readonly distDigest: string
}

/**
 * 递归列出目录下的全部普通文件，用 `/` 统一分隔符，保证跨平台摘要稳定。
 * @param root - 计算相对路径的根目录。
 * @param current - 当前遍历目录，默认与根目录相同。
 * @returns 相对根目录的文件路径列表。
 * @throws 目录枚举失败时抛出底层文件系统错误。
 */
async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
  }
  return files
}

/**
 * 汇总 dist 目录内所有文件的路径与内容，生成稳定摘要和总字节数。
 * 路径也参与摘要，避免文件集合变化但内容相同时被误判为同一构建。
 * @param root - dist 根目录。
 * @param files - 相对根目录、需要纳入摘要的文件列表。
 * @throws 任一文件读取失败时抛出底层文件系统错误。
 */
async function digestDist(
  root: string,
  files: readonly string[]
): Promise<{ digest: string; bytes: number }> {
  const digest = createHash('sha256')
  let bytes = 0
  for (const relativePath of files) {
    const content = await readFile(join(root, relativePath))
    digest.update(relativePath)
    digest.update('\0')
    digest.update(content)
    digest.update('\0')
    bytes += content.byteLength
  }
  return { digest: digest.digest('hex'), bytes }
}

/**
 * @param engineRoot - `webgal-engine` 包根目录。
 * @throws 当包清单或 dist 不可读取时抛出技术错误。
 */
export async function inspectWebgalRuntimeBuild(
  engineRoot: string
): Promise<WebgalRuntimeBuildEvidence> {
  const packagePath = join(engineRoot, 'package.json')
  const manifestPath = join(engineRoot, 'dist', 'webgal-engine.json')
  const distRoot = join(engineRoot, 'dist')
  try {
    const packageDocument = JSON.parse(await readFile(packagePath, 'utf8')) as {
      version?: unknown
      license?: unknown
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      version?: unknown
      webgalVersion?: unknown
      license?: unknown
    }
    const entry = await stat(join(engineRoot, WEBGAL_COMPATIBILITY_PROFILE.runtimeEntryFile))
    if (!entry.isFile()) {
      throw new WebgalInfrastructureError(
        'incompatible-runtime',
        `运行时入口不是普通文件：${engineRoot}`,
        engineRoot
      )
    }
    const files = (await listFiles(distRoot)).sort()
    const digest = await digestDist(distRoot, files)
    return {
      packageVersion: String(packageDocument.version ?? ''),
      engineVersion: String(manifest.webgalVersion ?? manifest.version ?? ''),
      license: String(manifest.license ?? packageDocument.license ?? ''),
      entryFile: WEBGAL_COMPATIBILITY_PROFILE.runtimeEntryFile,
      distFileCount: files.length,
      distBytes: digest.bytes,
      distDigest: digest.digest
    }
  } catch (error) {
    if (error instanceof WebgalInfrastructureError) throw error
    throw new WebgalInfrastructureError(
      'incompatible-runtime',
      `无法读取 WebGAL 运行时构建：${engineRoot}`,
      engineRoot,
      {
        cause: error
      }
    )
  }
}

/**
 * 校验运行时构建与本轮固定兼容配置一致。
 * @param engineRoot - `webgal-engine` 包根目录。
 * @throws 版本、许可、入口或构建摘要不一致时抛出技术错误。
 */
export async function assertWebgalRuntimeCompatibility(
  engineRoot: string
): Promise<WebgalRuntimeBuildEvidence> {
  const engineVersion = installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.enginePackage)
  const parserVersion = installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.parserPackage)
  if (parserVersion !== engineVersion) {
    throw new WebgalInfrastructureError(
      'incompatible-runtime',
      `解析器版本 ${parserVersion} 与引擎版本 ${engineVersion} 不一致`
    )
  }
  const evidence = await inspectWebgalRuntimeBuild(engineRoot)
  if (evidence.packageVersion !== engineVersion || evidence.engineVersion !== engineVersion) {
    throw new WebgalInfrastructureError(
      'incompatible-runtime',
      `运行时构建版本 ${evidence.packageVersion} 与已安装引擎 ${engineVersion} 不一致`,
      engineRoot
    )
  }
  return evidence
}
