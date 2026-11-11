import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import type { GenerateSceneDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { CompletionContractViolation } from '@infrastructure/ai/execution/executionErrors'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import {
  arrangementPath,
  sourceDescriptorPath
} from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { readCommitFiles, resolveRefIfExists } from '@infrastructure/git/objects/gitTree'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import { createSceneGeneration } from '../../../../harness/acceptance/support/sceneGenerationEntry'
import { streamingFetch } from '../ai/streamingFetch'

const request: GenerateSceneDTO = {
  projectId: 'project-test',
  sceneId: 'scene-test',
  operationId: 'operation-test',
  inputs: { canvasId: 'canvas-1', confirmedControls: [] },
  policy: { maxCorrections: 2, maxModelCalls: 24, maxToolCalls: 32, activeTimeoutMs: 60000 }
}
const validScript =
  'changeBg:station.svg;\n林:末班车快到了，我们明天见。;\nsay:车站的灯亮了。 -clear;\nend;'
const SAFE_SUMMARY = '候选已写出；模型完成摘要未生成'
const SAFE_TRADEOFF = '完成摘要未生成，请核对创作取舍'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type ModelBody = {
  messages: Array<{
    role?: string
    content?: string
    tool_calls?: Array<{ function?: { name?: string } }>
  }>
  tools: Array<{ function: { name: string } }>
  response_format?: { type?: string }
}
type DurabilityFixture = {
  app: Awaited<ReturnType<typeof createSceneGeneration>>
  config: { userStateRoot: string }
  bodies: ModelBody[]
  progress: Array<{ phase: string; candidateSnapshotId?: string }>
  run: () => Promise<void>
}

it('摘要缺失但合法入口进入审阅，不再调用模型', async () => {
  const f = await fixture((body) => (wroteEntry(body) ? missingSummary(body) : skillOrWrite(body)))
  const callsBeforeReview = await start(f)
  const status = await f.app.status.getSceneGenerationStatus(request)
  const execution = await executionOf(f)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.message).toContain(SAFE_TRADEOFF)
  expect(status.interaction?.allowedReplies).toEqual(
    expect.arrayContaining(['accept', 'revise', 'discard'])
  )
  expect(status.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(execution.step).not.toBe('correcting')
  expect(execution.budget.correctionsUsed).toBe(0)
  expect(f.bodies).toHaveLength(callsBeforeReview)
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    status.candidateSnapshotId!
  )
  expect(candidate.artifact.statements.some((statement) => statement.command === 'changeBg')).toBe(
    true
  )
  expect(candidate.preview.assetLocations.map((asset) => asset.assetId)).toContain('station')
  expect(candidate.preview.validationReport.issues).toEqual([])
  expect(JSON.stringify(status)).not.toContain('test-secret')
})
it('截断后的无效入口保留修订并进入审阅', async () => {
  const f = await fixture((body) =>
    wroteEntry(body) ? truncated(body) : skillOrWrite(body, 'changeBg:missing.svg;\nend;')
  )
  await start(f)
  const status = await f.app.status.getSceneGenerationStatus(request)
  const execution = await executionOf(f)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.message).toContain(SAFE_TRADEOFF)
  expect(status.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    status.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues).toContainEqual(
    expect.objectContaining({ code: 'missing-asset' })
  )
  expect(f.bodies.filter(wroteEntry)).toHaveLength(1)
})

it('工作区清理后仍能读取已发布修订', async () => {
  const f = await fixture((body) => (wroteEntry(body) ? invalidResult(body) : skillOrWrite(body)))
  await start(f)
  const execution = await executionOf(f)
  const snapshot = execution.candidateSnapshotId!
  await f.app.ports.workspace.discardWorkspace(execution)
  await expect(lstat(workspaceOf(f, execution))).rejects.toMatchObject({ code: 'ENOENT' })
  const gitDir = revisionGitDir(f, execution)
  await expect(
    resolveRefIfExists({ gitdir: gitDir }, `refs/opengalgame/revisions/${snapshot}`)
  ).resolves.toBe(snapshot)
  const files = await readCommitFiles({ gitdir: gitDir }, snapshot)
  expect(
    new TextDecoder().decode(
      files.find((file) => file.relativePath === 'game/scene/start.txt')?.bytes
    )
  ).toBe(validScript)
  expect(files.some((file) => file.relativePath === 'game/scene/start.txt')).toBe(true)
})

