import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import {
  ensureStateRoot,
  resolveStatePath
} from '@infrastructure/workflow/checkpoints/checkpointPath'

const roots: string[] = []
const MIO_REAL_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353838'
const MIO_WRONG_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353538'
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('旧格式执行记录保留原文，不阻断同工程的新线程', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const legacy = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-old',
    threadId: 'thread-old',
    branchId: 'branch-old',
    fingerprint: 'fingerprint-old',
    state: 'succeeded',
    inputSnapshot: {
      prompts: [{ id: 'story', sourceId: 'story', body: '旧正文' }]
    }
  }
  await writeJson(path, { version: 1, executions: [legacy] })

  await repository.createExecution(currentExecution())
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{
      operationId: string
      inputSnapshot?: { prompts?: Array<{ sourceId?: string }> }
    }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions[0]).toMatchObject({
    operationId: 'operation-old',
    inputSnapshot: { prompts: [{ sourceId: 'story', body: '旧正文' }] }
  })
  expect(saved.executions.map((item) => item.operationId)).toEqual([
    'operation-old',
    'operation-new'
  ])
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-old'
    })
  ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest })
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-new'
    })
  ).resolves.toMatchObject({ operationId: 'operation-new' })
})

it('创建和写入返回读回的持久记录时间，创建时间不被覆盖', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-time-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  }

  const created = await repository.createExecution({
    ...currentExecution(),
    updatedAt: '2000-01-01T00:00:00.000Z'
  })
  const storedAfterCreate = (await repository.readExecution(scope))!
  expect(created.createdAt).toBeTypeOf('string')
  expect(created.updatedAt).toBeTypeOf('string')
  expect(created.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')
  expect(created.createdAt).toBe(storedAfterCreate.createdAt)
  expect(created.updatedAt).toBe(storedAfterCreate.updatedAt)

  const written = await repository.writeExecution({
    ...storedAfterCreate,
    state: 'running',
    updatedAt: '2000-01-01T00:00:00.000Z'
  })
  const storedAfterWrite = (await repository.readExecution(scope))!
  expect(written.createdAt).toBe(created.createdAt)
  expect(written.updatedAt).not.toBe('2000-01-01T00:00:00.000Z')
  expect(written.updatedAt).toBe(storedAfterWrite.updatedAt)
})

it('版本 2 执行记录补齐 Token、暂停和时间线默认值后仍可继续', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-v2-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const previous = currentExecution()
  await writeJson(path, { version: 2, executions: [previous] })

  const loaded = await repository.readExecution({
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  })
  expect(loaded?.budget.modelCallsUsed).toBe(0)
  expect(loaded?.budget.inputTokens).toBeUndefined()
  expect(loaded?.budget.tokenLimit).toBeUndefined()
  await repository.writeExecution({
    ...loaded!,
    budget: {
      ...loaded!.budget,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      tokenLimit: null
    },
    pauseRequested: true,
    timeline: [
      {
        entryId: 'entry-1',
        sequence: 1,
        createdAt: '2026-10-20T00:00:00.000Z',
        kind: 'stage',
        stage: 'readingInput',
        message: '正在读取已保存编排与输入'
      }
    ]
  })
  const saved = JSON.parse(await readFile(path, 'utf8')) as { version: number }
  expect(saved.version).toBe(7)
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-new'
    })
  ).resolves.toMatchObject({
    budget: { inputTokens: 3, outputTokens: 2, totalTokens: 5, tokenLimit: null },
    pauseRequested: true,
    timeline: [{ entryId: 'entry-1' }]
  })
})

it('带记录时间的旧格式进入场景历史，没有时间事实的旧记录不估算', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-history-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const dated = {
    ...currentExecution(),
    operationId: 'operation-dated',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T01:00:00.000Z'
  }
  const undated: SceneGenerationExecution = {
    ...currentExecution(),
    operationId: 'operation-undated'
  }
  delete undated.createdAt
  delete undated.updatedAt
  await writeJson(path, { version: 3, executions: [dated, undated] })

  const history = await repository.listSceneExecutions({
    projectId: 'project-1',
    sceneId: 'scene-1',
    limit: 10
  })
  expect(history.map((item) => item.operationId)).toEqual(['operation-dated'])
  expect(history[0]?.timeline?.[0]?.createdAt).toBe('2026-10-18T01:00:00.000Z')
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    executions: Array<{ operationId: string; updatedAt?: string }>
  }
  expect(
    saved.executions.find((item) => item.operationId === 'operation-undated')?.updatedAt
  ).toBeUndefined()
})

