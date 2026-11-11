import { StateGraph, START, END, interrupt, type CompiledStateGraph } from '@langchain/langgraph'
import { repairContextIssue } from '@application/scene-generation/policies/SceneGenerationRepairContextPolicy'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { WebGalGenerationState, type WebGalGenerationStateValue } from './WebGalGenerationState'
import {
  composeRoute,
  finalizeRoute,
  prepareRoute,
  repairRoute,
  retryRoute,
  RunFailure,
  validateRoute,
  waitForHumanRoute
} from './runFailureRouting'
import { createFinalizeNode } from './graph/finalizeNode'
import {
  createValidateCandidateNode,
  createWriteCandidateNode
} from './graph/candidateWriteAndValidation'
import type { WebGalGenerationGraphDependencies } from './graph/graphDependencies'
import { createRepairNode, createRetryNode } from './graph/repairRetryNodes'
import { settleNode } from './graph/settlement'
import { selectionsCover, waitingKind } from './graph/stateFacts'

export type { WebGalGenerationGraphDependencies } from './graph/graphDependencies'
export { generationInteraction } from './graph/stateFacts'

const NODE_NAMES = [
  'prepare',
  'writeCandidate',
  'validateCandidate',
  'waitForHuman',
  'finalize',
  'repair',
  'retry',
  'settle'
] as const

/** 只构建场景图；运行授权、预算、取消和凭据留在闭包，不序列化进状态。 */
export type WebGalGenerationGraph = CompiledStateGraph<
  WebGalGenerationStateValue,
  typeof WebGalGenerationState.Update,
  '__start__' | (typeof NODE_NAMES)[number],
  typeof WebGalGenerationState.spec,
  typeof WebGalGenerationState.spec
>

function prepareNode(deps: WebGalGenerationGraphDependencies, state: WebGalGenerationStateValue) {
  if (!deps.runtime || !deps.agent || !deps.budget)
    throw new AppException({ code: ErrorCodes.internalError, msg: '只读历史图不能执行生成' })
  const execution = {
    ...state.execution,
    source: deps.runtime.execution.source,
    workspace: deps.runtime.execution.workspace
  }
  if (
    (!execution.workspace && state.mode !== 'generate') ||
    !execution.source.sceneDirectory ||
    !execution.source.entryFile ||
    !execution.inputSnapshot
  )
    throw new RunFailure({
      failureClass: 'inputInvalid',
      message: '输入快照缺少可生成的工作区或来源'
    })
  const repairIssue = repairContextIssue(execution)
  if (repairIssue) throw new RunFailure({ failureClass: 'inputInvalid', message: repairIssue })
  return {}
}

function waitForHumanNode(
  deps: WebGalGenerationGraphDependencies,
  state: WebGalGenerationStateValue
) {
  // 候选一旦存在，题组不再是本次等待的事实；旧检查点里的题组也不再投影。
  const questions = state.execution.candidateSnapshotId ? [] : (state.questions ?? [])
  const kind = waitingKind(state)
  const accepted = interrupt({
    kind,
    candidateSnapshotId: state.execution.candidateSnapshotId
  })
  if (
    typeof accepted !== 'string' ||
    !deps.runtime?.execution.pendingReply ||
    deps.runtime.execution.pendingReply.replyId !== accepted
  )
    throw new AppException({ code: ErrorCodes.operationConflict, msg: '人工回复未可靠接受' })
  const incoming = deps.runtime.execution
  const reply = incoming.pendingReply!.reply
  if (kind === 'decision' && reply.kind !== 'discard') {
    if (
      reply.kind !== 'answers' ||
      !selectionsCover(questions, incoming.pendingReply?.selections)
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '创作回答与当前提问不一致'
      })
    }
  }
  const explanationOnly = reply.kind === 'select' && reply.optionId === 'reviewCandidate'
  const execution = {
    ...state.execution,
    ...incoming,
    reviewCandidate: state.execution.reviewCandidate || incoming.reviewCandidate || explanationOnly
  }
  const confirmedReplies = [
    ...state.confirmedReplies.filter(
      (item) =>
        !execution.replies.some(
          (current) => current.replyId === item.replyId && current.operationId === item.operationId
        )
    ),
    ...execution.replies.map((item) =>
      item.replyId === incoming.pendingReply?.replyId
        ? {
            ...item,
            ...(incoming.pendingReply.selection
              ? { selection: incoming.pendingReply.selection }
              : {}),
            ...(incoming.pendingReply.selections
              ? { selections: incoming.pendingReply.selections }
              : {})
          }
        : item
    )
  ]
  const revise = !explanationOnly && reply.kind !== 'accept'
  const answeredGroup = kind === 'decision' && reply.kind === 'answers'
  const writeFirst = reply.kind === 'answers' && !state.execution.candidateSnapshotId
  const newUserRound =
    reply.kind === 'revise' || reply.kind === 'answers' || reply.kind === 'select'
  return {
    execution: newUserRound
      ? { ...execution, budget: { ...execution.budget, correctionsUsed: 0 } }
      : execution,
    confirmedReplies,
    questions: answeredGroup || (kind === 'decision' && reply.kind === 'discard') ? [] : questions,
    unresolvedIssues: explanationOnly || answeredGroup ? [] : state.unresolvedIssues,
    status: 'working' as const,
    mode: writeFirst ? ('generate' as const) : revise ? ('repair' as const) : ('validate' as const),
    correctableIssueKey: revise ? '' : state.correctableIssueKey,
    blockedReason: undefined,
    repairRequested: false
  }
}

export function createWebGalGenerationGraph(
  deps: WebGalGenerationGraphDependencies
): WebGalGenerationGraph {
  return new StateGraph(WebGalGenerationState)
    .addNode('prepare', (state) => prepareNode(deps, state))
    .addNode('writeCandidate', createWriteCandidateNode(deps))
    .addNode('finalize', createFinalizeNode(deps))
    .addNode('validateCandidate', createValidateCandidateNode(deps))
    .addNode('repair', createRepairNode(deps))
    .addNode('retry', createRetryNode(deps))
    .addNode('waitForHuman', (state) => waitForHumanNode(deps, state))
    .addNode('settle', settleNode())
    .addEdge(START, 'prepare')
    .addConditionalEdges('prepare', prepareRoute, ['writeCandidate', 'validateCandidate', 'settle'])
    .addConditionalEdges('writeCandidate', composeRoute, [
      'validateCandidate',
      'finalize',
      'retry',
      'repair',
      'waitForHuman',
      'settle'
    ])
    .addConditionalEdges('finalize', finalizeRoute, [
      'validateCandidate',
      'repair',
      'waitForHuman',
      'settle'
    ])
    .addConditionalEdges('validateCandidate', validateRoute, {
      repair: 'repair',
      waitForHuman: 'waitForHuman',
      end: END
    })
    .addConditionalEdges('repair', repairRoute, ['writeCandidate', 'waitForHuman'])
    .addConditionalEdges('retry', retryRoute, ['writeCandidate', 'settle'])
    .addConditionalEdges('waitForHuman', waitForHumanRoute, ['writeCandidate', 'validateCandidate'])
    .addEdge('settle', END)
    .compile({ checkpointer: deps.saver })
}
