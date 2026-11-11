import { createHash } from 'node:crypto'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type { DialogueTextEdit } from '@domain/scene-preview/models/DialogueTextEdit'
import type { VersionSettlementVO } from '@application/project-versioning/vo/ProjectVersioningVO'
import type { ReadDialogueSaveSettlementDTO } from '@application/scene-preview/dto/DialogueSaveDTO'
import type {
  PreviewSaveCommitRequest,
  PreviewSaveCommitResult,
  PreviewSaveVersionGateway
} from '@application/scene-preview/ports/PreviewSaveVersionGateway'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import {
  PREVIEW_SAVE_SOURCE_MODULE,
  PREVIEW_SAVE_TARGET_KIND
} from '@application/scene-preview/ports/PreviewSaveVersionGateway'
import type { DialogueSaveSettlementVO } from '@application/scene-preview/vo/DialogueSaveVO'
import type { PreviewErrorVO } from '@application/scene-preview/vo/PreviewErrorVO'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { assertRelativePath } from '@infrastructure/git/containedPath'
import { resolveProjectWorkRoot } from '@infrastructure/project-versioning/projectWorkRoot'
import { readSceneLock } from '@infrastructure/scenes/sceneLockReader'

import { previewCallerOperationId } from './previewSaveIdentity'
import {
  readPreviewSaveRecord,
  samePreviewPayload,
  writePreviewSaveRecord,
  type PreviewSaveRecord
} from './previewSaveRecord'

const LOCK_PATH = '.opengalgame/scene-locks.json'

/**
 * 预览保存自己的提交域。
 * 只调用通用版本边界，不调用生成版本网关，也不使用生成提交身份。
 */
export class LocalPreviewSaveVersionGateway implements PreviewSaveVersionGateway {
  constructor(
    private readonly userDirectory: string,
    private readonly versioning: ProjectVersioningApplicationService,
    private readonly sources: ScenePreviewSourceGateway
  ) {}

  async commitPreviewSave(request: PreviewSaveCommitRequest): Promise<PreviewSaveCommitResult> {
    const identity = this.identity(request)
    const existing = await this.readPreviewSaveSettlement({
      ...identity.request,
      editsSnapshot: request.editsSnapshot
    })
    if (existing.status === 'conflict') return { status: 'rejected', failure: existing.failure }
    if (existing.status === 'saved')
      return { status: 'committed', contentBasis: existing.contentBasis }
    if (existing.status === 'unchanged') return existing
    if (existing.status === 'pendingVerification') return { status: 'pendingVerification' }
    if (existing.status === 'notCommitted') return { status: 'rejected', failure: existing.failure }
    const relativePath = assertRelativePath(request.revision.relativePath)
    const targets = [{ kind: PREVIEW_SAVE_TARGET_KIND, id: request.sceneId }]
    const watchedPaths = [LOCK_PATH]
    try {
      const prepared = await this.versioning.prepareOperation({
        projectId: request.projectId,
        sourceModule: PREVIEW_SAVE_SOURCE_MODULE,
        targets,
        changePaths: [relativePath],
        watchedPaths
      })
      await this.versioning.bindCallerOperation({
        projectId: request.projectId,
        sourceModule: PREVIEW_SAVE_SOURCE_MODULE,
        callerOperationId: identity.callerOperationId,
        operationId: prepared.operationId,
        targets,
        changePaths: [relativePath],
        watchedPaths
      })
      await this.persistRecord(
        request,
        identity.callerOperationId,
        prepared.operationId,
        relativePath
      )
      const committed = await this.versioning.commitOperation(
        {
          projectId: request.projectId,
          operationId: prepared.operationId,
          baselineRef: prepared.baselineRef,
          input: {
            kind: 'files',
            changes: [
              {
                relativePath,
                action: 'modify',
                content: { kind: 'bytes', bytes: request.revision.bytes }
              }
            ]
          },
          saveMode: 'manual',
          contentSource: 'operation',
          title: '保存预览台词',
          summary: '已保存当前场景台词正文'
        },
        async () => {
          await this.requireEditable(request)
          await this.requireRecord(
            request,
            identity.callerOperationId,
            prepared.operationId,
            relativePath
          )
        }
      )
      const contentBasis = await this.confirmSavedBasis(request, identity.callerOperationId)
      if (!contentBasis) return { status: 'pendingVerification' }
      return committed.state === '无变更'
        ? { status: 'unchanged', contentBasis }
        : { status: 'committed', contentBasis }
    } catch (error) {
      return this.fromCommitError(request, error)
    }
  }