it('版本 4 仍可读，版本 7 写回不丢问题组和已接受答案', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-v5-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  }
  await writeJson(path, { version: 4, executions: [currentExecution()] })
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    operationId: 'operation-new',
    replies: []
  })

  const question = {
    questionId: 'q1',
    prompt: '第 1 个创作问题',
    options: [1, 2, 3].map((option) => ({
      id: `q1o${option}`,
      label: `选项 ${option}`,
      description: `说明 ${option}`
    }))
  }
  await repository.writeExecution({
    ...currentExecution(),
    interaction: {
      interactionId: 'interaction-1',
      checkpointId: 'checkpoint-1',
      kind: 'decision',
      message: '请确认',
      options: [],
      questions: [question],
      allowedReplies: ['answers']
    },
    replies: [
      {
        ...scope,
        threadId: 'thread-new',
        branchId: 'branch-new',
        interactionId: 'interaction-1',
        checkpointId: 'checkpoint-1',
        replyId: 'reply-1',
        reply: {
          kind: 'answers',
          answers: [{ questionId: 'q1', optionId: 'q1o2', body: '保留补充' }]
        },
        selections: [
          {
            questionId: 'q1',
            prompt: '第 1 个创作问题',
            optionId: 'q1o2',
            label: '选项 2',
            description: '说明 2',
            body: '保留补充'
          }
        ]
      }
    ]
  })
  const saved = JSON.parse(await readFile(path, 'utf8')) as { version: number }
  expect(saved.version).toBe(7)
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    interaction: { questions: [{ questionId: 'q1', prompt: '第 1 个创作问题' }] },
    replies: [{ selections: [{ optionId: 'q1o2', label: '选项 2', body: '保留补充' }] }]
  })
})

it('版本 5 读写失败事实，旧失败记录仍可读', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-failure-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  }
  await writeJson(path, {
    version: 5,
    executions: [
      {
        ...currentExecution(),
        state: 'failed',
        phase: 'failed',
        failure: { code: 4101, message: '模型请求被拒绝' }
      }
    ]
  })
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    failure: { code: 4101, message: '模型请求被拒绝' }
  })

  await repository.writeExecution({
    ...currentExecution(),
    state: 'failed',
    step: undefined,
    failure: {
      code: 4102,
      message: '模型鉴权失败',
      reason: 'modelAccess',
      category: 'auth',
      httpStatus: 401,
      causeName: 'APIError',
      diagnosticRef: '0123456789ab'
    }
  })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    executions: Array<{ failure?: Record<string, unknown> }>
  }
  expect(saved.executions[0]?.failure).toEqual({
    code: 4102,
    message: '模型鉴权失败',
    reason: 'modelAccess',
    category: 'auth',
    httpStatus: 401,
    causeName: 'APIError',
    diagnosticRef: '0123456789ab'
  })
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    failure: { diagnosticRef: '0123456789ab', causeName: 'APIError' }
  })
})

