import type {
  SceneGenerationExecution,
  SceneGenerationRepairContext
} from '@application/scene-generation/models/SceneGenerationExecution'
import { installedPackageVersion } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { neutralSceneAssetReference } from '@infrastructure/webgal/assetPath'
import type { WebGalSceneAgentInput } from '../WebGalSceneAgentTypes'
import { authorizedInputReadPath } from './authorizedInputs'

const REPAIR_CANDIDATE_NOTE = '源候选已复制到当前候选工作区，作为修复起点；本操作尚未重新提交'

export class SceneGenerationContextAssemblerImpl {
  assemble(input: WebGalSceneAgentInput): string {
    const execution = input.execution
    const repair = repairFacts(execution)
    const authorRevision =
      input.authorRevisionActive === true ? authorRevisionFacts(input) : undefined
    const diagnostics = input.candidate?.preview.validationReport
    const hints = missingAssetHints(diagnostics)
    return JSON.stringify({
      mode: input.mode,
      ...(input.mode === 'repair'
        ? {
            repairKind:
              authorRevision !== undefined
                ? 'author'
                : execution.repairSource !== undefined
                  ? 'sourceRepair'
                  : 'diagnostic'
          }
        : {}),
      ...(authorRevision === undefined ? {} : { authorRevision }),
      target: {
        projectId: execution.projectId,
        sceneId: execution.sceneId,
        entryFile: `${execution.source.sceneDirectory}/${execution.source.entryFile}`
      },
      versions: {
        engine: installedPackageVersion('webgal-engine'),
        parser: installedPackageVersion('webgal-parser')
      },
      ...(input.skill === undefined ? {} : { skill: input.skill }),
      inputs: {
        canvasId: execution.inputSnapshot.canvasId,
        arrangementVersion: execution.inputSnapshot.arrangementVersion,
        // 素材索引只给身份、用途、路径和命令引用；同一个素材不再另出一份副本。
        assets: (execution.inputSnapshot.assets ?? []).map((asset) => ({
          ...asset,
          commandReference: neutralSceneAssetReference(asset.relativePath)
        })),
        // 文档与提示词只给受信索引；正文由模型按 readPath 用 readTextRange 分段读取。
        documents: (execution.inputSnapshot.documents ?? []).map((document) => ({
          id: document.id,
          sourceId: document.sourceId,
          title: document.title,
          summary: document.summary,
          topics: document.topics,
          usage: document.usage,
          readPath: authorizedInputReadPath('documents', document.id),
          charLength: [...document.body].length
        })),
        prompts: (execution.inputSnapshot.prompts ?? []).map((prompt) => ({
          id: prompt.id,
          title: prompt.title,
          scopes: prompt.scopes,
          references: prompt.references,
          usage: prompt.usage,
          readPath: authorizedInputReadPath('prompts', prompt.id),
          charLength: [...prompt.body].length
        })),
        fieldBindings: execution.inputSnapshot.fieldBindings ?? [],
        relations: execution.inputSnapshot.relations ?? [],
        confirmedControls: execution.inputSnapshot.confirmedControls ?? []
      },
      candidateSnapshotId: execution.candidateSnapshotId,
      ...(input.draft === undefined ? {} : { draft: input.draft }),
      ...(repair === undefined ? {} : { repair }),
      toolAccess: {
        candidateTools: {
          names: ['listDirectory', 'readTextRange', 'writeCandidate'],
          pathFormat: '候选根内相对路径，不能以 / 开头',
          writablePaths: [`${execution.source.sceneDirectory}/${execution.source.entryFile}`],
          writeTool: 'writeCandidate',
          writeContract: {
            target: '必须等于 draft.path',
            expectedRevision: '必须等于 draft.revision；入口不存在时为 absent',
            result: '实际字节数、内容摘要与候选读取权限不变'
          },
          inputReads:
            'inputs.documents[].readPath 与 inputs.prompts[].readPath 是本次授权的只读正文路径；用 readTextRange 按 start/maxChars 分段读取，不要一次读取全文。'
        }
      },
      candidateFiles: input.candidate?.preview.files,
      diagnostics,
      ...(hints.length === 0 ? {} : { missingAssetHints: hints }),
      commandLocations: input.candidate?.preview.commandLocations,
      acceptedReplies: confirmedUserReplies(input),
      budget: execution.budget,
      historySummary: input.summary
    })
  }
}

function confirmedUserReplies(
  input: WebGalSceneAgentInput
): WebGalSceneAgentInput['confirmedReplies'] {
  const replies = input.confirmedReplies ?? input.execution.replies
  if (input.mode !== 'repair' || input.execution.repairSource === undefined) return replies
  return replies.filter(
    (reply) =>
      reply.operationId === input.execution.operationId &&
      (reply.reply.kind === 'revise' || reply.reply.kind === 'clarify') &&
      reply.reply.body.trim() !== ''
  )
}