  async readPreviewSaveSettlement(
    request: ReadDialogueSaveSettlementDTO & { readonly editsSnapshot?: string }
  ): Promise<DialogueSaveSettlementVO> {
    const identity = this.identity(request)
    let root: string
    let early: PreviewSaveRecord | null
    try {
      root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
      early = await readPreviewSaveRecord(root, identity.callerOperationId)
    } catch {
      return pending(identity)
    }
    if (early?.refusal && early.operationId === 'preview-refusal') {
      if (early.projectId !== request.projectId || early.sceneId !== request.sceneId)
        return conflict(identity)
      if (request.editsSnapshot !== undefined && early.editsSnapshot !== request.editsSnapshot)
        return conflict(identity)
      return refused(identity, early.refusal)
    }
    let link
    try {
      link = await this.versioning.findCallerOperation({
        sourceModule: PREVIEW_SAVE_SOURCE_MODULE,
        callerOperationId: identity.callerOperationId
      })
    } catch {
      return pending(identity)
    }
    if (!link) return { status: 'notFound', request: identity.request }
    if (link.projectId !== request.projectId || link.sourceModule !== PREVIEW_SAVE_SOURCE_MODULE)
      return conflict(identity)
    let record: PreviewSaveRecord | null
    try {
      record = await readPreviewSaveRecord(root, identity.callerOperationId)
    } catch {
      return pending(identity)
    }
    if (
      !record ||
      record.operationId !== link.operationId ||
      record.projectId !== request.projectId ||
      record.sceneId !== request.sceneId
    ) {
      return pending(identity)
    }
    if (request.editsSnapshot !== undefined && record.editsSnapshot !== request.editsSnapshot)
      return conflict(identity)
    let settlement: VersionSettlementVO
    try {
      settlement = await this.versioning.readOperationSettlement({
        projectId: request.projectId,
        operationId: link.operationId
      })
    } catch {
      return pending(identity)
    }
    return this.settlementResult(root, identity, record, settlement)
  }