it('没有写出文件时不产生空修订', async () => {
  const f = await fixture((body) => truncated(body))
  await expect(start(f)).rejects.toThrow('模型输出不符合约定')
  const execution = await executionOf(f)
  expect(execution.state).toBe('failed')
  expect(execution.failure?.failureClass).toBe('outputContract')
  expect(execution.candidateSnapshotId).toBeUndefined()
  await expect(
    resolveRefIfExists({ gitdir: revisionGitDir(f, execution) }, 'refs/opengalgame/revisions')
  ).resolves.toBeNull()
})

it('取消和普通模型异常只保留真实修订，不进入审阅', async () => {
  let releaseAfterWrite: (() => void) | undefined
  const cancelled = await fixture(async (body) => {
    const wrote = wroteEntry(body)
    const response = skillOrWrite(body)
    if (wrote) releaseAfterWrite?.()
    return response
  })
  await cancelled.app.generation.generateScene({ ...request, reviewCandidate: true })
  const running = cancelled.run()
  await new Promise<void>((resolve) => {
    releaseAfterWrite = resolve
  })
  await cancelled.app.generation.cancelSceneGeneration(request)
  await running
  const cancelledExecution = await executionOf(cancelled)
  expect(cancelledExecution.state).toBe('cancelled')
  expect(cancelledExecution.interaction).toBeUndefined()
  expect(cancelledExecution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  const candidateProgress = cancelled.progress.filter((event) => event.candidateSnapshotId)
  expect(candidateProgress.length).toBeGreaterThan(0)
  expect(cancelled.progress.some((event) => event.phase === 'failed')).toBe(false)
  const effects = await readDurableEffects(
    join(cancelled.config.userStateRoot, 'ai'),
    cancelledExecution
  )
  expect(effects.some((effect) => effect.status === 'started')).toBe(false)
  expect(effects).toContainEqual(
    expect.objectContaining({
      status: 'completed',
      candidateRevision: cancelledExecution.candidateSnapshotId
    })
  )

  const denied = await fixture((body) =>
    wroteEntry(body)
      ? new Response(JSON.stringify({ error: { message: 'unauthorized', type: 'auth' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      : skillOrWrite(body)
  )
  await denied.app.generation.generateScene({
    ...request,
    operationId: 'operation-denied',
    reviewCandidate: true
  })
  await expect(denied.run()).rejects.toThrow('模型鉴权失败')
  const deniedExecution = await executionOf(denied, 'operation-denied')
  expect(deniedExecution.state).toBe('failed')
  expect(deniedExecution.interaction).toBeUndefined()
  expect(deniedExecution.failure?.message).not.toContain(SAFE_SUMMARY)
  expect(deniedExecution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
})

it('写后完成契约失败的合法入口进入审阅', async () => {
  let thrown = false
  const f = await fixture((body) => {
    if (!wroteEntry(body)) return skillOrWrite(body)
    if (!thrown) {
      thrown = true
      throw new CompletionContractViolation()
    }
    return stop('不应再次调用模型')
  })
  await start(f)
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.message).toContain(SAFE_TRADEOFF)
  expect(f.bodies.filter(wroteEntry)).toHaveLength(1)
})

it('入口写出后 length 截断进入审阅，鉴权失败仍不降级', async () => {
  const lengthTruncated = await fixture((body) =>
    wroteEntry(body) ? truncated(body) : skillOrWrite(body)
  )
  const callsBeforeReview = await start(lengthTruncated)
  const status = await lengthTruncated.app.status.getSceneGenerationStatus(request)
  const execution = await executionOf(lengthTruncated)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.message).toContain(SAFE_TRADEOFF)
  expect(status.interaction?.allowedReplies).toEqual(
    expect.arrayContaining(['accept', 'revise', 'discard'])
  )
  expect(execution.step).not.toBe('correcting')
  expect(execution.budget.correctionsUsed).toBe(0)
  expect(execution.state).not.toBe('succeeded')
  expect(lengthTruncated.bodies).toHaveLength(callsBeforeReview)
  expect(lengthTruncated.bodies.filter(wroteEntry)).toHaveLength(1)
  const candidate = await lengthTruncated.app.ports.artifacts.readCandidate(
    execution,
    status.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues).toEqual([])

  const denied = await fixture((body) =>
    wroteEntry(body)
      ? new Response(JSON.stringify({ error: { message: 'unauthorized', type: 'auth' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      : skillOrWrite(body)
  )
  await denied.app.generation.generateScene({
    ...request,
    operationId: 'operation-length-denied',
    reviewCandidate: true
  })
  await expect(denied.run()).rejects.toThrow('模型鉴权失败')
  const deniedExecution = await executionOf(denied, 'operation-length-denied')
  expect(deniedExecution.state).toBe('failed')
  expect(deniedExecution.interaction).toBeUndefined()
  expect(deniedExecution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
})

async function fixture(
  respond: (body: ModelBody, init?: RequestInit) => Response | Promise<Response>
): Promise<DurabilityFixture> {
  const root = await mkdtemp(join(tmpdir(), 'candidate-durability-'))
  roots.push(root)
  const projectRoot = join(root, 'project')
  await writeProject(projectRoot)
  const bodies: ModelBody[] = []
  const progress: Array<{ phase: string; candidateSnapshotId?: string }> = []
  const jobs: Array<() => Promise<void>> = []
  const opengalgameRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const config = {
    userStateRoot: join(root, 'state'),
    promptRoot: resolve(opengalgameRoot, 'resources/ai/prompts'),
    registrations: [
      {
        source: {
          projectId: request.projectId,
          sceneId: request.sceneId,
          projectRoot,
          sceneDirectory: 'game/scene',
          entryFile: 'start.txt'
        }
      }
    ],
    loadSettings: async () => ({
      providerId: 'openai-compatible' as const,
      baseUrl: 'https://test.example/v1',
      model: 'test',
      apiKey: 'test-secret',
      contextWindow: 200000,
      maxOutputTokens: 16000
    }),
    fetcher: streamingFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ModelBody
      bodies.push(body)
      if (String(init?.body).includes('Context Extraction Assistant')) return summaryResponse()
      return respond(body, init)
    }),
    dispatch: (job: () => Promise<void>) => {
      jobs.push(job)
    },
    publishProgress: (event: { phase: string; candidateSnapshotId?: string }) => {
      progress.push(event)
    },
    versioning: new ProjectVersioningApplicationServiceImpl({
      ...createProjectVersioningGateways(join(root, 'state')),
      nextId: () => randomUUID()
    }),
    projects: {
      ensureProjectWorkspace: async () => ({
        projectId: request.projectId,
        sceneId: request.sceneId,
        canvasId: 'canvas-1'
      })
    }
  }
  return {
    app: await createSceneGeneration(config),
    config,
    bodies,
    progress,
    run: async () => {
      const job = jobs.shift()
      if (!job) throw new Error('缺少任务')
      await job()
    }
  }
}

async function start(f: DurabilityFixture): Promise<number> {
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  return f.bodies.length
}

async function executionOf(
  f: DurabilityFixture,
  operationId = request.operationId
): Promise<SceneGenerationExecution> {
  const execution = await f.app.ports.executions.readExecution({ ...request, operationId })
  if (!execution) throw new Error('缺少执行记录')
  return execution
}

function workspaceOf(f: DurabilityFixture, execution: SceneGenerationExecution): string {
  return join(
    f.config.userStateRoot,
    'ai/projects',
    request.projectId,
    'threads',
    execution.threadId,
    'workspaces',
    execution.operationId
  )
}

function revisionGitDir(f: DurabilityFixture, execution: SceneGenerationExecution): string {
  return join(
    f.config.userStateRoot,
    'ai/projects',
    request.projectId,
    'threads',
    execution.threadId,
    'revisions'
  )
}

function skillOrWrite(body: ModelBody, script = validScript): Response {
  if (!wroteEntry(body))
    return toolCall('writeText', { path: 'game/scene/start.txt', content: script })
  return structuredResult(body)
}

function wroteEntry(body: ModelBody): boolean {
  return body.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.tool_calls?.some((call) => call.function?.name === 'writeText') === true
  )
}

function structuredResult(body: ModelBody): Response {
  const result = {
    action: 'submit_scene_result',
    summary: '车站道别',
    writtenFiles: ['game/scene/start.txt'],
    usedAssetIds: ['station'],
    unresolvedIssues: [],
    tradeoffs: [],
    questions: []
  }
  if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')
    return stop(JSON.stringify(result))
  const name =
    body.tools.find((tool) => tool.function.name === 'submit_scene_result')?.function.name ??
    'submit_scene_result'
  return toolCall(name, result)
}

function missingSummary(body: ModelBody): Response {
  if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')
    return stop('')
  return stop('候选已经写完。')
}

function truncated(body: ModelBody): Response {
  if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')
    return completion({ finish_reason: 'length', content: '' })
  return completion({
    finish_reason: 'length',
    content: null,
    invalid_tool_calls: [{ id: 'cut', type: 'function', function: { name: 'writeText' } }]
  })
}

function invalidResult(body: ModelBody): Response {
  const result = { summary: 1, writtenFiles: 'not-a-list' }
  if (body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object')
    return stop(JSON.stringify(result))
  return toolCall('submit_scene_result', result)
}

function completion(choice: Record<string, unknown>): Response {
  return Response.json({
    id: 'candidate-durability',
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'content' in choice ? choice.content : null,
          ...('tool_calls' in choice ? { tool_calls: choice.tool_calls } : {}),
          ...('invalid_tool_calls' in choice
            ? { invalid_tool_calls: choice.invalid_tool_calls }
            : {})
        },
        finish_reason: choice.finish_reason
      }
    ],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
  })
}

function toolCall(name: string, args: unknown): Response {
  return completion({
    finish_reason: 'tool_calls',
    tool_calls: [
      { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
    ]
  })
}

function stop(content: string): Response {
  return completion({ finish_reason: 'stop', content })
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
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  })
}

async function until(ready: () => boolean): Promise<void> {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 5000) throw new Error('等待条件没有出现')
    await Promise.resolve()
  }
}

async function writeProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, 'game/background'), { recursive: true })
  await mkdir(join(projectRoot, 'assets/background'), { recursive: true })
  await mkdir(join(projectRoot, '.opengalgame'), { recursive: true })
  await writeFile(join(projectRoot, 'game/scene/start.txt'), 'say:原稿;')
  const station =
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#304658"/></svg>'
  await writeFile(join(projectRoot, 'game/background/station.svg'), station)
  await writeFile(join(projectRoot, 'assets/background/station.svg'), station)
  await writeJson(projectRoot, '.opengalgame/manifest.json', { projectId: request.projectId })
  await writeJson(projectRoot, sourceDescriptorPath('existing-station'), {
    formatVersion: 1,
    projectId: request.projectId,
    sourceId: 'existing-station',
    content: {
      kind: 'asset',
      name: '车站',
      fileType: 'image',
      description: '车站',
      fileId: 'file-existing-station',
      mediaPath: 'assets/background/station.svg'
    }
  })
  await writeJson(projectRoot, arrangementPath(request.sceneId, 'canvas-1'), {
    formatVersion: 3,
    projectId: request.projectId,
    sceneId: request.sceneId,
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'image',
        cardId: 'station',
        sourceId: 'existing-station',
        role: 'background',
        title: '车站',
        summary: '傍晚的车站',
        usage: { targetIds: [] },
        layout: { x: 0, y: 0, width: 320, height: 180 }
      },
      {
        kind: 'prompt',
        cardId: 'story',
        title: '道别',
        summary: '',
        body: '写一个学生在车站道别的单场景，使用已有背景。',
        usage: { targetIds: [] },
        layout: { x: 40, y: 40, width: 300, height: 200 }
      }
    ],
    relations: []
  })
  await writeJson(projectRoot, '.opengalgame/scene-locks.json', {
    scenes: [{ sceneId: request.sceneId, lockState: 'unlocked' }]
  })
  await writeFile(
    join(projectRoot, 'game/config.txt'),
    'Game_name:场景生成验收;\nGame_key:scene-acceptance;\nTitle_img:station.svg;\nLanguage:zhCn;\n'
  )
  await mkdir(join(projectRoot, 'game/animation'), { recursive: true })
  await mkdir(join(projectRoot, 'game/template'), { recursive: true })
  await writeFile(join(projectRoot, 'game/animation/animationTable.json'), '[]')
  await writeFile(join(projectRoot, 'game/template/template.json'), '{}')
  await writeFile(join(projectRoot, 'game/userStyleSheet.css'), '')
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', projectRoot, ...args], { stdio: 'ignore' })
  }
  git('init', '-q')
  git('add', '.')
  git(
    '-c',
    'user.name=Acceptance',
    '-c',
    'user.email=acceptance@example.test',
    'commit',
    '-qm',
    '验收基线'
  )
  await writeProjectRegistrations(join(dirname(projectRoot), 'state'), [
    { id: request.projectId, directory: projectRoot, operationId: 'op-register' }
  ])
}

async function writeJson(projectRoot: string, relativePath: string, value: unknown): Promise<void> {
  const absolute = join(projectRoot, ...relativePath.split('/'))
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, JSON.stringify(value) + '\n')
}
