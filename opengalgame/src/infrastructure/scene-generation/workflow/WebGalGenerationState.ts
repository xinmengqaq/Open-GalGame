import { Annotation } from '@langchain/langgraph'
import type {
  SceneGenerationExecution,
  SceneGenerationCandidate
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationQuestionVO } from '@application/scene-generation/vo/SceneGenerationVO'
import type {
  FailureClass,
  RunFailureReason,
  RunOutcome
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import type { WebGalSceneMemoryMessage } from '../agents/WebGalSceneAgentTypes'

export const WebGalGenerationState = Annotation.Root({
  execution: Annotation<SceneGenerationExecution>(),
  mode: Annotation<'generate' | 'repair' | 'validate' | 'finalize'>(),
  /** 本次节点产出的路由事实。旧检查点没有该字段时按节点返回或状态兜底。 */
  outcome: Annotation<RunOutcome | undefined>(),
  /** 技术失败后的自动重试次数，只用于退避与观测，不单独决定失败。旧检查点按 0 处理。 */
  retryCount: Annotation<number>(),
  /** 收尾提交的次数，用于区分同一修正轮内的收尾副作用。旧检查点按 0 处理。 */
  finalizeCount: Annotation<number>(),
  /** 校验要求回到修正节点，由路由读取。 */
  repairRequested: Annotation<boolean>(),
  blockedReason: Annotation<string | undefined>(),
  failureClass: Annotation<FailureClass | undefined>(),
  failureReason: Annotation<RunFailureReason | undefined>(),
  failureMessage: Annotation<string | undefined>(),
  /** 权威候选集合，供收尾提交与修正判断。 */
  writtenFiles: Annotation<readonly string[]>(),
  candidate: Annotation<SceneGenerationCandidate | undefined>(),
  summary: Annotation<string>(),
  unresolvedIssues: Annotation<readonly string[]>(),
  memoryMessages: Annotation<readonly WebGalSceneMemoryMessage[]>(),
  confirmedReplies: Annotation<readonly ReplySceneGenerationInteractionDTO[]>(),
  questions: Annotation<readonly SceneGenerationQuestionVO[]>(),
  status: Annotation<'working' | 'ready' | 'waiting' | 'paused' | 'failed'>(),
  needsDecision: Annotation<boolean>(),
  correctableIssueKey: Annotation<string | undefined>(),
  /** 完成摘要由系统补齐。校验后直接审阅，不进入图级自动修正。 */
  summaryDegraded: Annotation<boolean | undefined>(),
  compatibility: Annotation<{ version: 1; engine: string; parser: string }>()
})
export type WebGalGenerationStateValue = typeof WebGalGenerationState.State
