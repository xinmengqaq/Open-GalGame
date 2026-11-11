import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isInterrupted } from '@langchain/langgraph'
import { expect, it } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  ReplySceneGenerationInteractionDTO,
  SceneGenerationQuestionAnswerDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import {
  WebGalGenerationCheckpointSaver,
  webGalGenerationCompatibility
} from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import {
  createWebGalGenerationGraph,
  generationInteraction
} from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'

function question(index: number): {
  prompt: string
  detail: string
  options: { label: string; description: string }[]
} {
  return {
    prompt: `第 ${index} 个创作问题`,
    detail: `需要决定第 ${index} 项`,
    options: [1, 2, 3].map((option) => ({
      label: `问题${index}选项${option}`,
      description: `问题${index}说明${option}`
    }))
  }
}

function answersFor(
  questions: readonly { questionId: string; options: readonly { id: string }[] }[]
): { questionId: string; optionId: string; body?: string }[] {
  return questions.map((item, index) => ({
    questionId: item.questionId,
    optionId: item.options[index % item.options.length].id,
    ...(index === 0 ? { body: ' 保留补充 ' } : {})
  }))
}

it('真实图在写前提问的安全边界暂停，恢复后仍保已接受答案，审阅前不提交', async () => {
  // D2：每个操作最多一轮写前提问；回答后直接写候选，不再产生第二组题。
  let clarifications = 0
  const fixture = await generationFixture({
    clarifyForWrite: () => (clarifications++ === 0 ? fourQuestions() : undefined)
  })
  const baseline = fixture.git('rev-parse', 'HEAD')
  await fixture.app.generation.generateScene({ ...request, reviewCandidate: true })
  await fixture.run()
  const first = await fixture.app.status.getSceneGenerationStatus(request)
  expect(first.state).toBe('waiting')
  expect(first.interaction?.kind).toBe('decision')
  expect(first.interaction?.questions).toHaveLength(4)

  const restarted = await createSceneGeneration(fixture.config)
  const stored = await restarted.ports.executions.readExecution(request)
  expect(stored?.interaction?.questions).toHaveLength(4)
  const reply = {
    projectId: stored!.projectId,
    sceneId: stored!.sceneId,
    operationId: stored!.operationId,
    threadId: stored!.threadId,
    branchId: stored!.branchId,
    interactionId: stored!.interaction!.interactionId,
    checkpointId: stored!.interaction!.checkpointId,
    candidateSnapshotId: stored!.interaction!.candidateSnapshotId,
    replyId: 'reply-1',
    reply: { kind: 'answers' as const, answers: answersFor(stored!.interaction!.questions!) }
  }
  await restarted.generation.replySceneGenerationInteraction(reply)
  await restarted.ports.workflow.requestPauseAtSafeCheckpoint({
    ...stored!,
    pauseRequested: true
  })
  await fixture.run()

  const pausedExecution = await restarted.ports.executions.readExecution(request)
  expect(pausedExecution?.state).toBe('interrupted')
  expect(pausedExecution?.interruptReason).toBe('paused')
  expect(pausedExecution?.replies[0]?.selections?.[0]?.prompt).toContain('第 1 个')
  expect(fixture.git('rev-parse', 'HEAD')).toBe(baseline)

  await restarted.generation.resumeAuthorizedPause(request)
  await fixture.run()
  const resumed = await restarted.ports.executions.readExecution(request)
  expect(resumed?.state).toBe('waiting')
  expect(resumed?.interaction?.kind).toBe('review')
  expect(resumed?.interaction?.questions ?? []).toEqual([])
  expect(toRenderStatusVO(resumed!).answeredQuestions).toHaveLength(4)
  await expect(
    restarted.generation.replySceneGenerationInteraction({
      ...reply,
      replyId: 'reply-old'
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(fixture.git('rev-parse', 'HEAD')).toBe(baseline)
})

it('阻断说明与题组同轮时只问写前整组，回答后不再产生题组', async () => {
  let clarifications = 0
  const fixture = await generationFixture({
    unresolved: true,
    clarifyForWrite: () => (clarifications++ === 0 ? fourQuestions() : undefined)
  })
  const baseline = fixture.git('rev-parse', 'HEAD')
  await fixture.app.generation.generateScene({ ...request, reviewCandidate: true })
  await fixture.run()
  const first = await fixture.app.status.getSceneGenerationStatus(request)
  expect(first.state).toBe('waiting')
  expect(first.interaction?.kind).toBe('decision')
  expect(first.interaction?.questions?.map((item) => item.prompt)).toEqual(
    fourQuestions().map((item) => item.prompt)
  )
  const stored = (await fixture.app.ports.executions.readExecution(request))!
  const reply = answerReply(stored, [...answersFor(stored.interaction!.questions!)].reverse())
  await fixture.app.generation.replySceneGenerationInteraction(reply)
  await fixture.run()
  const consumed = (await fixture.app.ports.executions.readExecution(request))!
  expect(consumed.state).toBe('waiting')
  // 候选写出后的冲突只进入 unresolvedIssues，不再形成新题组或决定边界。
  expect(consumed.interaction?.kind).toBe('clarification')
  expect(consumed.interaction?.questions ?? []).toEqual([])
  expect(consumed.replies).toHaveLength(1)
  expect(consumed.replies[0]?.selections?.map((item) => item.questionId)).toEqual(
    first.interaction!.questions!.map((item) => item.questionId)
  )
  await expect(
    fixture.app.generation.replySceneGenerationInteraction(reply)
  ).resolves.toMatchObject({ replyId: reply.replyId, accepted: true })
  expect((await fixture.app.ports.executions.readExecution(request))?.replies).toHaveLength(1)
  expect(fixture.git('rev-parse', 'HEAD')).toBe(baseline)
})

it('必须人工取舍与题组同轮时仍先问整组，回答后不失败', async () => {
  const choice = '留下:stay|离开:leave'
  let clarifications = 0
  const fixture = await generationFixture({
    scriptForWrite: () => validScript.replace('end;', `choose:${choice};\nend;`),
    clarifyForWrite: () => (clarifications++ === 0 ? fourQuestions() : undefined)
  })
  const baseline = fixture.git('rev-parse', 'HEAD')
  await fixture.app.generation.generateScene({
    ...request,
    reviewCandidate: true,
    inputs: {
      ...request.inputs,
      confirmedControls: [{ kind: 'option', content: choice, inputId: 'story' }]
    }
  })
  await fixture.run()
  const first = await fixture.app.status.getSceneGenerationStatus(request)
  expect(first.state).toBe('waiting')
  expect(first.interaction?.kind).toBe('decision')
  expect(first.interaction?.allowedReplies).toContain('answers')
  const stored = (await fixture.app.ports.executions.readExecution(request))!
  const reply = answerReply(stored, [...answersFor(stored.interaction!.questions!)].reverse())
  await fixture.app.generation.replySceneGenerationInteraction(reply)
  await fixture.run()
  const consumed = (await fixture.app.ports.executions.readExecution(request))!
  expect(consumed.state).not.toBe('failed')
  expect(consumed.replies[0]?.selections?.map((item) => item.questionId)).toEqual(
    stored.interaction!.questions!.map((item) => item.questionId)
  )
  await expect(
    fixture.app.generation.replySceneGenerationInteraction(reply)
  ).resolves.toMatchObject({ replyId: reply.replyId, accepted: true })
  expect(fixture.git('rev-parse', 'HEAD')).toBe(baseline)
})

it('副作用完成后、图检查点写入前恢复按候选进入审阅，且不重调模型', async () => {
  const fixture = await generationFixture({
    questionsForWrite: () => fourQuestions()
  })
  const baseline = fixture.git('rev-parse', 'HEAD')
  await fixture.app.generation.generateScene({ ...request, reviewCandidate: true })
  await fixture.run()
  const stored = (await fixture.app.ports.executions.readExecution(request))!
  const callsBefore = fixture.bodies.length
  const recovered = await replayCompletedWrite(fixture, stored)
  expect(isInterrupted(recovered.result)).toBe(true)
  expect(recovered.calls).toBe(0)
  // 候选写出后的完成记录不再带题组；恢复也不形成决定边界。
  expect(recovered.state.values.questions ?? []).toEqual([])
  expect(generationInteraction(recovered.state.values, 'recovered').kind).toBe('review')
  expect(fixture.bodies).toHaveLength(callsBefore)
  expect(fixture.git('rev-parse', 'HEAD')).toBe(baseline)
})

it('完成结果没有题组事实时恢复不补造题目，也不重调模型', async () => {
  const fixture = await generationFixture({
    questionsForWrite: () => fourQuestions()
  })
  const baseline = fixture.git('rev-parse', 'HEAD')
  await fixture.app.generation.generateScene({ ...request, reviewCandidate: true })
  await fixture.run()
  const stored = (await fixture.app.ports.executions.readExecution(request))!
  const callsBefore = fixture.bodies.length
  await forgetStoredQuestions(fixture, stored)
  const recovered = await replayCompletedWrite(fixture, stored)
  expect(isInterrupted(recovered.result)).toBe(true)
  expect(recovered.calls).toBe(0)
  expect(recovered.state.values.questions ?? []).toEqual([])
  expect(generationInteraction(recovered.state.values, 'recovered').kind).toBe('review')
  expect(fixture.bodies).toHaveLength(callsBefore)
  expect(fixture.git('rev-parse', 'HEAD')).toBe(baseline)
})

function fourQuestions() {
  return [1, 2, 3, 4].map((index) => question(index))
}

function answerReply(
  execution: SceneGenerationExecution,
  answers: readonly SceneGenerationQuestionAnswerDTO[]
): ReplySceneGenerationInteractionDTO {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    interactionId: execution.interaction!.interactionId,
    checkpointId: execution.interaction!.checkpointId,
    candidateSnapshotId: execution.interaction!.candidateSnapshotId,
    replyId: 'reply-reversed',
    reply: { kind: 'answers', answers }
  }
}

type QuestionRun = {
  config: { userStateRoot: string }
  app: { ports: { artifacts: SceneArtifactGateway } }
}

async function forgetStoredQuestions(
  fixture: QuestionRun,
  execution: SceneGenerationExecution
): Promise<void> {
  const effectsDir = join(
    fixture.config.userStateRoot,
    'ai/projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'operations',
    execution.operationId,
    'effects'
  )
  const names = (await readdir(effectsDir)).filter((name) => name.endsWith('.json'))
  expect(names.length).toBeGreaterThan(0)
  for (const name of names) {
    const path = join(effectsDir, name)
    const effect = JSON.parse(await readFile(path, 'utf8')) as { questions?: unknown }
    delete effect.questions
    await writeFile(path, JSON.stringify(effect))
  }
}

async function replayCompletedWrite(fixture: QuestionRun, execution: SceneGenerationExecution) {
  const stateRoot = join(fixture.config.userStateRoot, 'ai')
  await rm(
    join(
      stateRoot,
      'projects',
      execution.projectId,
      'threads',
      execution.threadId,
      'branches',
      execution.branchId,
      'checkpoints'
    ),
    { recursive: true, force: true }
  )
  let calls = 0
  const replay: SceneGenerationExecution = {
    ...execution,
    candidateSnapshotId: undefined,
    interaction: undefined,
    pendingReply: undefined,
    state: 'running'
  }
  const budget = new ExecutionBudget(
    {
      modelAttempts: Number.MAX_SAFE_INTEGER,
      toolCalls: Number.MAX_SAFE_INTEGER,
      activeMs: Number.MAX_SAFE_INTEGER
    },
    { modelAttempts: 0, toolCalls: 0, activeMs: 0, tokens: 0 }
  )
  const graph = createWebGalGenerationGraph({
    saver: new WebGalGenerationCheckpointSaver(stateRoot),
    stateRoot,
    artifacts: fixture.app.ports.artifacts,
    agent: {
      invoke: () => {
        calls += 1
        throw new Error('模型不应重调')
      }
    },
    budget,
    runtime: {
      execution: replay,
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: async () => replay,
      recordCandidateRevision: async (revision) => ({
        ...replay,
        candidateSnapshotId: revision.candidateSnapshotId
      }),
      recordFailure: async (failure) => ({
        ...replay,
        failure
      })
    }
  })
  const config = {
    configurable: { thread_id: langGraphThreadKey(replay), checkpoint_ns: '' },
    recursionLimit: 20
  }
  const result = await graph.invoke(
    {
      execution: replay,
      mode: 'generate' as const,
      summary: '',
      unresolvedIssues: [],
      memoryMessages: [],
      confirmedReplies: [],
      questions: [],
      status: 'working' as const,
      needsDecision: false,
      correctableIssueKey: '',
      compatibility: webGalGenerationCompatibility()
    },
    config
  )
  return { result, calls, state: await graph.getState(config) }
}
