import { describe, expect, it } from 'vitest'

import type { SceneCanvasEditHistoryEntry } from '@application/scene-canvas/models/SceneCanvasEditHistoryEntry'
import type { SceneCanvasArrangementStoreGateway } from '@application/scene-canvas/ports/SceneCanvasArrangementStoreGateway'
import type { SceneCanvasEditHistoryGateway } from '@application/scene-canvas/ports/SceneCanvasEditHistoryGateway'
import type { SceneCanvasSourceReaderGateway } from '@application/scene-canvas/ports/SceneCanvasSourceReaderGateway'
import type { SceneCanvasWorkVersionGateway } from '@application/scene-canvas/ports/SceneCanvasWorkVersionGateway'
import { SceneCanvasArrangementServiceImpl } from '@application/scene-canvas/services/impl/SceneCanvasArrangementServiceImpl'
import { SceneCanvasEditorServiceImpl } from '@application/scene-canvas/services/impl/SceneCanvasEditorServiceImpl'
import { SceneCanvasVersionServiceImpl } from '@application/scene-canvas/services/impl/SceneCanvasVersionServiceImpl'
import type { ProjectListQueryGateway } from '@application/projects/ports/ProjectListQueryGateway'
import type { ProjectStorageGateway } from '@application/projects/ports/ProjectStorageGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneCanvasArrangementContent } from '@domain/scene-canvas/models/SceneCanvasArrangement'
import type { SceneCanvasEdit } from '@domain/scene-canvas/models/SceneCanvasEdit'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import type { SceneCanvasSourceContentKind } from '@domain/scene-canvas/rules/validateAssetRole'
import { ProjectDomainServiceImpl } from '@domain/projects/services/impl/ProjectDomainServiceImpl'

