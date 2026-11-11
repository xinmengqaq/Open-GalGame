import type {
  SceneGenerationExecution,
  SceneGenerationRepairContext
} from '@application/scene-generation/models/SceneGenerationExecution'
import { installedPackageVersion } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { neutralSceneAssetReference } from '@infrastructure/webgal/assetPath'
import type { WebGalSceneAgentInput } from '../WebGalSceneAgentTypes'

/** 修复起点只给读取坐标，候选正文由模型按路径用 readTextRange 自己读取。 */
const REPAIR_CANDIDATE_NOTE = '源候选已复制到当前候选工作区，作为修复起点；本操作尚未重新提交'

export class SceneGenerationContextAssemblerImpl {
  assemble(input: WebGalSceneAgentInput): string {
    const execution = input.execution
    const repair = repairFacts(execution)
    const diagnostics = input.candidate?.preview.validationReport
    const hints = missingAssetHints(diagnostics)
    return JSON.stringify({
      mode: input.mode,
      target: {
        projectId: execution.projectId,
        sceneId: execution.sceneId,
        entryFile: `${execution.source.sceneDirectory}/${execution.source.entryFile}`
      },
      versions: {
        engine: installedPackageVersion('webgal-engine'),
        parser: installedPackageVersion('webgal-parser')
      },
      inputs: execution.inputSnapshot,
      assetBindings: execution.inputSnapshot.assets.map((asset) => ({
        ...asset,
        commandReference: neutralSceneAssetReference(asset.relativePath)
      })),
      candidateSnapshotId: execution.candidateSnapshotId,
      ...(repair === undefined ? {} : { repair }),
      toolAccess: {
        candidateTools: {
          names: ['listDirectory', 'readTextRange', 'writeText', 'replaceText'],
          pathFormat: '候选根内相对路径，不能以 / 开头',
          writablePaths: [`${execution.source.sceneDirectory}/${execution.source.entryFile}`]
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
 * 修复重跑来源事实。只给候选读取坐标与源事实，不复制候选正文；
 * 旧记录缺 `repairContext` 时不输出该块，也不补造。
 */
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

/** 修正轮可直接读的缺失素材提示；只使用已增强的结构化诊断，不猜测候选正文。 */
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
