import type { AgentExecutionOverride } from '@infrastructure/ai/config/agentExecutionConfig'
import type { PiAgentExecutor } from '@infrastructure/ai/pi/PiAgentExecutor'
import type { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { FileSkillLoader } from '@infrastructure/ai/skills/FileSkillLoader'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type { SceneVersionGateway } from '@application/scene-generation/ports/SceneVersionGateway'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationRuntime
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationForkSourceEvidence } from '@application/scene-generation/ports/SceneGenerationForkSourceEvidence'
import type {
  SceneGenerationInteractionVO,
  SceneGenerationStepVO
} from '@application/scene-generation/vo/SceneGenerationVO'
import type { SceneValidationReport } from '@domain/scene-generation/models/SceneValidationReport'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export interface PiSceneGenerationWorkflowDependencies {
  readonly artifacts: Pick<SceneArtifactGateway, 'readCandidate' | 'saveCandidateRevision'>
  readonly versions: Pick<SceneVersionGateway, 'inspectBaseline'>
  readonly domain: SceneGenerationDomainService
  readonly prompts: FilePromptLoader
  readonly skills: FileSkillLoader
  /** 用户状态根下的生成状态目录；只写副作用意图与结果，不写旧检查点。 */
  readonly stateRoot: string
  /**
   * 可信装配给出的内部执行预算覆盖。只影响本次运行，不进入请求 DTO、IPC 或操作指纹；
   * 省略时沿用 AI 执行配置默认值。
   */
  readonly executionOverride?: AgentExecutionOverride
  readonly createAgent: () => Promise<PiAgentExecutor>
  readonly nextId: () => string
  readonly now?: () => number
  /**
   * 建分叉时捕获的来源证据；重开不再读取来源操作当前检查点。
   * 正式装配指向同一证据存储，未装配时拒绝创建/重开分叉。
   */
  readonly forkSourceEvidence?: SceneGenerationForkSourceEvidence
}

/** 每次实际运行的内部状态；只用于本次方法调用，不进入持久记录。 */
export interface RunState {
  execution: SceneGenerationExecution
  candidate?: SceneGenerationCandidate
  candidateSnapshotId?: string
  /** 本次运行是否真正保存过新候选；模型失败时不能用上一版候选冒充本轮修改完成。 */
  wroteThisRun: boolean
  /**
   * 本次作者回复已由持久写账本证明写入的轮次。重开后的自动修正失败必须按该事实
   * 说明哪一版被保留、哪一步未执行，不能按本进程是否写过猜。
   */
  authorWrite?: {
    readonly kind: 'revise' | 'answers'
    readonly passes: number
  }
  correctionCount: number
  /** 本轮由作者的接受回复开启：自动修正完成即可直接提交，不再要求第二次接受。 */
  reviewAccepted: boolean
  /** 当前业务步骤；节流进度发布也必须沿用，不能写死生成中。 */
  step: SceneGenerationStepVO
  /** 本次运行的合并停止信号；写入后发布审阅前再核对一次。 */
  signal: AbortSignal
  /** 本次运行代次的候选写资格；暂停或结束时撤销，迟到的工具调用不能再落盘。 */
  authority: SceneWriteAuthority
}

/**
 * 可提交结果的暂停边界事实。提交门之前若暂停已受理，应用据持久边界停止；
 * 未暂停时这些事实只用于覆盖旧的暂停边界，不改变正式作品。
 */
export interface ReadyBoundaryFacts {
  /** 已完成的候选写入轮数（下一轮序号）。 */
  readonly pass: number
  readonly firstMode: 'generate' | 'repair'
  readonly mode: 'generate' | 'repair'
  readonly baseCandidateSnapshotId?: string
  /** 接受后自动修正/复核的语义必须跨暂停保留，恢复时不降级成普通审阅。 */
  readonly reviewAccepted: boolean
  /** 暂停期间仍可执行的修改/整组回答；接受由 reviewAccepted 承接。 */
  readonly pendingReplyId?: string
}

/** 从暂停边界续做时恢复的轮次事实；不改变本轮运行身份。 */
export interface ResumePoint {
  readonly pass: number
  readonly mode: 'generate' | 'repair'
  readonly candidateSnapshotId?: string
  readonly previousPass?: { readonly digest: string; readonly signature: string }
}

/**
 * 进程内的候选写资格。暂停先撤销旧运行资格，再接续新代次；
 * 旧运行即使还有迟到的工具回调，也不能再写候选文件。
 */
export class SceneWriteAuthority {
  private revoked = false

  constructor(private readonly operationId: string) {}

  revoke(): void {
    this.revoked = true
  }

