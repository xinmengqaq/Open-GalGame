import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { writtenFileFacts } from '@infrastructure/ai/execution/writtenFileLedger'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import type { WebGalSceneAgentOutput } from '../../agents/WebGalSceneAgentTypes'
import type { WebGalGenerationStateValue } from '../WebGalGenerationState'
import { classifyRunError, RunFailure } from '../runFailureRouting'
import type { WebGalGenerationGraphDependencies } from './graphDependencies'
import { budgetSnapshot } from './settlement'

export function createFinalizeNode(deps: WebGalGenerationGraphDependencies) {
  return async (state: WebGalGenerationStateValue, config: LangGraphRunnableConfig) => {
    if (!deps.runtime || !deps.agent || !deps.budget)
      throw new AppException({ code: ErrorCodes.internalError, msg: '只读历史图不能执行生成' })
    const runtime = deps.runtime
    const agent = deps.agent
    const budget = deps.budget
    const execution = {
      ...state.execution,
      source: runtime.execution.source,
      workspace: runtime.execution.workspace
    }
    const finalizeCount = (state.finalizeCount ?? 0) + 1
    const candidate =
      state.candidate && state.candidate.candidateSnapshotId === execution.candidateSnapshotId
        ? state.candidate
        : execution.candidateSnapshotId
          ? await deps.artifacts.readCandidate(execution, execution.candidateSnapshotId)
          : undefined
    let output: WebGalSceneAgentOutput | undefined
    let agentError: unknown
    try {
      output = await agent.invoke(
        {
          mode: 'finalize',
          execution,
          candidate,
          summary: state.summary,
          writtenFiles: state.writtenFiles ?? [],
          memoryMessages: state.memoryMessages,
          confirmedReplies: state.confirmedReplies
        },
        {
          identity: { executionId: execution.operationId },
          scope: { threadId: langGraphThreadKey(execution) },
          signal: config.signal,
          context: {
            budget,
            executionMode: 'finalize',
            writtenFiles: state.writtenFiles ?? [],
            ...(deps.agentProgress ? { progress: deps.agentProgress } : {}),
            workspace: {
              root: execution.workspace!.rootDirectory,
              writable: true,
              writablePaths: [`${execution.source.sceneDirectory}/${execution.source.entryFile}`]
            }
          }
        }
      )
      config.signal?.throwIfAborted()
    } catch (error) {
      agentError = error
    }
    const writtenAfter = writtenFileFacts(budget).filter((fact) => fact.path.length > 0)
    const entryPath = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    const entryWritten = writtenAfter.some((fact) => fact.path === entryPath)
    const message = agentError
      ? normalizeAgentError(agentError).message
      : '收尾阶段没有提交可用的结构化候选'
    const classified = agentError ? classifyRunError(agentError, config.signal) : undefined
    // 结构化输出违约在收尾阶段仍是 outputContract，不能重按“无进展”收尾。
    const contractFailure = classified?.failureClass === 'outputContract' ? classified : undefined
    if (!agentError && output) {
      const action = output.action ?? 'submit_scene_result'
      if (action === 'report_blocked') {
        const reason = output.blockedReason ?? '模型报告无法继续'
        return {
          status: 'waiting' as const,
          needsDecision: true,
          questions: [],
          blockedReason: reason,
          finalizeCount,
          outcome: {
            kind: 'blocked' as const,
            reason,
            processable: true as const,
            ...(execution.candidateSnapshotId
              ? { candidateSnapshotId: execution.candidateSnapshotId }
              : {})
          },
          ...(candidate ? { candidate } : {})
        }
      }
      if (action === 'submit_scene_result') {
        if (entryWritten) {
          let revision: { candidateSnapshotId: string }
          try {
            revision = await deps.artifacts.saveCandidateRevision(execution)
          } catch (saveError) {
            throw new AppException({
              code: ErrorCodes.internalError,
              msg: '候选修订保存失败',
              cause: saveError
            })
          }
          const updated = {
            ...execution,
            ...revision,
            attempt: execution.attempt + 1,
            budget: budgetSnapshot(execution, budget),
            step: 'reading' as const
          }
          const read = await deps.artifacts.readCandidate(updated, revision.candidateSnapshotId)
          return {
            status: 'working' as const,
            candidate: read,
            execution: updated,
            finalizeCount,
            writtenFiles: writtenAfter.map((fact) => fact.path),
            outcome: {
              kind: 'candidate' as const,
              candidateSnapshotId: revision.candidateSnapshotId
            }
          }
        }
        if (candidate && execution.candidateSnapshotId)
          return {
            status: 'working' as const,
            candidate,
            execution: {
              ...execution,
              attempt: execution.attempt + 1,
              budget: budgetSnapshot(execution, budget)
            },
            finalizeCount,
            writtenFiles: state.writtenFiles ?? [],
            outcome: {
              kind: 'candidate' as const,
              candidateSnapshotId: execution.candidateSnapshotId
            }
          }
      }
    }
    if (candidate)
      return {
        status: 'working' as const,
        summaryDegraded: true,
        candidate,
        finalizeCount,
        outcome: contractFailure
          ? {
              kind: 'contractError' as const,
              failureClass: 'outputContract' as const,
              reason: contractFailure.reason ?? ('missingStructuredResult' as const),
              message: contractFailure.message,
              candidateSnapshotId: candidate.candidateSnapshotId,
              degraded: true
            }
          : {
              kind: 'contractError' as const,
              failureClass: 'noProgress' as const,
              reason: state.failureReason ?? ('missingStructuredResult' as const),
              message,
              candidateSnapshotId: candidate.candidateSnapshotId,
              degraded: true
            }
      }
    if (agentError) throw agentError
    throw new RunFailure({
      failureClass: 'noProgress',
      reason: 'missingStructuredResult',
      message
    })
  }
}
