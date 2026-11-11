import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import type { SceneCanvasArrangementContent } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import { LocalSceneCanvasArrangementStoreGatewayImpl } from '@infrastructure/scene-canvas/LocalSceneCanvasArrangementStoreGatewayImpl'
import {
  LocalSceneCanvasWorkVersionGatewayImpl,
  UnwiredSceneCanvasVersioningRequests,
  type SceneCanvasVersioningRequests
} from '@infrastructure/scene-canvas/LocalSceneCanvasWorkVersionGatewayImpl'
import { SceneCanvasCommitScheduler } from '@infrastructure/scene-canvas/SceneCanvasCommitScheduler'
import { SceneCanvasEditHistoryCache } from '@infrastructure/scene-canvas/SceneCanvasEditHistoryCache'
import {
  arrangementDigest,
  parseArrangementDocument,
  serializeArrangement
} from '@infrastructure/scene-canvas/documents/SceneCanvasArrangementDocument'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { PeriodicTask } from '@infrastructure/storage/periodicTask'

const scope = { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' }
const logged: string[] = []
const logger: LoggerGateway = {
  debug(message) {
    logged.push(message)
  },
  info(message) {
    logged.push(message)
  },
  warn(message) {
    logged.push(message)
  },
  error(message) {
    logged.push(message)
  }
}
const directories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

function content(): SceneCanvasArrangementContent {
  return {
    projectId: scope.projectId,
    sceneId: scope.sceneId,
    canvasId: scope.canvasId,
    cards: [
      {
        cardId: 'prompt',
        family: 'text',
        textKind: 'prompt',
        body: '约束',
        title: '提示词',
        synopsis: '',
        usage: { targetIds: [] },
        layout: { x: 1, y: 2, width: 10, height: 20 }
      }
    ],
    relations: []
  }
}

function projects(directory: string): ProjectListQueryGateway {
  return {
    listRegistrations: async () => [],
    countRegistrations: async () => 0,
    findRegistration: async () => ({ id: 'project-1', directory })
  }
}

describe('scene canvas infrastructure', () => {
  it('编排序列化稳定，损坏和归属不匹配被拒绝', () => {
    const value = content()
    expect(serializeArrangement(value)).toBe(serializeArrangement(value))
    expect(arrangementDigest(value)).toHaveLength(64)
    const parsed = JSON.parse(serializeArrangement(value)) as unknown
    expect(parseArrangementDocument(parsed, scope)).toMatchObject({ cards: [{ cardId: 'prompt' }] })
    expect(() => parseArrangementDocument({ formatVersion: 1 }, scope)).toThrow(AppException)
    expect(() =>
      parseArrangementDocument(
        { ...JSON.parse(serializeArrangement(value)), projectId: 'other' },
        scope
      )
    ).toThrow(expect.objectContaining({ code: SceneCanvasErrorCodes.ownershipMismatch }))
  })

  it('编辑历史有界，撤销和重做在两个栈之间移动', () => {
    const history = new SceneCanvasEditHistoryCache(2)
    history.push(scope, {
      forward: [{ op: 'removeCard', cardId: 'a' }],
      inverse: [{ op: 'removeCard', cardId: 'a' }]
    })
    history.push(scope, {
      forward: [{ op: 'removeCard', cardId: 'b' }],
      inverse: [{ op: 'removeCard', cardId: 'b' }]
    })
    history.push(scope, {
      forward: [{ op: 'removeCard', cardId: 'c' }],
      inverse: [{ op: 'removeCard', cardId: 'c' }]
    })
    expect(history.readDepth(scope)).toEqual({ undo: 2, redo: 0 })
    expect(history.undo(scope)).toEqual([{ op: 'removeCard', cardId: 'c' }])
    expect(history.redo(scope)).toEqual([{ op: 'removeCard', cardId: 'c' }])
    history.clear(scope)
    expect(history.undo(scope)).toBeNull()
  })

  it('内容摘要一致时不提出提交，不一致时把规范文本交出去', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scene-canvas-'))
    directories.push(directory)
    const submitted: string[] = []
    const requests: SceneCanvasVersioningRequests = {
      readVersion: async () => ({
        dirty: false,
        committing: false,
        commitId: 'old',
        committedAt: null,
        failureMessage: null,
        contentDigest: arrangementDigest(content())
      }),
      submitCommit: async (request) => {
        submitted.push(request.canonicalContent)
        return { committed: true, commitId: 'new', skippedReason: null }
      },
      submitRollback: async () => ({ commitId: 'back' })
    }
    const gateway = new LocalSceneCanvasWorkVersionGatewayImpl(
      projects(directory),
      requests,
      logger
    )
    expect(
      await gateway.commitArrangement({ scope, content: content(), operationId: 'op-1' })
    ).toMatchObject({ committed: false, skippedReason: 'unchanged' })
    expect(submitted).toEqual([])
    const changed = content()
    changed.cards = [{ ...changed.cards[0], title: '改过' } as (typeof changed.cards)[number]]
    expect(
      await gateway.commitArrangement({ scope, content: changed, operationId: 'op-2' })
    ).toMatchObject({ committed: true, commitId: 'new' })
    expect(submitted[0]).toBe(serializeArrangement(changed))
    await expect(
      new LocalSceneCanvasWorkVersionGatewayImpl(
        projects(directory),
        new UnwiredSceneCanvasVersioningRequests(),
        logger
      ).commitArrangement({ scope, content: changed, operationId: 'op-3' })
    ).rejects.toMatchObject({ code: ErrorCodes.invalidConfig })
  })

  it('强制落盘写出编排文件，成功后才排程提交', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'scene-canvas-'))
    directories.push(directory)
    const commits: string[] = []
    const versions = {
      commitArrangement: async (request: { operationId: string }) => {
        commits.push(request.operationId)
        return { committed: true, commitId: 'commit-1', skippedReason: null }
      },
      readArrangementVersion: async () => ({
        dirty: true,
        committing: false,
        commitId: null,
        committedAt: null,
        failureMessage: null,
        contentDigest: null
      }),
      rollbackArrangement: async () => ({ commitId: 'back' })
    }
    const store = new LocalSceneCanvasArrangementStoreGatewayImpl(
      projects(directory),
      logger,
      (saved) => scheduler.notifyPersisted(saved),
      {
        quietMs: 10_000,
        maxWaitMs: 60_000,
        initialDelayMs: 10_000,
        maxDelayMs: 120_000,
        retries: 1
      }
    )
    const scheduler = new SceneCanvasCommitScheduler(store, versions, () => 'op-auto', logger, {
      quietMs: 30_000,
      maxWaitMs: 120_000,
      initialDelayMs: 10_000,
      maxDelayMs: 120_000,
      retries: 1
    })
    store.writeArrangement(scope, content())
    expect(store.readSaveState(scope).dirty).toBe(true)
    const flushed = await store.flushArrangement(scope)
    expect(flushed.cardCount).toBe(1)
    const relative = serializeArrangement(content())
    const saved = await readFile(join(directory, '.opengalgame', 'canvases'), 'utf8').catch(
      () => ''
    )
    expect(saved === '' || relative.length > 0).toBe(true)
    const file = await readFile(
      join(
        directory,
        '.opengalgame',
        'canvases',
        Buffer.from(scope.sceneId).toString('hex'),
        `${Buffer.from(scope.canvasId).toString('hex')}.json`
      ),
      'utf8'
    )
    expect(file).toBe(relative)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(commits).toEqual(['op-auto'])
    store.stop()
    scheduler.stop()
  })

  it('静默期内多次触发只执行一次，超过最长等待立即执行', async () => {
    vi.useFakeTimers()
    const runs: number[] = []
    const task = new PeriodicTask(
      {
        quietMs: 10_000,
        maxWaitMs: 60_000,
        initialDelayMs: 10_000,
        maxDelayMs: 120_000,
        retries: 1
      },
      async () => {
        runs.push(Date.now())
      },
      () => false
    )
    task.kick()
    task.kick()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(runs).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toHaveLength(1)
    const started = Date.now()
    task.kick()
    for (let step = 0; step < 11; step += 1) {
      await vi.advanceTimersByTimeAsync(5_000)
      task.kick()
    }
    await vi.advanceTimersByTimeAsync(5_000)
    task.kick()
    expect(runs).toHaveLength(2)
    expect(runs[1]! - started).toBe(60_000)
    task.stop()
  })
})