  async recordPreviewSaveRefusal(request: {
    projectId: string
    sceneId: string
    requestId: string
    baseContentBasis: SceneContentBasisVO
    editsSnapshot: string
    committedEdits: readonly DialogueTextEdit[]
    failure: PreviewErrorVO
  }): Promise<void> {
    if (
      request.failure.code !== 'dialogueObjectInvalid' &&
      request.failure.code !== 'contentLocked' &&
      request.failure.code !== 'sessionClosed'
    ) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.insufficientEvidence,
        msg: '保存结果尚未核对'
      })
    }
    const identity = this.identity(request)
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const existing = await readPreviewSaveRecord(root, identity.callerOperationId)
    const record: PreviewSaveRecord = {
      formatVersion: 1,
      projectId: request.projectId,
      sceneId: request.sceneId,
      requestId: request.requestId,
      callerOperationId: identity.callerOperationId,
      operationId: 'preview-refusal',
      baseDigest: request.baseContentBasis.digest,
      parserVersion: request.baseContentBasis.parserVersion,
      engineVersion: request.baseContentBasis.engineVersion,
      editsSnapshot: request.editsSnapshot,
      committedEdits: request.committedEdits.map((edit) => ({
        dialogueId: edit.dialogueId,
        text: edit.text
      })),
      relativePath: '',
      revisionDigest: '0'.repeat(64),
      refusal: request.failure.code
    }
    if (existing && !samePreviewPayload(existing, record)) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一次保存不能改用不同内容'
      })
    }
    if (!existing) await writePreviewSaveRecord(root, record)
  }
  private identity(request: { projectId: string; sceneId: string; requestId: string }): {
    callerOperationId: string
    request: ReadDialogueSaveSettlementDTO
  } {
    return {
      callerOperationId: previewCallerOperationId(
        request.projectId,
        request.sceneId,
        request.requestId
      ),
      request: {
        projectId: request.projectId,
        sceneId: request.sceneId,
        requestId: request.requestId
      }
    }
  }

  private async persistRecord(
    request: PreviewSaveCommitRequest,
    callerOperationId: string,
    operationId: string,
    relativePath: string
  ): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const record: PreviewSaveRecord = {
      formatVersion: 1,
      projectId: request.projectId,
      sceneId: request.sceneId,
      requestId: request.requestId,
      callerOperationId,
      operationId,
      baseDigest: request.baseContentBasis.digest,
      parserVersion: request.baseContentBasis.parserVersion,
      engineVersion: request.baseContentBasis.engineVersion,
      editsSnapshot: request.editsSnapshot,
      committedEdits: request.committedEdits.map((edit) => ({
        dialogueId: edit.dialogueId,
        text: edit.text
      })),
      relativePath,
      revisionDigest: request.revision.digest
    }
    const existing = await readPreviewSaveRecord(root, callerOperationId)
    if (existing && !samePreviewPayload(existing, record)) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一次保存不能改用不同内容'
      })
    }
    if (!existing) await writePreviewSaveRecord(root, record)
  }

  private async requireRecord(
    request: PreviewSaveCommitRequest,
    callerOperationId: string,
    operationId: string,
    relativePath: string
  ): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const record = await readPreviewSaveRecord(root, callerOperationId)
    if (
      !record ||
      record.operationId !== operationId ||
      !samePreviewPayload(record, {
        projectId: request.projectId,
        sceneId: request.sceneId,
        requestId: request.requestId,
        baseDigest: request.baseContentBasis.digest,
        parserVersion: request.baseContentBasis.parserVersion,
        engineVersion: request.baseContentBasis.engineVersion,
        editsSnapshot: request.editsSnapshot,
        committedEdits: request.committedEdits,
        relativePath,
        revisionDigest: request.revision.digest
      })
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一次保存不能改用不同内容'
      })
    }
    if (
      createHash('sha256').update(request.revision.bytes).digest('hex') !== request.revision.digest
    ) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '预览保存内容无法核对' })
    }
  }

  private async requireEditable(request: PreviewSaveCommitRequest): Promise<void> {
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const relativePath = assertRelativePath(request.revision.relativePath)
    const separator = relativePath.lastIndexOf('/')
    const lock = await readSceneLock({
      projectId: request.projectId,
      sceneId: request.sceneId,
      projectRoot: root,
      sceneDirectory: relativePath.slice(0, separator),
      entryFile: relativePath.slice(separator + 1)
    })
    if (lock === 'locked') throw commitRefusal('contentLocked')
    if (lock !== 'unlocked') throw commitRefusal('contentBasisChanged')
  }

  private async confirmSavedBasis(
    request: PreviewSaveCommitRequest,
    callerOperationId: string
  ): Promise<SceneContentBasisVO | undefined> {
    try {
      const source = await this.sources.readScenePreviewSource({
        projectId: request.projectId,
        sceneId: request.sceneId
      })
      if (source.contentBasis.digest !== source.snapshot.digest) return undefined
      const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
      const record = await readPreviewSaveRecord(root, callerOperationId)
      if (!record) return undefined
      if (
        source.contentBasis.parserVersion !== record.parserVersion ||
        source.contentBasis.engineVersion !== record.engineVersion
      ) {
        return undefined
      }
      const written = source.snapshot.files.find(
        (file) => file.relativePath === record.relativePath
      )
      if (!written || written.digest !== record.revisionDigest) return undefined
      if (record.contentDigest === undefined) {
        await writePreviewSaveRecord(root, { ...record, contentDigest: source.contentBasis.digest })
      } else if (record.contentDigest !== source.contentBasis.digest) {
        return undefined
      }
      return source.contentBasis
    } catch {
      return undefined
    }
  }

  private async settlementResult(
    root: string,
    identity: { request: ReadDialogueSaveSettlementDTO },
    record: PreviewSaveRecord,
    settlement: VersionSettlementVO
  ): Promise<DialogueSaveSettlementVO> {
    if (record.refusal) return refused(identity, record.refusal)
    if (settlement.state === '待核对' || settlement.state === '待回退') return pending(identity)
    if (settlement.state === '未提交') {
      return {
        status: 'notCommitted',
        request: identity.request,
        failure: {
          code: 'saveNotConfirmed',
          message: '这次保存尚未确认',
          recovery: 'querySettlement'
        }
      }
    }
    if (settlement.state === '已回退') {
      return {
        status: 'conflict',
        request: identity.request,
        failure: { code: 'saveNotConfirmed', message: '这次保存已经回退', recovery: 'reopen' }
      }
    }
    if (settlement.state !== '无变更' && settlement.state !== '已提交') return pending(identity)
    const confirmed = await this.settledContentBasis(root, identity.request, record)
    if (!confirmed.ok) {
      return confirmed.reason === 'conflict' ? settlementConflict(identity) : pending(identity)
    }
    if (settlement.state === '无变更') {
      return {
        status: 'unchanged',
        contentBasis: confirmed.contentBasis,
        confirmedEdits: record.committedEdits
      }
    }
    return {
      status: 'saved',
      contentBasis: confirmed.contentBasis,
      committedEdits: record.committedEdits
    }
  }

  /**
   * 读取已结算保存的内容依据。
   * 提交后确认失败时记录可能缺 `contentDigest`，结算查询按当前工程文件重新核对：
   * 只有场景文件字节的 sha256 仍等于记录的 `revisionDigest` 才补写内容依据；
   * 内容已变返回冲突，读取或解析失败保持待核对，都不伪造摘要。
   */
  private async settledContentBasis(
    root: string,
    request: ReadDialogueSaveSettlementDTO,
    record: PreviewSaveRecord
  ): Promise<
    | { readonly ok: true; readonly contentBasis: SceneContentBasisVO }
    | { readonly ok: false; readonly reason: 'conflict' | 'pending' }
  > {
    if (record.contentDigest) {
      return {
        ok: true,
        contentBasis: {
          digest: record.contentDigest,
          parserVersion: record.parserVersion,
          engineVersion: record.engineVersion
        }
      }
    }
    try {
      const source = await this.sources.readScenePreviewSource({
        projectId: request.projectId,
        sceneId: request.sceneId
      })
      if (source.contentBasis.digest !== source.snapshot.digest) {
        return { ok: false, reason: 'pending' }
      }
      if (
        source.contentBasis.parserVersion !== record.parserVersion ||
        source.contentBasis.engineVersion !== record.engineVersion
      ) {
        return { ok: false, reason: 'pending' }
      }
      const written = source.snapshot.files.find(
        (file) => file.relativePath === record.relativePath
      )
      if (!written) return { ok: false, reason: 'pending' }
      if (written.digest !== record.revisionDigest) return { ok: false, reason: 'conflict' }
      const contentBasis: SceneContentBasisVO = {
        digest: source.contentBasis.digest,
        parserVersion: record.parserVersion,
        engineVersion: record.engineVersion
      }
      await writePreviewSaveRecord(root, { ...record, contentDigest: contentBasis.digest })
      return { ok: true, contentBasis }
    } catch (error) {
      console.warn('预览保存结算无法补读内容依据，保持待核对', {
        projectId: request.projectId,
        sceneId: request.sceneId,
        causeName: error instanceof Error ? error.name : undefined
      })
      return { ok: false, reason: 'pending' }
    }
  }

  private async fromCommitError(
    request: PreviewSaveCommitRequest,
    error: unknown
  ): Promise<PreviewSaveCommitResult> {
    if (isPreviewRefusal(error)) {
      await this.recordRefusal(request, error.cause)
      return { status: 'rejected', failure: previewRefusal(error.cause) }
    }
    if (isPayloadConflict(error)) {
      return { status: 'rejected', failure: previewRefusal('saveRequestReused') }
    }
    if (
      error instanceof AppException &&
      (error.code === ProjectVersioningErrorCodes.insufficientEvidence ||
        error.code === ErrorCodes.internalError)
    ) {
      return { status: 'pendingVerification' }
    }
    let settlement: DialogueSaveSettlementVO
    try {
      settlement = await this.readPreviewSaveSettlement({
        projectId: request.projectId,
        sceneId: request.sceneId,
        requestId: request.requestId,
        editsSnapshot: request.editsSnapshot
      })
    } catch {
      return { status: 'pendingVerification' }
    }
    if (settlement.status === 'saved')
      return { status: 'committed', contentBasis: settlement.contentBasis }
    if (settlement.status === 'unchanged' || settlement.status === 'pendingVerification')
      return settlement
    if (settlement.status === 'conflict' || settlement.status === 'notCommitted') {
      return { status: 'rejected', failure: settlement.failure }
    }
    if (settlement.status !== 'notFound') return { status: 'pendingVerification' }
    if (error instanceof AppException && error.code === ErrorCodes.operationConflict) {
      await this.recordRefusal(request, 'contentBasisChanged')
      return { status: 'rejected', failure: previewRefusal('contentBasisChanged') }
    }
    if (
      error instanceof AppException &&
      error.code === ProjectVersioningErrorCodes.gitQueryFailed
    ) {
      return { status: 'pendingVerification' }
    }
    return { status: 'pendingVerification' }
  }

  private async recordRefusal(
    request: PreviewSaveCommitRequest,
    refusal: 'contentLocked' | 'contentBasisChanged'
  ): Promise<void> {
    const identity = this.identity(request)
    const root = await resolveProjectWorkRoot(this.userDirectory, request.projectId)
    const record = await readPreviewSaveRecord(root, identity.callerOperationId)
    if (!record || record.refusal === refusal) {
      if (record) return
      throw new AppException({
        code: ProjectVersioningErrorCodes.insufficientEvidence,
        msg: '保存结果尚未核对'
      })
    }
    if (record.refusal || record.contentDigest) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一次保存不能改用不同内容'
      })
    }
    await writePreviewSaveRecord(root, { ...record, refusal })
  }
}