it('版本 6 读写失败分类与下一步动作，旧记录缺失时保持缺失', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-failure-class-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-classified'
  }
  await writeJson(path, {
    version: 5,
    executions: [
      {
        ...currentExecution(),
        state: 'failed',
        phase: 'failed',
        failure: { code: 4101, message: '模型请求被拒绝' }
      }
    ]
  })
  const legacy = await repository.readExecution({
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  })
  expect(legacy?.failure?.code).toBe(4101)
  expect(legacy?.failure?.failureClass).toBeUndefined()
  expect(legacy?.failure?.nextActions).toBeUndefined()

  const created = await repository.createExecution({
    ...currentExecution(),
    operationId: 'operation-classified',
    state: 'failed',
    step: undefined,
    failure: {
      code: 4102,
      message: '模型鉴权失败',
      failureClass: 'modelAuth',
      nextActions: ['checkConnection', 'viewInputSummary']
    }
  })
  expect(created.failure).toMatchObject({
    code: 4102,
    message: '模型鉴权失败',
    failureClass: 'modelAuth',
    nextActions: ['checkConnection', 'viewInputSummary']
  })

  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string; failure?: Record<string, unknown> }>
  }
  expect(saved.version).toBe(7)
  expect(
    saved.executions.find((item) => item.operationId === 'operation-classified')?.failure
  ).toEqual({
    code: 4102,
    message: '模型鉴权失败',
    failureClass: 'modelAuth',
    nextActions: ['checkConnection', 'viewInputSummary']
  })
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    failure: {
      code: 4102,
      message: '模型鉴权失败',
      failureClass: 'modelAuth',
      nextActions: ['checkConnection', 'viewInputSummary']
    }
  })
})

it('版本 5 读写修复来源和失败候选事实，旧记录缺失时保持缺失', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-repair-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  }
  await writeJson(path, { version: 5, executions: [currentExecution()] })
  const loaded = await repository.readExecution(scope)
  expect(loaded?.mode).toBeUndefined()
  expect(loaded?.repairSource).toBeUndefined()

  await repository.writeExecution({
    ...currentExecution(),
    state: 'failed',
    step: undefined,
    mode: 'repair',
    repairSource: {
      operationId: 'source-operation',
      threadId: 'source-thread',
      branchId: 'source-branch',
      checkpointId: 'source-checkpoint',
      candidateSnapshotId: 'previous-candidate'
    },
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'candidate-1',
    replies: [
      {
        ...scope,
        threadId: 'thread-new',
        branchId: 'branch-new',
        interactionId: 'interaction-1',
        checkpointId: 'checkpoint-1',
        replyId: 'reply-1',
        reply: { kind: 'revise', body: '把结尾音乐改成停止。' }
      }
    ],
    failure: {
      code: 4103,
      message: '智能体未通过文件工具实际写入候选脚本',
      candidateSnapshotId: 'candidate-1',
      previewAuthorization: 'readOnly'
    }
  })
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    mode: 'repair',
    repairSource: { candidateSnapshotId: 'previous-candidate' },
    failure: { candidateSnapshotId: 'candidate-1', previewAuthorization: 'readOnly' }
  })
})

it('版本 6 读写修复上下文，旧记录缺失时保持缺失', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-repair-context-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-repair'
  }
  const repairContext = {
    sourceOperationId: 'source-operation',
    sourceThreadId: 'source-thread',
    sourceBranchId: 'source-branch',
    sourceCheckpointId: 'source-checkpoint',
    sourceCandidateSnapshotId: 'source-candidate',
    candidatePath: 'game/scene/start.txt',
    instruction: '改结尾',
    summary: '来源摘要',
    confirmedReplies: [{ kind: 'revise', body: '改结尾' }],
    unresolvedIssues: ['未解决冲突'],
    validationReport: {
      issues: [
        {
          code: 'missing-entry',
          message: '缺少入口',
          correctable: true,
          requiresHumanDecision: false
        }
      ]
    },
    failureClass: 'outputContract',
    failureReason: 'structuredOutput',
    failureMessage: '候选未通过'
  }
  await writeJson(path, {
    version: 6,
    executions: [
      currentExecution(),
      {
        ...currentExecution(),
        operationId: 'operation-repair',
        state: 'failed',
        phase: 'failed',
        mode: 'repair',
        repairSource: {
          operationId: 'source-operation',
          threadId: 'source-thread',
          branchId: 'source-branch',
          checkpointId: 'source-checkpoint',
          candidateSnapshotId: 'source-candidate'
        },
        repairContext
      }
    ]
  })

  const legacy = await repository.readExecution({
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  })
  expect(legacy?.repairContext).toBeUndefined()
  const loaded = (await repository.readExecution(scope))!
  expect(loaded.repairContext).toEqual(repairContext)

  await repository.writeExecution({ ...loaded, state: 'running', phase: 'preparing' })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string; repairContext?: unknown }>
  }
  expect(saved.version).toBe(7)
  expect(
    saved.executions.find((item) => item.operationId === 'operation-repair')?.repairContext
  ).toEqual(repairContext)
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    repairContext,
    mode: 'repair'
  })
})

