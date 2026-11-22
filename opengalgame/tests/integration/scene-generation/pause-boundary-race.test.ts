import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { readPauseBoundary } from '@infrastructure/scene-generation/pi/PiPauseBoundary'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'
import { streamingFetch } from '../ai/streamingFetch'

/**
 * 模型往返已开始、题组/候选审阅尚未返回时提交暂停。
 * 暂停意图写入后不中止模型；释放栅栏让模型正常返回等待边界。
 * 只使用真实 createSceneGeneration 装配与普通 OpenAI-compatible 测试模型，
 * 不替换应用服务或工作流端口。
 */

const questions = [
  {
    prompt: '道别的情绪基调？',
    detail: '决定台词和镜头节奏',
    options: ['克制', '热烈', '惆怅'].map((label) => ({
      label,
      description: `${label}的告别`
    }))
  }
]

type Gate = {
  fetcher: typeof fetch
  reached: Promise<void>
  release: () => void
  agentRequests: () => number
}

function gatedModel(kind: 'questions' | 'review'): Gate {
  const released = Promise.withResolvers<void>()
  const reached = Promise.withResolvers<void>()
  let gateUsed = false
  let agentRequests = 0
  const fetcher = streamingFetch(async (_url, init) => {
    const text = String(init?.body)
    if (text.includes('Context Extraction Assistant')) return summaryResponse()
    const body = JSON.parse(text)
    agentRequests += 1
    const current = agentRequests
    if (!gateUsed) {
      gateUsed = true
      reached.resolve()
      await released.promise
    }
    const call =
      kind === 'questions' && current === 1
        ? { name: 'requestClarification', arguments: { questions } }
        : {
            name: 'writeCandidate',
            arguments: {
              path: 'game/scene/start.txt',
              expectedRevision: expectedRevisionOf(body.messages),
              content: validScript
            }
          }
    return Response.json({
      object: 'chat.completion',
      created: 1,
      model: 'test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call-${kind}-${current}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    })
  })
  return {
    fetcher,
    reached: reached.promise,
    release: () => released.resolve(),
    agentRequests: () => agentRequests
  }
}

function summaryResponse(): Response {
  return Response.json({
    id: 'summary-test',
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '保留车站道别创作摘要。' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  })
}

function expectedRevisionOf(messages: Array<{ role: string; content?: unknown }>): string {
  const facts = messages
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .at(-1)
  const matched = facts?.match(/"revision"\s*:\s*"([^"]+)"/)
  return matched?.[1] ?? 'absent'
}

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

async function effectRecords(
  root: string,
  projectId: string,
  threadId: string,
  operationId: string
): Promise<
  Array<{
    stepId: string
    status: string
    resultDigest?: string
    candidateRevision?: string
  }>
> {
  const directory = join(
    root,
    'state/ai/projects',
    projectId,
    'threads',
    threadId,
    'operations',
    operationId,
    'effects'
  )
  const names = (
    await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  ).filter((name) => name.endsWith('.json'))
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(directory, name), 'utf8')) as {
          stepId: string
          status: string
          resultDigest?: string
          candidateRevision?: string
        }
    )
  )
}

