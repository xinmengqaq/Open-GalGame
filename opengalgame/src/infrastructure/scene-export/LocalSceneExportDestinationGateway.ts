import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'
import type { SceneExportDestinationDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type {
  SceneExportDestination,
  SceneExportDestinationGateway
} from '@application/scene-export/ports/SceneExportDestinationGateway'
import type { SceneExportDirectoryChoiceVO } from '@application/scene-export/vo/SceneExportDestinationVO'
import { AppException } from '@common/errors/AppException'
import {
  SceneExportErrorCodes,
  sceneExportErrorMessages
} from '@domain/scene-export/errors/SceneExportErrorCodes'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'

import { EXPORT_STAGING_PREFIX } from './exportDestinationPaths'

const SELECTION_TTL_MS = 10 * 60 * 1000
const MAX_SELECTIONS = 8

type SceneLocationResolver = (scene: SceneIdentity) => Promise<{
  readonly projectRoot: string
}>

interface DirectorySelection {
  readonly projectId: string
  readonly sceneId: string
  readonly parentDirectory: string
  readonly expiresAtMs: number
}

export interface LocalSceneExportDestinationGatewayOptions {
  readonly userDirectory: string
  /** 主进程系统目录选择器；取消返回 null。 */
  readonly chooseDirectory: () => Promise<string | null>
  /** 应用安装、资源或状态目录；不得作为导出父目录。 */
  readonly protectedRoots?: readonly string[]
  /** 测试注入；默认从已登记工程解析当前场景根。 */
  readonly resolveScene?: SceneLocationResolver
  readonly now?: () => number
}

/**
 * 主进程侧的导出目的地解析。
 * 默认位置固定为 `<工程根>/exports`；显式选择只登记父目录并签发 selectionId，
 * 路径不回传表现层，随后由导出请求以 selectionId 兑现。
 */
export class LocalSceneExportDestinationGateway implements SceneExportDestinationGateway {
  private readonly selections = new Map<string, DirectorySelection>()
  private readonly resolveScene: SceneLocationResolver
  private readonly now: () => number

  constructor(private readonly options: LocalSceneExportDestinationGatewayOptions) {
    this.resolveScene =
      options.resolveScene ??
      ((scene) =>
        new RegisteredSceneLocationGatewayImpl(options.userDirectory).resolveRegisteredScene(
          scene
        ))
    this.now = options.now ?? Date.now
  }

  async chooseParentDirectory(scene: SceneIdentity): Promise<SceneExportDirectoryChoiceVO> {
    const location = await this.resolveScene(scene)
    const picked = await this.options.chooseDirectory()
    if (picked === null) return { status: 'canceled' }
    const parentDirectory = await validateParentDirectory(
      picked,
      location.projectRoot,
      this.options.userDirectory,
      this.options.protectedRoots ?? []
    )
    const selectionId = randomUUID()
    this.prune()
    this.selections.set(selectionId, {
      projectId: scene.projectId,
      sceneId: scene.sceneId,
      parentDirectory,
      expiresAtMs: this.now() + SELECTION_TTL_MS
    })
    return { status: 'selected', selectionId, directoryPath: parentDirectory }
  }

  async resolveDestination(
    scene: SceneIdentity,
    intent: SceneExportDestinationDTO | undefined
  ): Promise<SceneExportDestination> {
    const location = await this.resolveScene(scene)
    if (intent === undefined || intent.kind === 'workspace') {
      const parentDirectory = await this.ensureWorkspaceExports(
        location.projectRoot,
        this.options.userDirectory,
        this.options.protectedRoots ?? []
      )
      return { kind: 'workspace', parentDirectory, projectRoot: location.projectRoot }
    }
    const selection = this.selections.get(intent.selectionId)
    if (
      !selection ||
      selection.expiresAtMs <= this.now() ||
      selection.projectId !== scene.projectId ||
      selection.sceneId !== scene.sceneId
    ) {
      throw destinationError(
        SceneExportErrorCodes.destinationRejected,
        '所选导出位置已失效，请重新选择'
      )
    }
    return {
      kind: 'selected',
      parentDirectory: selection.parentDirectory,
      projectRoot: location.projectRoot
    }
  }

  /** 只清理过期登记，不触碰任何目录。 */
  private prune(): void {
    const now = this.now()
    for (const [selectionId, selection] of this.selections) {
      if (selection.expiresAtMs <= now) this.selections.delete(selectionId)
    }
    while (this.selections.size >= MAX_SELECTIONS) {
      const oldest = this.selections.keys().next().value
      if (oldest === undefined) break
      this.selections.delete(oldest)
    }
  }

  private async ensureWorkspaceExports(
    projectRoot: string,
    userDirectory: string,
    protectedRoots: readonly string[]
  ): Promise<string> {
    const exportsDirectory = path.join(projectRoot, 'exports')
    let existing: Stats | null = null
    try {
      existing = await lstat(exportsDirectory)
    } catch (error) {
      if (!isMissing(error)) throw destinationError(SceneExportErrorCodes.destinationRejected)
    }
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw destinationError(
        SceneExportErrorCodes.destinationRejected,
        '工程导出目录不可用，请检查工程文件'
      )
    }
    if (!existing) {
      try {
        await mkdir(exportsDirectory, { recursive: true })
      } catch {
        throw destinationError(
          SceneExportErrorCodes.destinationRejected,
          '无法创建工程导出目录，请检查工程文件权限'
        )
      }
    }
    return validateParentDirectory(
      exportsDirectory,
      projectRoot,
      userDirectory,
      protectedRoots,
      { allowProjectRootChild: true }
    )
  }
}