it('缺失素材诊断字段随版本 7 执行记录原样读写', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-missing-asset-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-missing-asset'
  }
  const issue = {
    code: 'missing-asset',
    message: '素材引用在工程中不存在',
    sequence: 4,
    reference: `${MIO_WRONG_KEY}/josei_01_a.png`,
    line: 9,
    nearestReference: `${MIO_REAL_KEY}/josei_01_a.png`,
    nearestAssetName: '澪',
    nearestAssetPath: `assets/${MIO_REAL_KEY}/josei_01_a.png`,
    correctable: true,
    requiresHumanDecision: false
  }
  await writeJson(path, {
    version: 7,
    executions: [
      {
        ...currentExecution(),
        operationId: 'operation-missing-asset',
        artifactValidation: { issues: [issue] }
      }
    ]
  })

  const loaded = (await repository.readExecution(scope))!
  expect(loaded.artifactValidation?.issues).toEqual([issue])

  await repository.writeExecution({ ...loaded, state: 'running' })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    executions: Array<{ operationId: string; artifactValidation?: { issues: unknown[] } }>
  }
  expect(
    saved.executions.find((item) => item.operationId === 'operation-missing-asset')
      ?.artifactValidation?.issues
  ).toEqual([issue])
})

it('版本 6 旧记录只有用途和角色时读取为类别，写回不再保留旧字段', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-legacy-purpose-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-legacy-purpose'
  }
  const base = currentExecution()
  await writeJson(path, {
    version: 6,
    executions: [
      {
        ...base,
        operationId: scope.operationId,
        inputSnapshot: {
          ...base.inputSnapshot,
          assets: [
            {
              assetId: 'card-audio',
              sourceId: 'audio-source',
              name: '下压音',
              relativePath: 'assets/bgm/duck.ogg',
              purpose: 'music',
              description: '下压音效',
              usage: { targetIds: [] }
            }
          ],
          prompts: [
            {
              id: 'prompt-1',
              title: '提示',
              body: '用下压音',
              scopes: [{ kind: 'scene' }],
              references: [
                { cardId: 'card-audio', kind: 'audio', displayName: '下压音', role: 'music' }
              ],
              usage: { targetIds: [] }
            }
          ]
        }
      }
    ]
  })

  const loaded = (await repository.readExecution(scope))!
  expect(loaded.inputSnapshot.assets[0]).toEqual({
    assetId: 'card-audio',
    sourceId: 'audio-source',
    name: '下压音',
    relativePath: 'assets/bgm/duck.ogg',
    description: '下压音效',
    usage: { targetIds: [] },
    category: 'audio'
  })
  expect(loaded.inputSnapshot.assets[0]).not.toHaveProperty('purpose')
  expect(Object.keys(loaded.inputSnapshot.assets[0]!)).toEqual([
    'assetId',
    'sourceId',
    'name',
    'relativePath',
    'category',
    'description',
    'usage'
  ])
  expect(JSON.stringify(loaded.inputSnapshot.assets[0])).toBe(
    JSON.stringify({
      assetId: 'card-audio',
      sourceId: 'audio-source',
      name: '下压音',
      relativePath: 'assets/bgm/duck.ogg',
      category: 'audio',
      description: '下压音效',
      usage: { targetIds: [] }
    })
  )
  expect(loaded.inputSnapshot.prompts[0]?.references[0]).toEqual({
    cardId: 'card-audio',
    kind: 'audio',
    displayName: '下压音'
  })
  expect(loaded.inputSnapshot.prompts[0]?.references[0]).not.toHaveProperty('role')

  await repository.writeExecution({ ...loaded, state: 'running', phase: 'preparing' })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{
      operationId: string
      inputSnapshot?: {
        assets?: Array<Record<string, unknown>>
        prompts?: Array<{ references?: Array<Record<string, unknown>> }>
      }
    }>
  }
  expect(saved.version).toBe(7)
  const stored = saved.executions.find((item) => item.operationId === scope.operationId)
  expect(stored?.inputSnapshot?.assets?.[0]).toMatchObject({ category: 'audio' })
  expect(stored?.inputSnapshot?.assets?.[0]).not.toHaveProperty('purpose')
  expect(stored?.inputSnapshot?.prompts?.[0]?.references?.[0]).not.toHaveProperty('role')
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    inputSnapshot: { assets: [{ category: 'audio' }] }
  })
})