const scope = { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' }
const layout = { x: 1, y: 2, width: 10, height: 20 }

function projectDeps(registrationId: string | null = 'project-1'): {
  listQuery: ProjectListQueryGateway
  domain: ProjectDomainServiceImpl
  storage: ProjectStorageGateway
} {
  return {
    listQuery: {
      listRegistrations: async () => [],
      countRegistrations: async () => 0,
      findRegistration: async () =>
        registrationId === null ? null : { id: registrationId, directory: 'D:/works/project-1' }
    },
    domain: new ProjectDomainServiceImpl(),
    storage: {
      inspect: async () => ({
        kind: 'existing' as const,
        project: { id: 'project-1', name: '作品', synopsis: '' }
      })
    } as unknown as ProjectStorageGateway
  }
}

class MemoryStore implements SceneCanvasArrangementStoreGateway {
  content: SceneCanvasArrangementContent | null = null
  dirty = false
  writes = 0
  flushes = 0
  discarded = 0

  async readArrangement(): Promise<SceneCanvasArrangementContent | null> {
    return this.content
  }

  writeArrangement(_scope: unknown, content: SceneCanvasArrangementContent): void {
    this.content = content
    this.dirty = true
    this.writes += 1
  }

  async flushArrangement(): Promise<{ savedAt: string; cardCount: number; relationCount: number }> {
    this.dirty = false
    this.flushes += 1
    return {
      savedAt: '2026-10-15T00:00:00.000Z',
      cardCount: this.content?.cards.length ?? 0,
      relationCount: this.content?.relations.length ?? 0
    }
  }

  readSaveState(): {
    dirty: boolean
    writing: boolean
    savedAt: string | null
    failureMessage: string | null
  } {
    return { dirty: this.dirty, writing: false, savedAt: null, failureMessage: null }
  }

  discardArrangement(): void {
    this.content = null
    this.dirty = false
    this.discarded += 1
  }
}

class MemoryHistory implements SceneCanvasEditHistoryGateway {
  private stacks = new Map<
    string,
    { undo: SceneCanvasEditHistoryEntry[]; redo: SceneCanvasEditHistoryEntry[] }
  >()

  push(
    scope: { projectId: string; sceneId: string; canvasId: string },
    entry: SceneCanvasEditHistoryEntry
  ): void {
    const stack = this.stack(scope)
    stack.undo.push(entry)
    stack.redo = []
  }

  undo(scope: {
    projectId: string
    sceneId: string
    canvasId: string
  }): readonly SceneCanvasEdit[] | null {
    const stack = this.stack(scope)
    const entry = stack.undo.pop()
    if (!entry) return null
    stack.redo.push(entry)
    return entry.inverse
  }

  redo(scope: {
    projectId: string
    sceneId: string
    canvasId: string
  }): readonly SceneCanvasEdit[] | null {
    const stack = this.stack(scope)
    const entry = stack.redo.pop()
    if (!entry) return null
    stack.undo.push(entry)
    return entry.forward
  }

  clear(scope: { projectId: string; sceneId: string; canvasId: string }): void {
    this.stacks.delete(this.key(scope))
  }

  readDepth(scope: { projectId: string; sceneId: string; canvasId: string }): {
    undo: number
    redo: number
  } {
    const stack = this.stacks.get(this.key(scope))
    return { undo: stack?.undo.length ?? 0, redo: stack?.redo.length ?? 0 }
  }

  private stack(scope: { projectId: string; sceneId: string; canvasId: string }): {
    undo: SceneCanvasEditHistoryEntry[]
    redo: SceneCanvasEditHistoryEntry[]
  } {
    const key = this.key(scope)
    const existing = this.stacks.get(key)
    if (existing) return existing
    const created = { undo: [], redo: [] }
    this.stacks.set(key, created)
    return created
  }

  private key(scope: { projectId: string; sceneId: string; canvasId: string }): string {
    return `${scope.projectId}/${scope.sceneId}/${scope.canvasId}`
  }
}

function sources(
  kinds: Record<string, SceneCanvasSourceContentKind | 'missing'>
): SceneCanvasSourceReaderGateway {
  return {
    checkSources: async (_projectId, sourceIds) =>
      sourceIds.map((sourceId) => {
        const kind = kinds[sourceId] ?? 'missing'
        return kind === 'missing'
          ? { sourceId, readable: false, contentKind: 'text' as const }
          : { sourceId, readable: true, contentKind: kind }
      })
  }
}

function services(
  store: MemoryStore,
  history: MemoryHistory,
  reader: SceneCanvasSourceReaderGateway
): {
  editor: SceneCanvasEditorServiceImpl
  arrangement: SceneCanvasArrangementServiceImpl
  version: SceneCanvasVersionServiceImpl
  commits: { operationId: string }[]
  rollbacks: string[]
} {
  const commits: { operationId: string }[] = []
  const rollbacks: string[] = []
  let operation = 0
  const versionPort: SceneCanvasWorkVersionGateway = {
    commitArrangement: async (request) => {
      commits.push({ operationId: request.operationId })
      return { committed: true, commitId: `commit-${commits.length}`, skippedReason: null }
    },
    readArrangementVersion: async () => ({
      dirty: true,
      committing: false,
      commitId: 'commit-0',
      committedAt: '2026-10-15T00:00:00.000Z',
      failureMessage: null,
      contentDigest: null
    }),
    rollbackArrangement: async (request) => {
      rollbacks.push(request.commitId)
      return { commitId: 'rollback-1' }
    }
  }
  const project = projectDeps()
  return {
    editor: new SceneCanvasEditorServiceImpl({
      ...project,
      arrangements: store,
      sources: reader,
      history
    }),
    arrangement: new SceneCanvasArrangementServiceImpl({
      ...project,
      arrangements: store,
      sources: reader
    }),
    version: new SceneCanvasVersionServiceImpl({
      ...project,
      arrangements: store,
      versions: versionPort,
      history,
      createOperationId: () => `op-${(operation += 1)}`
    }),
    commits,
    rollbacks
  }
}

describe('SceneCanvas application', () => {
  it('没有编排时打开空画布，未登记工程拒绝打开', async () => {
    const store = new MemoryStore()
    const history = new MemoryHistory()
    const { editor } = services(store, history, sources({}))
    const opened = await editor.openCanvasEditor(scope)
    expect(opened.cards).toEqual([])
    expect(opened.relations).toEqual([])
    await expect(
      new SceneCanvasEditorServiceImpl({
        ...projectDeps(null),
        arrangements: store,
        sources: sources({}),
        history
      }).openCanvasEditor(scope)
    ).rejects.toMatchObject({ code: 1209 })
  })

  it('编辑指令收成关系方向，失败的一批不写入', async () => {
    const store = new MemoryStore()
    const history = new MemoryHistory()
    const { editor } = services(store, history, sources({ doc: 'text', bg: 'image' }))
    const applied = await editor.applyCanvasEdits({
      ...scope,
      edits: [
        {
          op: 'addTextCard',
          cardId: 'doc',
          textKind: 'document',
          sourceId: 'doc',
          title: '文档',
          synopsis: '',
          layout
        },
        {
          op: 'addAssetCard',
          cardId: 'bg',
          sourceId: 'bg',
          role: 'background',
          title: '背景',
          synopsis: '',
          layout
        },
        { op: 'connectCards', relationId: 'rel', fromCardId: 'doc', toCardId: 'bg' }
      ]
    })
    expect(applied.edits[2]).toMatchObject({
      relationId: 'rel',
      kind: 'realizes',
      fromCardId: 'bg',
      toCardId: 'doc'
    })
    expect(applied.canUndo).toBe(true)
    expect(store.writes).toBe(1)
    const opened = await editor.openCanvasEditor(scope)
    expect(opened.cards.map((card) => card.available)).toEqual([true, true])
    expect(history.readDepth(scope)).toEqual({ undo: 0, redo: 0 })
    await expect(
      editor.applyCanvasEdits({
        ...scope,
        edits: [
          {
            op: 'addAssetCard',
            cardId: 'bad',
            sourceId: 'bg',
            role: 'voice',
            title: '错',
            synopsis: '',
            layout
          }
        ]
      })
    ).rejects.toMatchObject({ code: SceneCanvasErrorCodes.assetRoleMismatch })
    expect(store.writes).toBe(1)
  })

  it('撤销和重做走同一条编辑路径，失败时把步骤放回', async () => {
    const store = new MemoryStore()
    const history = new MemoryHistory()
    const { editor } = services(store, history, sources({ doc: 'text' }))
    await editor.applyCanvasEdits({
      ...scope,
      edits: [
        {
          op: 'addTextCard',
          cardId: 'doc',
          textKind: 'document',
          sourceId: 'doc',
          title: '文档',
          synopsis: '',
          layout
        }
      ]
    })
    const undone = await editor.undoCanvasEdit(scope)
    expect(undone.canUndo).toBe(false)
    expect(undone.canRedo).toBe(true)
    expect(store.content?.cards).toEqual([])
    const redone = await editor.redoCanvasEdit(scope)
    expect(redone.canUndo).toBe(true)
    expect(store.content?.cards).toHaveLength(1)
    expect(await editor.undoCanvasEdit({ ...scope, canvasId: 'other' })).toMatchObject({
      edits: [],
      canUndo: false
    })

    history.push(scope, {
      forward: [{ op: 'removeCard', cardId: 'missing' }],
      inverse: [{ op: 'removeCard', cardId: 'missing' }]
    })
    await expect(editor.undoCanvasEdit(scope)).rejects.toBeInstanceOf(AppException)
    expect(history.readDepth(scope).undo).toBe(2)
  })

  it('封存前先落盘，不可读来源不交出，未填写的具体关系带标记', async () => {
    const store = new MemoryStore()
    const history = new MemoryHistory()
    const { editor, arrangement } = services(
      store,
      history,
      sources({ doc: 'text', gone: 'missing' })
    )
    await editor.applyCanvasEdits({
      ...scope,
      edits: [
        {
          op: 'addTextCard',
          cardId: 'doc',
          textKind: 'document',
          sourceId: 'doc',
          title: '文档',
          synopsis: '',
          layout
        },
        {
          op: 'addTextCard',
          cardId: 'gone',
          textKind: 'document',
          sourceId: 'gone',
          title: '丢失',
          synopsis: '',
          layout
        },
        {
          op: 'addTextCard',
          cardId: 'prompt',
          textKind: 'prompt',
          body: '整场约束',
          title: '提示词',
          synopsis: '',
          layout
        },
        { op: 'connectCards', relationId: 'rel', fromCardId: 'prompt', toCardId: 'doc' }
      ]
    })
    const sealed = await arrangement.sealArrangementForGeneration(scope)
    expect(store.flushes).toBe(1)
    expect(store.dirty).toBe(false)
    expect(sealed.cards.map((card) => card.cardId)).toEqual(['doc', 'prompt'])
    expect(sealed.relations[0]).toMatchObject({
      kind: 'constrains',
      specificUnfilled: true,
      recordCardId: null,
      recordSourceId: null
    })
  })

  it('有内容才提出提交；回退前先提交，失败时保留草稿和历史', async () => {
    const store = new MemoryStore()
    const history = new MemoryHistory()
    const { editor, version, commits, rollbacks } = services(
      store,
      history,
      sources({ doc: 'text' })
    )
    expect(await version.commitCanvasArrangement(scope)).toMatchObject({
      committed: false,
      skippedReason: 'unchanged'
    })
    expect(commits).toEqual([])
    await editor.applyCanvasEdits({
      ...scope,
      edits: [
        {
          op: 'addTextCard',
          cardId: 'doc',
          textKind: 'document',
          sourceId: 'doc',
          title: '文档',
          synopsis: '',
          layout
        }
      ]
    })
    const committed = await version.commitCanvasArrangement(scope)
    expect(store.flushes).toBe(1)
    expect(committed).toMatchObject({ committed: true, commitId: 'commit-1' })
    expect(commits.map((item) => item.operationId)).toEqual(['op-1'])
    const state = await version.readCanvasVersionState(scope)
    expect(state.commitId).toBe('commit-0')
    store.dirty = true
    const failing = new SceneCanvasVersionServiceImpl({
      ...projectDeps(),
      arrangements: store,
      history,
      createOperationId: () => 'op-fail',
      versions: {
        commitArrangement: async () => ({
          committed: true,
          commitId: 'commit-2',
          skippedReason: null
        }),
        readArrangementVersion: async () => ({
          dirty: false,
          committing: false,
          commitId: null,
          committedAt: null,
          failureMessage: null,
          contentDigest: null
        }),
        rollbackArrangement: async () => {
          throw new AppException({ code: ErrorCodes.internalError, msg: '回退失败' })
        }
      }
    })
    await expect(
      failing.rollbackCanvasArrangement({ ...scope, commitId: 'commit-1' })
    ).rejects.toMatchObject({
      code: ErrorCodes.internalError
    })
    expect(store.discarded).toBe(0)
    expect(history.readDepth(scope).undo).toBe(1)
    store.dirty = false
    const rolled = await version.rollbackCanvasArrangement({ ...scope, commitId: 'commit-1' })
    expect(rolled.commitId).toBe('rollback-1')
    expect(rollbacks).toEqual(['commit-1'])
    expect(store.discarded).toBe(1)
    expect(history.readDepth(scope)).toEqual({ undo: 0, redo: 0 })
  })
})