function pending(identity: { request: ReadDialogueSaveSettlementDTO }): DialogueSaveSettlementVO {
  return {
    status: 'pendingVerification',
    request: identity.request,
    failure: {
      code: 'saveOutcomeUnknown',
      message: '保存结果尚未核对',
      recovery: 'querySettlement'
    }
  }
}

function conflict(identity: { request: ReadDialogueSaveSettlementDTO }): DialogueSaveSettlementVO {
  return {
    status: 'conflict',
    request: identity.request,
    failure: { code: 'saveRequestReused', message: '同一次保存不能改用不同内容', recovery: 'none' }
  }
}

function settlementConflict(identity: {
  request: ReadDialogueSaveSettlementDTO
}): DialogueSaveSettlementVO {
  return {
    status: 'conflict',
    request: identity.request,
    failure: {
      code: 'saveSettlementConflict',
      message: '保存记录与当前场景不一致',
      recovery: 'querySettlement'
    }
  }
}

const refusalMessages = {
  contentLocked: '当前场景已锁定，不能修改',
  contentBasisChanged: '场景内容已经变化，请重新打开',
  dialogueObjectInvalid: '要修改的台词已失效',
  saveRequestReused: '同一次保存不能改用不同内容',
  sessionClosed: '预览会话已关闭'
} as const