it('版本 7 写入业务 step，终态不携带 step', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-v7-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  const scope = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new'
  }
  await repository.createExecution({
    ...currentExecution(),
    state: 'running',
    step: 'validating'
  })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string; state?: string; step?: string }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions[0]).toMatchObject({ operationId: 'operation-new', step: 'validating' })
  await expect(repository.readExecution(scope)).resolves.toMatchObject({
    state: 'running',
    step: 'validating'
  })

  await repository.writeExecution({
    ...(await repository.readExecution(scope))!,
    state: 'failed',
    step: undefined
  })
  const after = JSON.parse(await readFile(path, 'utf8')) as {
    executions: Array<{ operationId: string; state?: string; step?: string; phase?: string }>
  }
  expect(after.executions[0]).toMatchObject({ operationId: 'operation-new', state: 'failed' })
  expect(after.executions[0]?.step).toBeUndefined()
  expect(after.executions[0]).not.toHaveProperty('phase')
  const settled = (await repository.readExecution(scope))!
  expect(settled.state).toBe('failed')
  expect(settled.step).toBeUndefined()
})

it('版本 6 旧记录按 phase 迁移为 step，终态 phase 归一为终态 state', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-records-v6-step-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const path = await resolveStatePath(
    await ensureStateRoot(stateRoot),
    'scene-generation/projects/project-1/executions.json'
  )
  await writeJson(path, {
    version: 6,
    executions: [
      {
        ...currentExecution(),
        operationId: 'operation-reading',
        state: 'running',
        step: undefined,
        phase: 'reading'
      },
      {
        ...currentExecution(),
        operationId: 'operation-waiting',
        state: 'waiting',
        step: undefined,
        phase: 'waiting'
      },
      {
        ...currentExecution(),
        operationId: 'operation-rolling',
        state: 'running',
        step: undefined,
        phase: 'rollingBack'
      },
      {
        ...currentExecution(),
        operationId: 'operation-succeeded',
        state: 'succeeded',
        step: undefined,
        phase: 'completed'
      },
      {
        ...currentExecution(),
        operationId: 'operation-failed',
        state: 'failed',
        step: undefined,
        phase: 'failed'
      }
    ]
  })

  const reading = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-reading'
  }
  await expect(repository.readExecution(reading)).resolves.toMatchObject({
    state: 'running',
    step: 'reading'
  })
  const waiting = (await repository.readExecution({
    ...reading,
    operationId: 'operation-waiting'
  }))!
  expect(waiting.state).toBe('waiting')
  expect(waiting.step).toBeUndefined()
  await expect(
    repository.readExecution({ ...reading, operationId: 'operation-rolling' })
  ).resolves.toMatchObject({ state: 'running', step: 'rollingBack' })
  const succeeded = (await repository.readExecution({
    ...reading,
    operationId: 'operation-succeeded'
  }))!
  expect(succeeded.state).toBe('succeeded')
  expect(succeeded.step).toBeUndefined()
  const failed = (await repository.readExecution({
    ...reading,
    operationId: 'operation-failed'
  }))!
  expect(failed.state).toBe('failed')
  expect(failed.step).toBeUndefined()

  await repository.writeExecution({
    ...(await repository.readExecution({ ...reading, operationId: 'operation-rolling' }))!,
    state: 'running'
  })
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string; step?: string; phase?: string }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions.every((item) => !('phase' in item))).toBe(true)
  expect(
    saved.executions.find((item) => item.operationId === 'operation-rolling')?.step
  ).toBe('rollingBack')
})

function currentExecution(): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new',
    threadId: 'thread-new',
    branchId: 'branch-new',
    fingerprint: 'fingerprint-new',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'v1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'pending',
    step: 'preparing',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}