  assertActive(): void {
    if (this.revoked)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: `操作 ${this.operationId} 的旧执行已失去候选写入资格`
      })
  }
}

/** 一次工作流入口的运行计划；只影响本次方法调用，不进入持久记录。 */
export interface RunPlan {
  /** 首轮是重新生成还是修改既有候选。 */
  readonly mode: 'generate' | 'repair'
  /** 接受后的自动修正：修正出的候选按已接受处理。 */
  readonly reviewAccepted: boolean
  /** 作者提出修改开启新一轮，修正次数重新计数。 */
  readonly resetCorrections: boolean
  /** 整组回答续跑前，按持久写账本证明已完成的候选写入。 */
  readonly answeredWriteReplay?: CandidateWriteReplay
  /** 安全暂停后的显式继续：按已核对的边界从下一轮接着执行。 */
  readonly resume?: ResumePoint
}

/** 持久写账本可证明的同一回复写入轮次；settlement 只在 started 回执可归属时出现。 */
export interface CandidateWriteReplay {
  readonly passes: number
  readonly candidateSnapshotId?: string
  readonly settlement?: {
    readonly stepId: string
    readonly inputDigest: string
  }
}

export type PassOutcome =
  | {
      readonly kind: 'waiting'
      readonly checkpointId: string
      readonly candidateSnapshotId: string
      readonly interaction: SceneGenerationInteractionVO
      /** 只有真实校验报告才携带；缺失时保持未知，不合成空问题列表。 */
      readonly artifactValidation?: SceneValidationReport
      readonly step: SceneGenerationStepVO
      readonly attempt: number
    }
  | {
      /**
       * 写前题组：没有候选、没有文件写入。
       * 题组只作为本次等待的事实，回答后在同一操作继续生成。
       */
      readonly kind: 'questions'
      readonly checkpointId: string
      readonly interaction: SceneGenerationInteractionVO
      readonly step: SceneGenerationStepVO
      readonly attempt: number
    }
  | {
      /**
       * 模型明确报告阻塞：等待作者修改要求或丢弃；没有写入时不伪造候选。
       * 有候选时携带同样的修正身份，允许按候选继续。
       */
      readonly kind: 'blocked'
      readonly checkpointId: string
      readonly candidateSnapshotId?: string
      readonly interaction: SceneGenerationInteractionVO
      readonly artifactValidation?: SceneValidationReport
      readonly step: SceneGenerationStepVO
      readonly attempt: number
    }
  | {
      readonly kind: 'ready'
      readonly checkpointId: string
      readonly candidateSnapshotId: string
      readonly artifactValidation: SceneValidationReport
      readonly step: SceneGenerationStepVO
      readonly attempt: number
      /** 提交门之前优先接受暂停所需的事实；正式作品尚未写入。 */
      readonly resume: ReadyBoundaryFacts
    }
  | {
      readonly kind: 'interrupted'
      readonly checkpointId: string
      readonly candidateSnapshotId?: string
      readonly step?: SceneGenerationStepVO
      readonly attempt: number
    }

/**
 * 同一工作流实例的活动操作、暂停意图和写资格。运行、恢复和暂停共用这一份事实，
 * 不让协作模块各自保存另一套内存状态。
 */
export class PiSceneExecutionRegistry {
  private readonly pauseRequests = new Set<string>()
  private readonly activeOperations = new Set<string>()
  private readonly writeAuthorities = new Map<string, SceneWriteAuthority>()

  /** 新代次开始即撤销上一代次写资格；返回本次运行的资格。 */
  beginRun(operationId: string): SceneWriteAuthority {
    this.writeAuthorities.get(operationId)?.revoke()
    const authority = new SceneWriteAuthority(operationId)
    this.writeAuthorities.set(operationId, authority)
    this.activeOperations.add(operationId)
    return authority
  }

  endRun(operationId: string, authority: SceneWriteAuthority): void {
    this.activeOperations.delete(operationId)
    this.pauseRequests.delete(operationId)
    authority.revoke()
    if (this.writeAuthorities.get(operationId) === authority)
      this.writeAuthorities.delete(operationId)
  }

  /** 没有活动运行时不伪造暂停意图；有运行时只记录给安全检查点消费。 */
  requestPause(operationId: string): void {
    if (!this.activeOperations.has(operationId)) return
    this.pauseRequests.add(operationId)
  }

  /** 内存暂停意图或持久暂停事实任一存在即停；等待边界会消费持久请求。 */
  pauseRequested(runtime: SceneGenerationRuntime, state: RunState): boolean {
    return (
      this.pauseRequests.has(runtime.execution.operationId) ||
      runtime.execution.pauseRequested === true ||
      state.execution.pauseRequested === true
    )
  }
}
