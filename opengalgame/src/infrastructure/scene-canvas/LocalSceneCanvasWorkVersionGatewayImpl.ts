import { readFile } from 'node:fs/promises'

import type { SceneCanvasSaveReason } from '@application/scene-canvas/dto/SceneCanvasDTO'
import type {
  SceneCanvasVersionKeepRequest,
  SceneCanvasVersionSettlement
} from '@application/scene-canvas/models/SceneCanvasSaveFacts'
import type { SceneCanvasWorkVersionGateway } from '@application/scene-canvas/ports/SceneCanvasWorkVersionGateway'
import type { VersionSaveMode } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { resolveContained } from '@infrastructure/git/containedPath'
import {
  digestBytes,
  digestVersionParts
} from '@infrastructure/project-files/public/projectFileStorage'

import type { SceneCanvasProjectLocation } from './LocalSceneCanvasArrangementPersistenceGatewayImpl'
import { arrangementPath } from './sceneCanvasPaths'

const SOURCE_MODULE = 'scene-canvas'

export class LocalSceneCanvasWorkVersionGatewayImpl implements SceneCanvasWorkVersionGateway {
  constructor(
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly locateProject: (projectId: string) => Promise<SceneCanvasProjectLocation>
  ) {}

  async keepArrangement(
    request: SceneCanvasVersionKeepRequest
  ): Promise<SceneCanvasVersionSettlement> {
    const relativePath = arrangementPath(request.sceneId, request.canvasId)
    const targets = [{ kind: 'scene-canvas', id: `${request.sceneId}:${request.canvasId}` }]
    try {
      const bytes = await this.readBytes(request.projectId, relativePath)
      const save = describeSave(request.reason)
      const existing = await this.versioning.findCallerOperation({
        sourceModule: SOURCE_MODULE,
        callerOperationId: request.operationId
      })
      if (existing && existing.projectId !== request.projectId) return { state: 'unknown' }
      const operation = existing
        ? await this.versioning.readPreparedOperation({
            projectId: request.projectId,
            operationId: existing.operationId
          })
        : await this.versioning.prepareOperation({
            projectId: request.projectId,
            sourceModule: SOURCE_MODULE,
            targets,
            changePaths: [relativePath],
            watchedPaths: []
          })
      await this.versioning.bindCallerOperation({
        projectId: request.projectId,
        sourceModule: SOURCE_MODULE,
        callerOperationId: request.operationId,
        operationId: operation.operationId,
        targets,
        changePaths: [relativePath],
        watchedPaths: []
      })
      const committed = await this.versioning.commitOperation(
        {
          projectId: request.projectId,
          operationId: operation.operationId,
          baselineRef: operation.baselineRef,
          input: {
            kind: 'files',
            changes: [{ relativePath, action: 'modify', content: { kind: 'bytes', bytes } }]
          },
          saveMode: save.saveMode,
          contentSource: 'operation',
          title: save.title,
          summary: '已核对当前场景编排'
        },
        () => this.requireSameBytes(request.projectId, relativePath, bytes)
      )
      if (committed.state === '已提交' || committed.state === '无变更') return { state: 'kept' }
      return { state: 'failed' }
    } catch (error) {
      return fromError(error)
    }
  }

  async readSettlement(operationId: string): Promise<SceneCanvasVersionSettlement> {
    try {
      const link = await this.versioning.findCallerOperation({
        sourceModule: SOURCE_MODULE,
        callerOperationId: operationId
      })
      if (!link) return { state: 'unknown' }
      return fromSettlement(
        await this.versioning.readOperationSettlement({
          projectId: link.projectId,
          operationId: link.operationId
        })
      )
    } catch (error) {
      return fromError(error)
    }
  }

  async readArrangementVersion(request: {
    projectId: string
    sceneId: string
    canvasId: string
  }): Promise<{
    projectId: string
    sceneId: string
    canvasId: string
    arrangementVersion: string
  }> {
    const relativePath = arrangementPath(request.sceneId, request.canvasId)
    let bytes: Uint8Array
    try {
      bytes = await this.readBytes(request.projectId, relativePath)
    } catch (error) {
      throw new AppException({
        code: SceneCanvasErrorCodes.commitUnknown,
        msg: '编排提交结果尚未查明',
        cause: error
      })
    }
    return {
      ...request,
      arrangementVersion: digestVersionParts([
        'project-file-arrangement-v1',
        request.projectId,
        request.sceneId,
        request.canvasId,
        digestBytes(bytes)
      ])
    }
  }

  private async requireSameBytes(
    projectId: string,
    relativePath: string,
    expected: Uint8Array
  ): Promise<void> {
    const current = await this.readBytes(projectId, relativePath)
    if (current.byteLength !== expected.byteLength) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '编排在提交前已变化' })
    }
    for (let index = 0; index < current.byteLength; index += 1) {
      if (current[index] !== expected[index]) {
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '编排在提交前已变化' })
      }
    }
  }

  private async readBytes(projectId: string, relativePath: string): Promise<Uint8Array> {
    const project = await this.locateProject(projectId)
    if (project.projectId !== projectId) {
      throw new AppException({
        code: SceneCanvasErrorCodes.ownershipMismatch,
        msg: '工程文件归属不匹配'
      })
    }
    const target = await resolveContained(project.directory, relativePath)
    try {
      return new Uint8Array(await readFile(target))
    } catch (error) {
      if (error instanceof AppException) throw error
      throw new AppException({
        code: SceneCanvasErrorCodes.commitFailed,
        msg: '编排内容无法核对',
        cause: error
      })
    }
  }
}

function describeSave(reason: SceneCanvasSaveReason): { saveMode: VersionSaveMode; title: string } {
  if (reason === 'manual') return { saveMode: 'manual', title: '保存场景编排' }
  if (reason === 'beforeGeneration') return { saveMode: 'system', title: '生成前保存场景编排' }
  return { saveMode: 'system', title: '自动保存场景编排' }
}

function fromSettlement(settlement: VersionSettlementVO): SceneCanvasVersionSettlement {
  if (settlement.state === '已提交' || settlement.state === '无变更') return { state: 'kept' }
  if (settlement.state === '未提交') return { state: 'uncommitted' }
  return { state: 'unknown' }
}

function fromError(error: unknown): SceneCanvasVersionSettlement {
  if (!(error instanceof AppException)) return { state: 'unknown' }
  if (error.code === ErrorCodes.operationConflict) return { state: 'uncommitted' }
  if (
    error.code === ErrorCodes.internalError ||
    error.code === ProjectVersioningErrorCodes.invalidOperationIdentity ||
    error.code === ProjectVersioningErrorCodes.gitUnavailable ||
    error.code === ProjectVersioningErrorCodes.gitQueryFailed ||
    error.code === ProjectVersioningErrorCodes.insufficientEvidence
  ) {
    return { state: 'unknown' }
  }
  return { state: 'failed' }
}
