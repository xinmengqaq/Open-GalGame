import { expect, it, vi } from 'vitest'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  ReplySceneGenerationInteractionDTO,
  SceneGenerationQuestionAnswerDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies
} from '@application/scene-generation/services/impl/SceneGenerationCoordinator'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import { QuerySceneGenerationRender } from '@application/scene-generation/services/impl/QuerySceneGenerationRender'
import {
  blockedWriteFixture,
  clarificationAnswerFixture
} from './scene-generation-clarification-fixture'
import { generationFixture, request } from '../../../../harness/acceptance/support/generationFixture'

function question(index: number): {
  prompt: string
  detail: string
  options: { label: string; description: string }[]
} {
  return {
    prompt: `写前第 ${index} 个创作问题`,
    detail: `写前需要决定第 ${index} 项`,
    options: [1, 2, 3].map((option) => ({
      label: `问题${index}选项${option}`,
      description: `问题${index}说明${option}`
    }))
  }
}

function answersFor(
  questions: readonly { questionId: string; options: readonly { id: string }[] }[]
): SceneGenerationQuestionAnswerDTO[] {
  return questions.map((item, index) => ({
    questionId: item.questionId,
    optionId: item.options[index % item.options.length].id
  }))
}

function finalizeRequestCount(
  bodies: readonly {
    messages: Array<{ role: string; content?: string }>
  }[]
): number {
  return bodies.filter((body) =>
    body.messages
      .filter((message) => message.role === 'system')
      .some((message) => {
        const text = JSON.stringify(message.content ?? '')
        return text.includes('[运行状态]') && text.includes('阶段：收尾提交')
      })
  ).length
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
    replyId: 'reply-clarify',
    reply: { kind: 'answers', answers }
  }
}

function systemBlock(body: { messages: Array<{ role: string; content?: string }> }): string {
  return body.messages
    .filter((message) => message.role === 'system')
    .map((message) => JSON.stringify(message.content ?? ''))
    .join('\n')
}

function statusBlock(text: string): string {
  const start = text.indexOf('[运行状态]')
  if (start < 0) throw new Error('请求没有运行状态')
  return text.slice(start)
}