it('模型返回题组前暂停：重开后题组可回答，回答后只完成一次候选写入', async () => {
  const base = await generationFixture()
  const gate = gatedModel('questions')
  const config = {
    ...base.config,
    fetcher: gate.fetcher,
    dispatch: (job: () => Promise<void>) => {
      base.jobs.push(job)
    }
  }
  const app = await createSceneGeneration(config)
  const operation = await app.generation.generateScene(request)

  const job = base.jobs.shift()
  expect(job).toBeDefined()
  const running = job!()
  await gate.reached
  const pauseStatus = await app.control.pauseSceneGeneration(request)
  gate.release()
  await running

  const stored = (await app.ports.executions.readExecution(request))!
  // 暂停请求在真实等待边界前到达：保留可回复的题组等待，不合成无边界暂停。
  expect(pauseStatus.state).toBe('running')
  expect(gate.agentRequests()).toBe(1)
  expect(stored.state).toBe('waiting')
  expect(stored.interruptReason).toBeUndefined()
  expect(stored.pauseRequested).toBe(false)
  expect(stored.interaction?.kind).toBe('decision')
  expect(stored.interaction?.questions).toHaveLength(1)
  expect(stored.checkpointId).toBe(stored.interaction?.checkpointId)
  expect(await readPauseBoundary(base.root + '/state/ai', stored)).toBeNull()

  const reopened = await createSceneGeneration(config)
  const status = await reopened.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('decision')
  const checkpoint = await reopened.ports.history.readCheckpoint({
    projectId: operation.projectId,
    sceneId: operation.sceneId,
    threadId: operation.threadId,
    branchId: operation.branchId,
    checkpointId: stored.checkpointId!
  })
  expect(checkpoint.view.canReply).toBe(true)
  expect(checkpoint.view.canContinue).toBe(false)

  await reopened.generation.replySceneGenerationInteraction({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.checkpointId!,
    candidateSnapshotId: stored.candidateSnapshotId,
    replyId: 'race-answers',
    reply: {
      kind: 'answers',
      answers: stored.interaction!.questions!.map((question) => ({
        questionId: question.questionId,
        optionId: question.options[0].id
      }))
    }
  })
  const replyJob = base.jobs.shift()
  expect(replyJob).toBeDefined()
  await replyJob!()

  const answered = (await reopened.ports.executions.readExecution(request))!
  expect(answered.state).toBe('waiting')
  expect(answered.interaction?.kind).toBe('review')
  expect(answered.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  // 题组一轮加回答后生成一轮，没有因为暂停请求重复调用或重复写入。
  expect(gate.agentRequests()).toBe(2)
  const effects = await effectRecords(
    base.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    status: 'completed',
    candidateRevision: answered.candidateSnapshotId
  })
  expect(effects[0]?.resultDigest).toBeTruthy()
  expect(effects.some((effect) => effect.status !== 'completed')).toBe(false)
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
}, 30000)

it('模型返回可审阅候选前暂停：重开后审阅可接受，接受后只提交一次', async () => {
  const base = await generationFixture()
  const gate = gatedModel('review')
  const config = {
    ...base.config,
    fetcher: gate.fetcher,
    dispatch: (job: () => Promise<void>) => {
      base.jobs.push(job)
    }
  }
  const app = await createSceneGeneration(config)
  const operation = await app.generation.generateScene(request)

  const job = base.jobs.shift()
  expect(job).toBeDefined()
  const running = job!()
  await gate.reached
  const pauseStatus = await app.control.pauseSceneGeneration(request)
  gate.release()
  await running

  const stored = (await app.ports.executions.readExecution(request))!
  expect(pauseStatus.state).toBe('running')
  expect(gate.agentRequests()).toBe(1)
  expect(stored.state).toBe('waiting')
  expect(stored.interruptReason).toBeUndefined()
  expect(stored.pauseRequested).toBe(false)
  expect(stored.interaction?.kind).toBe('review')
  expect(stored.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(stored.checkpointId).toBe(stored.interaction?.checkpointId)
  expect(await readPauseBoundary(base.root + '/state/ai', stored)).toBeNull()

  const reopened = await createSceneGeneration(config)
  const status = await reopened.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  const checkpoint = await reopened.ports.history.readCheckpoint({
    projectId: operation.projectId,
    sceneId: operation.sceneId,
    threadId: operation.threadId,
    branchId: operation.branchId,
    checkpointId: stored.checkpointId!
  })
  expect(checkpoint.view.canReply).toBe(true)
  expect(checkpoint.view.canContinue).toBe(false)

  await reopened.generation.replySceneGenerationInteraction({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.checkpointId!,
    candidateSnapshotId: stored.candidateSnapshotId,
    replyId: 'race-accept',
    reply: { kind: 'accept' }
  })
  const acceptJob = base.jobs.shift()
  expect(acceptJob).toBeDefined()
  await acceptJob!()

  const accepted = (await reopened.ports.executions.readExecution(request))!
  expect(accepted.state).toBe('succeeded')
  expect(accepted.result?.commitId).toBeTruthy()
  // 接受只重读并提交同一候选，不再次调用模型或写入新候选。
  expect(gate.agentRequests()).toBe(1)
  const effects = await effectRecords(
    base.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: 'generate-0',
    status: 'completed',
    candidateRevision: stored.candidateSnapshotId
  })
  expect(effects.some((effect) => effect.status !== 'completed')).toBe(false)
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(validScript)
}, 30000)
