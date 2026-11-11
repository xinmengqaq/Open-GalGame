import { createHash } from 'node:crypto'
import type { ReadSceneGenerationCheckpointDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { toOperationVO } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import { phaseOf } from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { digestBytes } from '@infrastructure/git/objects/gitContent'
import {
  readCommitFiles,
  readCommitParent,
  resolveRefIfExists
} from '@infrastructure/git/objects/gitTree'
import { installedPackageVersion } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { langGraphThreadKey, scopeFromThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { assessContinuation } from '@infrastructure/workflow/history/workflowHistory'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import { executionFromDocument } from '../execution/SceneGenerationExecutionDocument'
import {
  createWebGalGenerationGraph,
  type WebGalGenerationGraphDependencies
} from '../workflow/createWebGalGenerationGraph'
import type { WebGalGenerationStateValue } from '../workflow/WebGalGenerationState'

export class WebGalGenerationCheckpointSaver extends FileCheckpointSaver {
  /** 每个完整图任务边界保存候选关联，进程退出不依赖运行结束后的补录。 */
  override async put(
    ...args: Parameters<FileCheckpointSaver['put']>
  ): ReturnType<FileCheckpointSaver['put']> {
    const config = await super.put(...args)
    const executionValue = args[1].channel_values.execution
    if (executionValue) {
      const execution = executionFromDocument(executionValue)
      const scope = scopeFromThreadKey(String(config.configurable!.thread_id))
      if (
        scope.projectId === execution.projectId &&
        scope.threadId === execution.threadId &&
        scope.branchId === execution.branchId
      ) {
        await this.associate(execution, String(config.configurable!.checkpoint_id), {
          inputDigest: generationInputDigest(execution),
          candidateRevision: execution.candidateSnapshotId,
          operationId: execution.operationId
        })
      }
    }
    return config
  }
}

export function webGalGenerationCompatibility(): { version: 1; engine: string; parser: string } {
  return {
    version: 1,
    engine: installedPackageVersion('webgal-engine'),
    parser: installedPackageVersion('webgal-parser')
  }
}

/** 已完成任务边界绑定当前输入与作品基线，不含提示词或模型原文。 */
export function generationInputDigest(execution: SceneGenerationExecution): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputs: execution.inputSnapshot,
        baseline: execution.baseline,
        policy: execution.policy,
        source: execution.source
      })
    )
    .digest('hex')
}

/** 历史与恢复共用只读完整性检查，不调用模型、不恢复文件。 */
export async function readWebGalGenerationCheckpoint(
  deps: WebGalGenerationGraphDependencies,
  files: AiProjectFileSystemImpl,
  request: ReadSceneGenerationCheckpointDTO
): Promise<SceneGenerationCheckpoint> {
  const identity = { ...request, operationId: 'history' }
  const graph = createWebGalGenerationGraph(deps)
  const config = {
    configurable: {
      thread_id: langGraphThreadKey(identity),
      checkpoint_ns: '',
      checkpoint_id: request.checkpointId
    }
  }
  if (!(await deps.saver.getTuple(config)))
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史检查点不存在' })
  const snapshot = await graph.getState(config)
  const state = snapshot.values as WebGalGenerationStateValue
  const execution = executionFromDocument(state.execution)
  if (
    execution.projectId !== request.projectId ||
    execution.sceneId !== request.sceneId ||
    execution.threadId !== request.threadId ||
    execution.branchId !== request.branchId
  )
    throw new AppException({ code: ErrorCodes.forbidden, msg: '检查点不属于当前场景分支' })
  const association = await deps.saver.readAssociation(execution, request.checkpointId)
  let reason: string | undefined
  if (JSON.stringify(state.compatibility) !== JSON.stringify(webGalGenerationCompatibility()))
    reason = '检查点引擎或业务格式不兼容'
  else if (
    !association ||
    association.operationId !== execution.operationId ||
    association.inputDigest !== generationInputDigest(execution) ||
    association.candidateRevision !== execution.candidateSnapshotId
  )
    reason = '检查点缺少完整输入或候选修订关联'
  else if (state.execution.candidateSnapshotId) {
    const workspace = files.locateWorkspace(execution)
    try {
      const ref = await resolveRefIfExists(
        { gitdir: workspace.revisionGitDir },
        `refs/opengalgame/revisions/${execution.candidateSnapshotId}`
      )
      if (ref !== execution.candidateSnapshotId) reason = '候选修订缺失'
      else
        await readCommitFiles({ gitdir: workspace.revisionGitDir }, execution.candidateSnapshotId)
    } catch {
      reason = '候选修订缺失或损坏'
    }
  }
  let differences: SceneGenerationCheckpoint['view']['differences'] = []
  if (!reason && execution.candidateSnapshotId)
    differences = await candidateFileDifferences(files, execution)
  if (!reason) {
    const assessed = assessContinuation(await readDurableEffects(deps.stateRoot, execution))
    if (!assessed.continuable) reason = assessed.reason
  }
  if (!reason && ['failed', 'cancelled', 'succeeded'].includes(execution.state))
    reason =
      execution.state === 'cancelled'
        ? '操作已取消，候选仅供查看，不能继续'
        : '操作已结束，候选仅供查看，不能继续'
  return {
    execution,
    candidateSnapshotId: execution.candidateSnapshotId,
    // 空串/空数组是已清空的权威事实；只有旧检查点缺字段时才保持缺失。
    summary: typeof state.summary === 'string' ? state.summary : undefined,
    unresolvedIssues: Array.isArray(state.unresolvedIssues) ? state.unresolvedIssues : undefined,
    view: {
      ...toOperationVO(execution),
      checkpointId: request.checkpointId,
      phase: phaseOf(execution.state, execution.step),
      summary: state.summary || '场景生成检查点',
      decisions: execution.replies.map((reply) => ({
        interactionId: reply.interactionId,
        reply: reply.reply
      })),
      differences,
      preview: state.candidate?.preview,
      canView: true,
      canContinue: !reason,
      reason
    }
  }
}

/**
 * @returns 有变化的相对路径及前后摘要；没有上一修订时只填之后摘要。
 * @throws {AppException} 当前修订无法读取。
 */
async function candidateFileDifferences(
  files: AiProjectFileSystemImpl,
  execution: SceneGenerationExecution
): Promise<SceneGenerationCheckpoint['view']['differences']> {
  const location = { gitdir: files.locateWorkspace(execution).revisionGitDir }
  const currentId = execution.candidateSnapshotId!
  const current = await readCommitFiles(location, currentId)
  const parentId = await readCommitParent(location, currentId)
  const previous = parentId ? await readCommitFiles(location, parentId) : []
  const before = new Map(previous.map((file) => [file.relativePath, digestBytes(file.bytes)]))
  const after = new Map(current.map((file) => [file.relativePath, digestBytes(file.bytes)]))
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((filePath) => {
    const beforeDigest = before.get(filePath)
    const afterDigest = after.get(filePath)
    if (beforeDigest === afterDigest) return []
    return [
      {
        filePath,
        ...(beforeDigest ? { beforeDigest } : {}),
        ...(afterDigest ? { afterDigest } : {})
      }
    ]
  })
}
