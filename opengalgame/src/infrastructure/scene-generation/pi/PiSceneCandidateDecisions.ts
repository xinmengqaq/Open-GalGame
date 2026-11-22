import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import type { SceneVersionGateway } from '@application/scene-generation/ports/SceneVersionGateway'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationQuestionVO } from '@application/scene-generation/vo/SceneGenerationVO'
import type {
  SceneValidationIssueCode,
  SceneValidationReport
} from '@domain/scene-generation/models/SceneValidationReport'
import type { SceneCandidateJudgment } from '@domain/scene-generation/models/SceneCandidateJudgment'
import { safeSceneValidationIssueMessage } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { toDomainRequest } from '@application/scene-generation/policies/SceneGenerationCandidatePolicy'
import { throwIfStopped } from '@infrastructure/ai/execution/executionErrors'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import {
  contextOnly,
  reviewInteraction,
  validationReportOf
} from './PiSceneGenerationSupport'
import type {
  PassOutcome,
  ReadyBoundaryFacts,
  RunState
} from './PiSceneGenerationTypes'

/**
 * 候选判断与安全等待边界。只把真实领域报告转为作者可见事实；
 * 没有报告时不合成“无问题”，也不在这里写候选或提交作品。
 */
export class PiSceneCandidateDecisions {
  constructor(
    private readonly deps: {
      readonly domain: SceneGenerationDomainService
      readonly versions: Pick<SceneVersionGateway, 'inspectBaseline'>
      readonly nextId: () => string
    }
  ) {}

  /**
   * 只按候选内容和启动时的锁定事实重新判定，不重新读取正式工程基线。
   * 用于作者接受后的同一校验边界；真实基线由提交网关在短写入边界复验。
   */
  judgeContent(
    execution: SceneGenerationExecution,
    candidate: SceneGenerationCandidate
  ): SceneCandidateJudgment {
    const report: SceneValidationReport = {
      issues: candidate.preview.validationReport.issues.map((issue) => ({
        ...issue,
        code: issue.code as SceneValidationIssueCode
      }))
    }
    return this.deps.domain.evaluateResult(
      report,
      toDomainRequest(execution, {
        baselineState: 'unchanged',
        lockState: execution.baseline.lockState
      })
    )
  }

  /**
   * 读回候选后使用现有领域服务判断是否可审阅、可修正或必须停下。
   * 内容校验通过后重新核对正式工程基线与锁定；不一致的候选不能进入待审阅。
   */
  async judge(
    execution: SceneGenerationExecution,
    candidate: SceneGenerationCandidate
  ): Promise<SceneCandidateJudgment> {
    const content = this.judgeContent(execution, candidate)
    if (content.status !== 'acceptable') return content
    const facts = await this.deps.versions.inspectBaseline(execution)
    return this.deps.domain.evaluateResult(content.report, toDomainRequest(execution, facts))
  }

  /**
   * 已完成写入后的统一路由：可审阅则发布等待，不能自动修正则回到人工修改。
   * @returns 终态等待；可自动修正时返回 undefined，由调用方决定下一轮。
   */
  decideCandidate(
    state: RunState,
    candidate: SceneGenerationCandidate,
    judgment: SceneCandidateJudgment,
    stalled: boolean
  ): PassOutcome | undefined {
    const execution = state.execution
    const report = judgment.report
    if (judgment.status === 'acceptable') {
      // 只有校验通过且未被取消时的候选才进入待审阅；中止信号在发布前最后核对一次。
      throwIfStopped(state.signal)
      if (state.reviewAccepted)
        // 接受语义本身已越过候选写入；默认从当前候选重新判断即可恢复，
        // 具体运行轮次由能提供事实的调用方覆盖。
        return this.readyOutcome(execution, state.candidateSnapshotId!, report, {
          pass: 0,
          firstMode: 'repair',
          mode: 'repair',
          baseCandidateSnapshotId: state.candidateSnapshotId!,
          reviewAccepted: true
        })
      return {
        kind: 'waiting',
        checkpointId: piReviewCheckpointId(execution.operationId, state.candidateSnapshotId!),
        candidateSnapshotId: state.candidateSnapshotId!,
        interaction: reviewInteraction(
          this.deps.nextId(),
          execution,
          state.candidateSnapshotId!,
          candidate
        ),
        artifactValidation: report,
        step: 'validating',
        attempt: execution.attempt
      }
    }
    const correctionsExhausted = state.correctionCount >= execution.policy.maxCorrections
    if (
      stalled ||
      judgment.status !== 'correctable' ||
      contextOnly(report) ||
      correctionsExhausted
    ) {
      const reason = stalled
        ? '同一草稿和诊断没有变化，已停止自动修正。'
        : judgment.status !== 'correctable'
          ? '该问题不能自动修正。'
          : contextOnly(report)
            ? '缺少背景或角色上下文，需要作者说明。'
            : `已自动修正 ${state.correctionCount} 次，仍有未消除的问题。`
      return this.correctionOutcome(
        execution,
        state.candidateSnapshotId ?? execution.candidateSnapshotId,
        candidate,
        reason,
        report
      )
    }
    return undefined
  }