/**
 * 校验用户选中的父目录：必须存在、是普通目录、不是链接，且不在工程权威子树、
 * 用户状态或应用安装/资源目录内。只读或权限不足在打包前以可操作错误拒绝。
 * @returns 解析后的真实目录。
 */
export async function validateParentDirectory(
  candidate: string,
  projectRoot: string,
  userDirectory: string,
  protectedRoots: readonly string[],
  options: { readonly allowProjectRootChild?: boolean } = {}
): Promise<string> {
  if (!path.isAbsolute(candidate)) throw destinationError()
  let info: Stats
  try {
    info = await lstat(candidate)
  } catch {
    throw destinationError(
      SceneExportErrorCodes.destinationRejected,
      options.allowProjectRootChild
        ? '工程导出目录不存在，请检查工程文件'
        : '所选文件夹不可用，请重新选择'
    )
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw destinationError(
      SceneExportErrorCodes.destinationRejected,
      '所选位置不是普通文件夹，请重新选择'
    )
  }
  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch {
    throw destinationError()
  }
  const forbidden = [
    path.join(projectRoot, 'game'),
    path.join(projectRoot, 'assets'),
    path.join(projectRoot, '.opengalgame'),
    path.join(projectRoot, '.git'),
    userDirectory,
    ...protectedRoots
  ]
  for (const root of forbidden) {
    if (root.trim() === '') continue
    const resolvedRoot = await realpath(root).catch(() => path.resolve(root))
    if (inside(resolvedRoot, resolved)) {
      throw destinationError(
        SceneExportErrorCodes.destinationRejected,
        '这个位置属于工程或应用数据，不能作为导出位置'
      )
    }
  }
  const staging = path.join(resolved, EXPORT_STAGING_PREFIX)
  if (staging.length >= 240) {
    throw destinationError(
      SceneExportErrorCodes.destinationRejected,
      '所选路径过长，请选择更短的文件夹'
    )
  }
  return resolved
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function destinationError(
  code: (typeof SceneExportErrorCodes)[keyof typeof SceneExportErrorCodes] = SceneExportErrorCodes.destinationRejected,
  message = sceneExportErrorMessages[code]
): AppException {
  return new AppException({ code, msg: message })
}
