import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { WebGalSceneAgentImpl } from '@infrastructure/scene-generation/agents/WebGalSceneAgentImpl'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { WebGalGenerationCheckpointSaver } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  generationFixture,
  request
} from '../../../../harness/acceptance/support/generationFixture'

it('业务智能体实际压缩历史后仍保留当前授权、素材、诊断与已确认要求', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    execution.candidateSnapshotId!
  )
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(f.config.loadSettings, f.config.fetcher),
    new FilePromptLoader(f.config.promptRoot)
  )
  const agent = await factory.create(WebGalSceneAgentImpl, {
    override: { contextInputBudgetTokens: 14000, technicalRetryCount: 0 }
  })
  const start = f.bodies.length
  const output = await agent.invoke(
    {
      mode: 'repair',
      execution,
      candidate,
      confirmedReplies: [
        {
          ...request,
          interactionId: 'confirmed',
          replyId: 'keep-rule',
          reply: { kind: 'revise', body: '确认学生各自回家，不增加其他场景。' }
        }
      ],
      memoryMessages: [
        { id: 'old-long', role: 'user', content: '过去的车站创作讨论。'.repeat(12000) },
        { id: 'old-answer', role: 'assistant', content: '旧轮次结束。' },
        { id: 'later', role: 'user', content: '继续当前场景。' }
      ]
    },
    {
      identity: { executionId: 'compression-test' },
      scope: { threadId: langGraphThreadKey(execution) },
      context: {
        budget: new ExecutionBudget({ modelAttempts: 24, toolCalls: 32, activeMs: 60000 }),
        workspace: {
          root: execution.workspace!.rootDirectory,
          writable: true,
          writablePaths: ['game/scene/start.txt']
        }
      }
    }
  )
  const requests = f.bodies.slice(start).map((body) => JSON.stringify(body.messages))
  expect(requests.some((body) => body.includes('Context Extraction Assistant'))).toBe(true)
  const formal = requests.filter((body) => !body.includes('Context Extraction Assistant'))
  for (const body of formal) {
    expect(body).toContain('确认学生各自回家')
    expect(body).toContain('station.svg')
    expect(body).toContain('writablePaths')
    expect(body).toContain('diagnostics')
    expect(body).toContain('4.6.5')
  }
  expect(
    output.memoryMessages.some((message) => message.content.includes('保留车站道别创作摘要'))
  ).toBe(true)
  const revision = await f.app.ports.artifacts.saveCandidateRevision(execution)
  expect(
    (await f.app.ports.artifacts.readCandidate(execution, revision.candidateSnapshotId)).preview
      .validationReport.issues
  ).toEqual([])
})

it('实际业务检查点版本不兼容时历史和恢复共同拒绝继续', async () => {
  const f = await generationFixture()
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const saver = new WebGalGenerationCheckpointSaver(stateRoot)
  const graph = createWebGalGenerationGraph({ stateRoot, saver, artifacts: f.app.ports.artifacts })
  const config = await graph.updateState(
    { configurable: { thread_id: langGraphThreadKey(execution) } },
    {
      compatibility: { version: 1, engine: '0.0.0', parser: '0.0.0' }
    }
  )
  const checkpointId = String(config.configurable!.checkpoint_id)
  const checkpoint = await f.app.history.readSceneGenerationCheckpoint({
    ...operation,
    checkpointId
  })
  expect(checkpoint.canContinue).toBe(false)
  expect(checkpoint.reason).toContain('不兼容')
  const count = f.bodies.length
  await f.app.ports.executions.writeExecution({ ...execution, state: 'interrupted', checkpointId })
  await expect(
    f.app.ports.workflow.resumeGeneration({
      execution: { ...execution, checkpointId },
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: async (progress) => ({ ...execution, ...progress }),
      recordCandidateRevision: async (revision) => ({
        ...execution,
        candidateSnapshotId: revision.candidateSnapshotId
      }),
      recordFailure: async (failure) => ({
        ...execution,
        failure
      })
    })
  ).rejects.toThrow('不兼容')
  expect(f.bodies).toHaveLength(count)
  expect(
    new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(execution).rootDirectory
  ).toBe(execution.workspace!.rootDirectory)
})