function commitRefusal(code: 'contentLocked' | 'contentBasisChanged'): AppException {
  return new AppException({
    code: ErrorCodes.operationConflict,
    msg: refusalMessages[code],
    cause: code
  })
}

function isPreviewRefusal(
  error: unknown
): error is AppException & { cause: 'contentLocked' | 'contentBasisChanged' } {
  return (
    error instanceof AppException &&
    error.code === ErrorCodes.operationConflict &&
    (error.cause === 'contentLocked' || error.cause === 'contentBasisChanged')
  )
}

function isPayloadConflict(error: unknown): boolean {
  return (
    error instanceof AppException &&
    error.code === ErrorCodes.operationConflict &&
    error.message === '同一次保存不能改用不同内容'
  )
}

function previewRefusal(
  code:
    | 'contentLocked'
    | 'contentBasisChanged'
    | 'dialogueObjectInvalid'
    | 'saveRequestReused'
    | 'sessionClosed'
): PreviewErrorVO {
  return {
    code,
    message: refusalMessages[code],
    recovery:
      code === 'contentBasisChanged' || code === 'dialogueObjectInvalid' || code === 'sessionClosed'
        ? 'reopen'
        : 'none'
  }
}

function refused(
  identity: { request: ReadDialogueSaveSettlementDTO },
  code: 'contentLocked' | 'contentBasisChanged' | 'dialogueObjectInvalid' | 'sessionClosed'
): DialogueSaveSettlementVO {
  return { status: 'conflict', request: identity.request, failure: previewRefusal(code) }
}