  /** 可提交结果；真正提交仍由 GenerationCommit 重读候选并复验基线。 */
  readyOutcome(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string,
    report: SceneValidationReport,
    resume: ReadyBoundaryFacts
  ): PassOutcome {
    return {
      kind: 'ready',
      checkpointId: piReviewCheckpointId(execution.operationId, candidateSnapshotId),
      candidateSnapshotId,
      artifactValidation: report,
      step: 'validating',
      attempt: execution.attempt,
      resume
    }
  }

  /**
   * 写前题组的安全等待：没有候选、没有文件写入，题组身份随执行记录持久保存。
   * 回答后由 continueInteraction 在同一操作内首次生成，不再沿用题组前的输入摘要。
   */
  clarificationOutcome(
    execution: SceneGenerationExecution,
    questions: readonly SceneGenerationQuestionVO[]
  ): PassOutcome {
    const checkpointId = piReviewCheckpointId(execution.operationId)
    return {
      kind: 'questions',
      checkpointId,
      interaction: {
        interactionId: this.deps.nextId(),
        checkpointId,
        kind: 'decision',
        message: `本轮需要你先确认 ${questions.length} 个创作决定，确认后会继续生成。`,
        options: [],
        questions,
        allowedReplies: ['answers', 'discard']
      },
      step: 'validating',
      attempt: execution.attempt
    }
  }

  /**
   * 模型主动报告阻塞的安全等待：展示阻塞原因；没有候选时不伪造候选或校验报告，
   * 有候选时保留其修正/审阅身份，作者可修改要求或丢弃。
   */
  blockedOutcome(
    execution: SceneGenerationExecution,
    reason: string,
    candidateSnapshotId: string | undefined,
    candidate: SceneGenerationCandidate | undefined
  ): PassOutcome {
    const checkpointId = piReviewCheckpointId(execution.operationId, candidateSnapshotId)
    const report = candidateSnapshotId
      ? validationReportOf(candidate?.preview.validationReport ?? execution.artifactValidation)
      : undefined
    return {
      kind: 'blocked',
      checkpointId,
      ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
      interaction: {
        interactionId: this.deps.nextId(),
        checkpointId,
        kind: 'correction',
        message: reason,
        options: [],
        allowedReplies: ['revise', 'discard'],
        ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId })
      },
      ...(report === undefined ? {} : { artifactValidation: report }),
      step: candidateSnapshotId === undefined ? 'validating' : 'correcting',
      attempt: execution.attempt
    }
  }

  correctionOutcome(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string | undefined,
    candidate: SceneGenerationCandidate | undefined,
    reason: string,
    inherited?: SceneValidationReport
  ): PassOutcome {
    if (!candidateSnapshotId) {
      // 没有候选时无法绑定审阅；保留为安全暂停，不伪造候选。
      return this.interrupted(execution, undefined)
    }
    // 上一轮的真实诊断必须沿用；缺失报告不能当成“没有问题”。
    const report = validationReportOf(
      inherited ?? candidate?.preview.validationReport ?? execution.artifactValidation
    )
    const messages = (report?.issues ?? [])
      .flatMap((issue) => {
        const message = safeSceneValidationIssueMessage(issue.code)
        if (!message) return []
        const location =
          issue.line === undefined
            ? issue.sequence === undefined
              ? ''
              : `第 ${issue.sequence + 1} 条语句：`
            : `第 ${issue.line} 行：`
        return [`${location}${message}`]
      })
      .slice(0, 4)
    const checkpointId = piReviewCheckpointId(execution.operationId, candidateSnapshotId)
    return {
      kind: 'waiting',
      checkpointId,
      candidateSnapshotId,
      interaction: {
        interactionId: this.deps.nextId(),
        checkpointId,
        kind: 'correction',
        message:
          `候选还不能进入预览。${reason}` +
          (messages.length === 0 ? '' : `\n${messages.join('\n')}`) +
          '\n请说明要如何修正，或丢弃本次候选。',
        options: [],
        allowedReplies: ['revise', 'discard'],
        candidateSnapshotId
      },
      ...(report === undefined ? {} : { artifactValidation: report }),
      step: 'correcting',
      attempt: execution.attempt
    }
  }

  interrupted(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string | undefined
  ): PassOutcome {
    return {
      kind: 'interrupted',
      checkpointId: piReviewCheckpointId(execution.operationId, candidateSnapshotId),
      ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId }),
      attempt: execution.attempt
    }
  }
}