/** Pi 把提示字符串包成文本块；只拼接文本块，不解释其他类型。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
        ? [block.text]
        : []
    )
    .join('')
}

function agentFacts(
  bodies: readonly { messages: Array<{ role: string; content?: string }> }[]
): Array<Record<string, unknown>> {
  return bodies.flatMap((body) =>
    body.messages.flatMap((message) => {
      if (message.role !== 'user') return []
      try {
        const parsed: unknown = JSON.parse(contentText(message.content))
        return parsed !== null && typeof parsed === 'object' && 'mode' in parsed
          ? [parsed as Record<string, unknown>]
          : []
      } catch {
        return []
      }
    })
  )
}

it('写前提问先停在决定边界，回答后继续生成并只在审阅处等待', async () => {
  const f = await clarificationAnswerFixture([question(1)])
  const baseline = f.git('rev-parse', 'HEAD')
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()

  const first = await f.app.status.getSceneGenerationStatus(request)
  expect(first.state).toBe('waiting')
  expect(first.interaction?.kind).toBe('decision')
  expect(first.interaction?.questions).toHaveLength(1)
  expect(first.candidateSnapshotId).toBeUndefined()
  expect(f.git('rev-parse', 'HEAD')).toBe(baseline)

  const stored = (await f.app.ports.executions.readExecution(request))!
  await f.app.generation.replySceneGenerationInteraction(
    answerReply(stored, answersFor(stored.interaction!.questions!))
  )
  await f.run()

  const review = await f.app.status.getSceneGenerationStatus(request)
  expect(review.state).toBe('waiting')
  expect(review.interaction?.kind).toBe('review')
  expect(review.candidateSnapshotId).toBeTruthy()
  const reviewed = (await f.app.ports.executions.readExecution(request))!
  const candidate = await f.app.ports.artifacts.readCandidate(reviewed, review.candidateSnapshotId!)
  expect(candidate.candidateSnapshotId).toBe(review.candidateSnapshotId)

  const answeredFacts = agentFacts(f.bodies).filter(
    (facts) =>
      facts.mode === 'generate' &&
      Array.isArray(facts.acceptedReplies) &&
      facts.acceptedReplies.length > 0
  )
  expect(answeredFacts.length).toBeGreaterThan(0)
  const accepted = answeredFacts.at(-1)?.acceptedReplies as Array<{
    reply: { kind: string }
    selections?: Array<Record<string, unknown>>
  }>
  expect(accepted[0]?.reply.kind).toBe('answers')
  expect(accepted[0]?.selections).toEqual([
    expect.objectContaining({
      questionId: 'q1',
      prompt: '写前第 1 个创作问题',
      optionId: 'q1o1',
      label: '问题1选项1',
      description: '问题1说明1'
    })
  ])
})

it('主动报告阻塞时等待修正并展示阻塞原因，不产生候选', async () => {
  const f = await blockedWriteFixture('缺少告别后去向的要求')
  await f.app.generation.generateScene(request)
  await f.run()

  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('correction')
  expect(status.interaction?.message).toContain('缺少告别后去向的要求')
  expect(status.candidateSnapshotId).toBeUndefined()
  expect(status.failure).toBeUndefined()
  const execution = await f.app.ports.executions.readExecution(request)
  expect(execution?.failure).toBeUndefined()
})

it('写出后收尾优先于提问选项，按终态动作进入审阅而不是再次提问', async () => {
  const f = await generationFixture({
    repeatReadBeforeWrite: 1,
    postWriteResponses: 3,
    clarifyForWrite: (writes) => (writes === 0 ? undefined : [question(2)])
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()

  const review = await f.app.status.getSceneGenerationStatus(request)
  expect(finalizeRequestCount(f.bodies)).toBe(0)
  expect(review.state).toBe('waiting')
  expect(review.interaction?.kind).toBe('review')
  expect(review.interaction?.message).not.toContain('完成摘要未生成')
  expect(review.candidateSnapshotId).toBeTruthy()
})

it('写出后收尾优先于阻塞选项，按终态动作进入审阅而不是等待修正', async () => {
  const f = await generationFixture({
    repeatReadBeforeWrite: 1,
    postWriteResponses: 3,
    blockForWrite: (writes) => (writes === 0 ? undefined : '写出后不应报告的阻塞')
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()

  const review = await f.app.status.getSceneGenerationStatus(request)
  expect(finalizeRequestCount(f.bodies)).toBe(0)
  expect(review.state).toBe('waiting')
  expect(review.interaction?.kind).toBe('review')
  expect(review.interaction?.message).not.toContain('写出后不应报告的阻塞')
  expect(review.interaction?.message).not.toContain('完成摘要未生成')
  expect(review.candidateSnapshotId).toBeTruthy()
})

it('候选已写出时写后状态块列出权威路径，不显示未写出', async () => {
  // Pi 写入后本轮立即结束；下一次模型往返只由自动修正开启，用它验证写后状态。
  const f = await generationFixture({
    repair: true,
    repeatReadBeforeWrite: 1
  })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()

  const writeBodies = f.bodies.filter((body) => systemBlock(body).includes('阶段：撰写候选'))
  expect(writeBodies.length).toBeGreaterThan(0)
  const block = statusBlock(systemBlock(writeBodies.at(-1)!))
  expect(block).toContain('候选：game/scene/start.txt')
  expect(block).not.toContain('候选：未写出')
  expect(finalizeRequestCount(f.bodies)).toBe(0)
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.candidateSnapshotId).toBeTruthy()
})

it('修正状态块列出已有权威候选，不因本轮账本重新开始而显示未写出', async () => {
  const f = await generationFixture({ repair: true })
  await f.app.generation.generateScene(request)
  await f.run()

  const repairBodies = f.bodies.filter((body) =>
    body.messages.some(
      (message) =>
        message.role === 'user' && contentText(message.content).includes('"mode":"repair"')
    )
  )
  expect(repairBodies.length).toBeGreaterThan(0)
  const blocks = repairBodies.map((body) => statusBlock(systemBlock(body)))
  for (const block of blocks) {
    expect(block).toContain('候选：game/scene/start.txt')
    expect(block).not.toContain('候选：未写出')
  }
  expect(blocks[0]).toContain('本轮尚未写入：先改写候选')
  expect(blocks[0]).not.toContain('提交或报告阻塞')
  // Pi 写入后本轮立即结束，由宿主读回、校验并进入审阅；不存在旧的收尾模型往返。
  expect(finalizeRequestCount(f.bodies)).toBe(0)
  const finalStatus = await f.app.status.getSceneGenerationStatus(request)
  expect(finalStatus.state).toBe('waiting')
  expect(finalStatus.interaction?.kind).toBe('review')
  expect(finalStatus.candidateSnapshotId).toBeTruthy()
  expect(f.writes()).toBe(2)
})

it.each([401, 403] as const)(
  '鉴权失败（%i）结束为可路由失败，公开状态只暴露安全分类和动作',
  async (authStatusCode) => {
    const f = await generationFixture({ authStatusCode })
    await f.app.generation.generateScene(request)
    await expect(f.run()).rejects.toThrow()

    const status = await f.app.status.getSceneGenerationStatus(request)
    expect(status.state).toBe('failed')
    expect(status.failure?.code).toBe(4102)
    const publicFailure = status.failure!
    expect(publicFailure.failureClass).toBe('modelAuth')
    expect(publicFailure.nextActions?.length).toBeGreaterThan(0)
    expect('category' in publicFailure).toBe(false)
    expect('httpStatus' in publicFailure).toBe(false)
    expect('causeName' in publicFailure).toBe(false)

    const execution = await f.app.ports.executions.readExecution(request)
    expect(execution?.failure?.failureClass).toBe('modelAuth')
    expect(execution?.failure?.nextActions?.length).toBeGreaterThan(0)
  }
)

it('运行中操作在历史为空时仍可读取最近一次生成，取消后转为已取消', async () => {
  const f = await generationFixture({ pauseUntilAbort: true })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  const job = f.run()

  const dependencies: SceneGenerationDependencies = {
    domain: new SceneGenerationDomainServiceImpl(),
    input: f.app.ports.input,
    executions: f.app.ports.executions,
    workspace: f.app.ports.workspace,
    artifacts: f.app.ports.artifacts,
    versions: f.app.ports.versions,
    writeRecovery: {
      recoverCandidateWrite: async () => ({ outcome: 'notApplicable' as const })
    },
    workflow: f.app.ports.workflow,
    history: f.app.ports.history,
    memory: f.app.ports.memory,
    nextId: () => 'unused',
    now: () => Date.now(),
    dispatch: () => undefined,
    publishProgress: () => undefined
  }
  const coordinator = new SceneGenerationCoordinator(dependencies)
  const renderQuery = new QuerySceneGenerationRender(dependencies, coordinator)
  const scope = { projectId: request.projectId, sceneId: request.sceneId }

  await vi.waitFor(async () => {
    const stored = await f.app.ports.executions.readExecution(request)
    expect(stored?.state).toBe('running')
  })

  const running = await renderQuery.findLatestSceneGeneration(scope)
  expect(running).not.toBeNull()
  expect(running).toMatchObject({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: request.operationId,
    state: 'running',
    canCancel: true
  })
  expect(running?.checkpointId).toBeUndefined()
  expect(await f.app.history.listSceneGenerationHistoryForScene({ ...scope, limit: 1 })).toEqual([])

  const stored = (await f.app.ports.executions.readExecution(request))!
  await f.app.generation.cancelSceneGeneration({
    ...scope,
    operationId: stored.operationId
  })
  await job.catch(() => undefined)

  await vi.waitFor(async () => {
    const cancelled = await f.app.ports.executions.readExecution(request)
    expect(cancelled?.state).toBe('cancelled')
  })

  const cancelled = await renderQuery.findLatestSceneGeneration(scope)
  expect(cancelled).toMatchObject({
    operationId: request.operationId,
    state: 'cancelled',
    canCancel: false
  })
  const historyAfterCancel = await f.app.history.listSceneGenerationHistoryForScene({
    ...scope,
    limit: 1
  })
  expect(historyAfterCancel.map((item) => item.boundary)).toEqual(['cancelled'])
  expect(historyAfterCancel[0]).toMatchObject({
    operationId: request.operationId,
    stage: 'cancelled'
  })
})