/**
 * 同一操作内作者点名修改的可信结构化事实。
 * 与来源修复的 repair.instruction、自动修正的 diagnostics 分开，避免把诊断修复当成作者要求。
 */
function authorRevisionFacts(input: WebGalSceneAgentInput): Record<string, unknown> | undefined {
  if (input.mode !== 'repair' || input.execution.repairSource !== undefined) return undefined
  const replies = (input.confirmedReplies ?? input.execution.replies).flatMap((reply) =>
    reply.operationId === input.execution.operationId &&
    reply.reply.kind === 'revise' &&
    reply.reply.body.trim() !== ''
      ? [{ kind: 'revise' as const, body: reply.reply.body.trim() }]
      : []
  )
  const latest = replies.at(-1)
  if (!latest) return undefined
  return {
    ...(input.execution.candidateSnapshotId === undefined
      ? {}
      : { sourceCandidate: input.execution.candidateSnapshotId }),
    instruction: latest.body,
    scope: '只修改作者点名内容及其必要关联；保留其它仍有效的剧情、演出与已确认要求，不整篇重写。',
    replies
  }
}

function repairFacts(execution: SceneGenerationExecution): Record<string, unknown> | undefined {
  const repair = execution.repairContext
  if (repair === undefined) return undefined
  const previousFailure = failureFacts(repair)
  const hints = missingAssetHints(repair.validationReport)
  return {
    candidate: {
      path: repair.candidatePath,
      sourceRevision: repair.sourceCandidateSnapshotId,
      ...(execution.repairInputSnapshotId === undefined
        ? {}
        : { workspaceRevision: execution.repairInputSnapshotId }),
      note: REPAIR_CANDIDATE_NOTE
    },
    instruction: repair.instruction,
    ...(repair.summary.trim() === '' ? {} : { previousSummary: repair.summary }),
    ...(previousFailure === undefined ? {} : { previousFailure }),
    confirmedReplies: repair.confirmedReplies.map(({ kind, body }) => ({ kind, body })),
    ...(repair.unresolvedIssues.length === 0
      ? {}
      : { unresolvedIssues: [...repair.unresolvedIssues] }),
    ...(repair.validationReport === undefined ? {} : { diagnostics: repair.validationReport }),
    ...(hints.length === 0 ? {} : { missingAssetHints: hints })
  }
}

function failureFacts(repair: SceneGenerationRepairContext): Record<string, string> | undefined {
  const facts = {
    ...(repair.failureClass === undefined ? {} : { class: repair.failureClass }),
    ...(repair.failureReason === undefined ? {} : { reason: repair.failureReason }),
    ...(repair.failureMessage === undefined ? {} : { message: repair.failureMessage })
  }
  return Object.keys(facts).length === 0 ? undefined : facts
}

function missingAssetHints(
  report: { readonly issues: readonly MissingAssetDiagnosticIssue[] } | undefined
): string[] {
  const hints: string[] = []
  for (const issue of report?.issues ?? []) {
    if (
      issue.code !== 'missing-asset' ||
      issue.reference === undefined ||
      issue.nearestReference === undefined ||
      issue.nearestAssetPath === undefined
    )
      continue
    hints.push(
      missingAssetHint({
        line: issue.line,
        sequence: issue.sequence,
        reference: issue.reference,
        nearestReference: issue.nearestReference,
        nearestAssetName: issue.nearestAssetName,
        nearestAssetPath: issue.nearestAssetPath
      })
    )
  }
  return hints
}

function missingAssetHint(input: {
  line: number | undefined
  sequence: number | undefined
  reference: string
  nearestReference: string
  nearestAssetName: string | undefined
  nearestAssetPath: string
}): string {
  const location =
    input.line === undefined
      ? input.sequence === undefined
        ? '候选'
        : `候选第 ${input.sequence + 1} 条语句`
      : `第 ${input.line} 行`
  const asset = input.nearestAssetName === undefined ? '' : `素材「${input.nearestAssetName}」，`
  return `${location}的素材引用「${input.reference}」在工程中不存在；最接近的有效引用是「${input.nearestReference}」（${asset}工程路径 ${input.nearestAssetPath}）。请核对后改为正确引用。`
}

type MissingAssetDiagnosticIssue = {
  readonly code: string
  readonly sequence?: number
  readonly reference?: string
  readonly line?: number
  readonly nearestReference?: string
  readonly nearestAssetName?: string
  readonly nearestAssetPath?: string
}
