import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as git from 'isomorphic-git'

import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import type { VersionContentGateway } from '@application/project-versioning/ports/VersionContentGateway'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { readRetainedBlob } from '@infrastructure/project-versioning/FileVersionContentGateway'
import { resolveProjectWorkRoot } from '@infrastructure/project-versioning/projectWorkRoot'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { realGitEffects, type GitEffects } from '@infrastructure/git/gitEffects'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

const directories: string[] = []
const text = new TextEncoder()

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('版本基础设施适配', () => {
  it('建立基线时拒绝越界路径，已有仓库再次初始化不改写历史', async () => {
    const world = await registeredProject()
    const outside = await temporaryDirectory('opengalgame-version-outside-')
    await writeFile(join(outside, 'secret.txt'), 'outside')
    const gateways = createProjectVersioningGateways(world.userDirectory)

    const escaped = await rejectionOf(
      gateways.transactions.initializeBaseline({
        projectId: 'project-1',
        initialPaths: ['../secret.txt']
      })
    )
    expect(escaped.code).toBe(ErrorCodes.forbidden)
    expect(escaped.message).toBe('路径超出允许范围')
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('outside')
    const missing = await rejectionOf(gateways.transactions.readBaseline('missing-project'))
    expect(missing.message).not.toContain(world.projectRoot)

    await writeFile(join(world.projectRoot, 'notes.txt'), '基线')
    await writeFile(join(world.projectRoot, 'other.txt'), '旁路')
    const created = await gateways.transactions.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['notes.txt']
    })
    expect(created.baselineRef).toBe(created.revisionRef)
    await expect(
      git.readBlob({
        fs,
        dir: world.projectRoot,
        oid: created.revisionRef,
        filepath: 'notes.txt'
      })
    ).resolves.toBeTruthy()
    await expect(
      git.readBlob({
        fs,
        dir: world.projectRoot,
        oid: created.revisionRef,
        filepath: 'other.txt'
      })
    ).rejects.toThrow()

    const metadata = await rejectionOf(
      gateways.transactions.initializeBaseline({
        projectId: 'project-1',
        initialPaths: ['.git/config']
      })
    )
    expect(metadata.code).toBe(ErrorCodes.forbidden)
    expect(metadata.message).not.toContain(world.projectRoot)
    const again = await gateways.transactions.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['other.txt']
    })
    expect(again.revisionRef).toBe(created.revisionRef)
    await expect(
      git.readBlob({
        fs,
        dir: world.projectRoot,
        oid: again.revisionRef,
        filepath: 'other.txt'
      })
    ).rejects.toThrow()
    const history = await git.log({ fs, dir: world.projectRoot })
    expect(history.map((entry) => entry.oid)).toEqual([created.revisionRef])
  })

  it('已有 HEAD 只补声明中缺失的路径，重复调用不新增提交', async () => {
    const world = await registeredProject()
    await writeFile(join(world.projectRoot, 'keep.txt'), '保留')
    await writeFile(join(world.projectRoot, 'extra.txt'), '旁路')
    const gateways = createProjectVersioningGateways(world.userDirectory)
    const created = await gateways.transactions.initializeBaseline({
      projectId: 'project-1',
      initialPaths: ['keep.txt']
    })
    await writeFile(join(world.projectRoot, 'added.txt'), '补充')
    const supplemented = await gateways.transactions.ensureDeclaredPaths({
      projectId: 'project-1',
      paths: ['keep.txt', 'added.txt', 'missing.txt']
    })
    expect(supplemented.revisionRef).not.toBe(created.revisionRef)
    await expect(
      git.readBlob({
        fs,
        dir: world.projectRoot,
        oid: supplemented.revisionRef,
        filepath: 'added.txt'
      })
    ).resolves.toBeTruthy()
    await expect(
      git.readBlob({
        fs,
        dir: world.projectRoot,
        oid: supplemented.revisionRef,
        filepath: 'extra.txt'
      })
    ).rejects.toThrow()
    await expect(readFile(join(world.projectRoot, 'keep.txt'), 'utf8')).resolves.toBe('保留')
    const again = await gateways.transactions.ensureDeclaredPaths({
      projectId: 'project-1',
      paths: ['keep.txt', 'added.txt', 'missing.txt']
    })
    expect(again.revisionRef).toBe(supplemented.revisionRef)
    expect((await git.log({ fs, dir: world.projectRoot })).map((entry) => entry.oid)).toEqual([
      supplemented.revisionRef,
      created.revisionRef
    ])
  })

  it('限定提交只发布声明路径，重启后仍能核对，后续修改阻止回退', async () => {
    const world = await seededProject('原始')
    const first = serviceFor(world.userDirectory, ['op-1', 'hist-1'])
    const prepared = await first.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story.txt'],
      watchedPaths: ['watch.txt']
    })
    await writeFile(join(world.projectRoot, 'watch.txt'), '被改动')
    await expect(commitStory(first, 'op-1', prepared.baselineRef, '新章节')).rejects.toMatchObject({
      code: ErrorCodes.operationConflict
    })
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)

    await writeFile(join(world.projectRoot, 'watch.txt'), '观察')
    const committed = await commitStory(first, 'op-1', prepared.baselineRef, '新章节')
    expect(committed.state).toBe('已提交')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('新章节')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    const committedBlob = await git.readBlob({
      fs,
      dir: world.projectRoot,
      oid: committed.revisionRef,
      filepath: 'story.txt'
    })
    expect(Buffer.from(committedBlob.blob).toString()).toBe('新章节')
    const published = await git.readCommit({
      fs,
      dir: world.projectRoot,
      oid: committed.revisionRef
    })
    const changed = await git.walk({
      fs,
      dir: world.projectRoot,
      trees: [
        git.TREE({ ref: published.commit.parent[0] }),
        git.TREE({ ref: committed.revisionRef })
      ],
      map: async (filepath, [before, after]) => {
        if (!before && !after) return
        if (
          (before && (await before.type()) === 'tree') ||
          (after && (await after.type()) === 'tree')
        ) {
          return
        }
        const beforeOid = before ? await before.oid() : null
        const afterOid = after ? await after.oid() : null
        return beforeOid === afterOid ? undefined : filepath
      }
    })
    expect(changed.filter((path) => path !== undefined)).toEqual(['story.txt'])

    const restarted = serviceFor(world.userDirectory, [])
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-1' })
    ).resolves.toMatchObject({ state: '已提交', revisionRef: committed.revisionRef })
    const page = await restarted.listHistory({ projectId: 'project-1', pageSize: 10 })
    expect(page.entries.map((entry) => entry.historyId)).toEqual(['hist-1'])
    expect(page.entries[0]).toMatchObject({
      state: '已提交',
      saveMode: 'manual',
      contentSource: 'operation',
      title: '保存章节'
    })

    await writeFile(join(world.projectRoot, 'story.txt'), '后续修改')
    await expect(
      restarted.rollbackOperation({ projectId: 'project-1', operationId: 'op-1' })
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('后续修改')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    expect((await git.log({ fs, dir: world.projectRoot })).map((entry) => entry.oid)).toContain(
      committed.revisionRef
    )

    await writeFile(join(world.projectRoot, 'story.txt'), '新章节')
    const rolled = await restarted.rollbackOperation({
      projectId: 'project-1',
      operationId: 'op-1'
    })
    expect(rolled.state).toBe('已回退')
    expect(rolled.revisionRef).not.toBe(committed.revisionRef)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    const afterRollback = await git.log({ fs, dir: world.projectRoot })
    expect(afterRollback.map((entry) => entry.oid)).toEqual([
      rolled.revisionRef,
      committed.revisionRef,
      afterRollback[2]?.oid
    ])
    const visible = await restarted.listHistory({ projectId: 'project-1', pageSize: 10 })
    expect(visible.entries[0]).toMatchObject({ historyId: 'hist-1', state: '已回退' })
  })

  it('删除结算后，首次新文件提交在新进程仍认领为已提交', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['op-new', 'hist-new'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['scene/new.txt'],
      watchedPaths: []
    })
    const committed = await commitStory(
      versioning,
      'op-new',
      prepared.baselineRef,
      '新文件',
      'scene/new.txt'
    )
    expect(committed.state).toBe('已提交')
    await expect(readFile(join(world.projectRoot, 'scene/new.txt'), 'utf8')).resolves.toBe('新文件')
    await rm(join(world.projectRoot, '.git', 'opengalgame', 'version-settlements', 'op-new.json'))

    const restarted = serviceFor(world.userDirectory, ['op-unused', 'hist-unused'])
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-new' })
    ).resolves.toEqual({
      operationId: 'op-new',
      state: '已提交',
      revisionRef: committed.revisionRef
    })
    await expect(
      commitStory(restarted, 'op-new', prepared.baselineRef, '新文件', 'scene/new.txt')
    ).resolves.toEqual(committed)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('动作被改成删除时，删除结算后不能认领已提交', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['op-action', 'hist-action'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const committed = await commitStory(versioning, 'op-action', prepared.baselineRef, '已保存')
    const recordPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'operations',
      'op-action.json'
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      paths: Array<{ action: string }>
    }
    record.paths[0]!.action = 'delete'
    await writeFile(recordPath, JSON.stringify(record))
    await rm(
      join(world.projectRoot, '.git', 'opengalgame', 'version-settlements', 'op-action.json')
    )

    const restarted = serviceFor(world.userDirectory, ['op-action-unused', 'hist-action-unused'])
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-action' })
    ).resolves.toMatchObject({ state: '待核对' })
    expect(committed.revisionRef).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('相同内容不产生新提交，也不进入用户历史', async () => {
    const world = await seededProject('原文')
    const versioning = serviceFor(world.userDirectory, ['op-same', 'hist-same'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const unchanged = await commitStory(versioning, 'op-same', prepared.baselineRef, '原文')
    expect(unchanged).toMatchObject({ state: '无变更' })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
    await expect(versioning.listHistory({ projectId: 'project-1', pageSize: 5 })).resolves.toEqual({
      entries: [],
      nextCursor: null
    })
  })

  it('工作区已有声明字节时可以提交，短边界替换和其他路径改动仍拒绝', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, [
      'op-disk',
      'hist-disk',
      'op-same',
      'hist-same',
      'op-swap',
      'hist-swap',
      'op-watch',
      'hist-watch'
    ])
    await writeFile(join(world.projectRoot, 'extra.txt'), '已落盘')
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['extra.txt'],
      watchedPaths: ['watch.txt']
    })
    const committed = await commitStory(
      versioning,
      'op-disk',
      prepared.baselineRef,
      '已落盘',
      'extra.txt'
    )
    expect(committed.state).toBe('已提交')
    expect(await committedPaths(world.projectRoot, committed.revisionRef)).toEqual(['extra.txt'])
    const published = await git.readBlob({
      fs,
      dir: world.projectRoot,
      oid: committed.revisionRef,
      filepath: 'extra.txt'
    })
    expect(Buffer.from(published.blob).toString()).toBe('已落盘')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)

    const same = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['extra.txt'],
      watchedPaths: []
    })
    const unchanged = await commitStory(
      versioning,
      'op-same',
      same.baselineRef,
      '已落盘',
      'extra.txt'
    )
    expect(unchanged).toMatchObject({ state: '无变更', revisionRef: committed.revisionRef })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)

    const swapping = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['extra.txt'],
      watchedPaths: []
    })
    await writeFile(join(world.projectRoot, 'extra.txt'), '将被替换')
    await expect(
      versioning.commitOperation(
        {
          projectId: 'project-1',
          operationId: 'op-swap',
          baselineRef: swapping.baselineRef,
          input: {
            kind: 'files',
            changes: [
              {
                relativePath: 'extra.txt',
                action: 'modify',
                content: { kind: 'bytes', bytes: text.encode('将被替换') }
              }
            ]
          },
          saveMode: 'manual',
          contentSource: 'operation',
          title: '保存章节',
          summary: '更新正文'
        },
        async () => {
          await writeFile(join(world.projectRoot, 'extra.txt'), '短边界替换')
        }
      )
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    expect((await git.log({ fs, dir: world.projectRoot })).map((entry) => entry.oid)[0]).toBe(
      committed.revisionRef
    )
    await expect(readFile(join(world.projectRoot, 'extra.txt'), 'utf8')).resolves.toBe('短边界替换')
    const kept = await git.readBlob({
      fs,
      dir: world.projectRoot,
      oid: committed.revisionRef,
      filepath: 'extra.txt'
    })
    expect(Buffer.from(kept.blob).toString()).toBe('已落盘')

    const watched = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story.txt'],
      watchedPaths: ['watch.txt']
    })
    await writeFile(join(world.projectRoot, 'story.txt'), '声明正文')
    await writeFile(join(world.projectRoot, 'watch.txt'), '旁路改动')
    await expect(
      commitStory(versioning, 'op-watch', watched.baselineRef, '声明正文')
    ).rejects.toMatchObject({ code: ErrorCodes.operationConflict })
    expect((await git.log({ fs, dir: world.projectRoot })).map((entry) => entry.oid)[0]).toBe(
      committed.revisionRef
    )
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('声明正文')
    const story = await git.readBlob({
      fs,
      dir: world.projectRoot,
      oid: committed.revisionRef,
      filepath: 'story.txt'
    })
    expect(Buffer.from(story.blob).toString()).toBe('原始')
  })

  it('内联字节形成可重启核对的凭据，不能证明的来源引用明确失败', async () => {
    const world = await seededProject('原文')
    const content = createProjectVersioningGateways(world.userDirectory).content
    const bytes = text.encode('保留正文')
    const request = {
      projectId: 'project-1',
      operationId: 'op-content',
      fingerprint: 'fingerprint-1',
      input: {
        kind: 'files' as const,
        changes: [
          {
            relativePath: 'story.txt',
            action: 'modify' as const,
            content: { kind: 'bytes' as const, bytes }
          },
          { relativePath: 'gone.txt', action: 'delete' as const }
        ]
      }
    }
    const retained = await content.retain(request)
    expect(retained[1]).toEqual({ relativePath: 'gone.txt', action: 'delete', retentionRef: null })
    expect(retained[0]?.retentionRef).toMatch(/^[0-9a-f]{64}$/u)

    const reopened = createProjectVersioningGateways(world.userDirectory).content
    await expect(reopened.retain(request)).resolves.toEqual(retained)
    await expect(
      reopened.retain({
        projectId: 'project-1',
        operationId: 'op-content',
        fingerprint: 'fingerprint-2',
        input: {
          kind: 'files',
          changes: [
            {
              relativePath: 'story.txt',
              action: 'modify',
              content: { kind: 'bytes', bytes: text.encode('另一份') }
            }
          ]
        }
      })
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.contentFingerprintConflict })
    await expect(
      reopened.retain({
        projectId: 'project-1',
        operationId: 'op-candidate',
        fingerprint: 'fingerprint-3',
        input: { kind: 'candidate', candidateRef: 'candidate-1', changes: [] }
      })
    ).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.invalidContentFingerprint,
      message: '内容身份不能固定'
    })
    await expect(
      reopened.retain({
        projectId: 'project-1',
        operationId: 'op-prepared',
        fingerprint: 'fingerprint-4',
        input: {
          kind: 'files',
          changes: [
            {
              relativePath: 'story.txt',
              action: 'modify',
              content: { kind: 'prepared', contentRef: 'source-ref' }
            }
          ]
        }
      })
    ).rejects.toMatchObject({ message: '内容身份不能固定' })
  })

  it('场景候选凭据绑定工程、操作和指纹，重启后仍读到同一内容', async () => {
    const world = await seededProject('原稿')
    const files = new AiProjectFileSystemImpl(world.userDirectory)
    const workspace = await files.createWorkspace({
      projectId: 'project-1',
      threadId: 'thread-1',
      operationId: 'caller-scene',
      projectRoot: world.projectRoot,
      sourcePaths: ['story.txt']
    })
    await files.writeFile(workspace, 'story.txt', text.encode('确认稿'))
    const revision = await files.saveRevision(workspace)
    await files.discardWorkspace(workspace)
    const content = createProjectVersioningGateways(world.userDirectory).content
    const request = {
      projectId: 'project-1',
      operationId: 'op-scene-keep',
      fingerprint: 'fingerprint-scene',
      input: {
        kind: 'candidate' as const,
        candidateRef: `scene-generation\0project-1\0thread-1\0caller-scene\0${revision.revisionId}`,
        changes: [{ relativePath: 'story.txt', action: 'modify' as const }]
      }
    }

    const retained = await content.retain(request)
    expect(retained).toEqual([
      {
        relativePath: 'story.txt',
        action: 'modify',
        retentionRef: expect.stringMatching(/^[0-9a-f]{64}$/u)
      }
    ])
    const root = await resolveProjectWorkRoot(world.userDirectory, 'project-1')
    await expect(readRetainedBlob(root, retained[0]!.retentionRef!)).resolves.toEqual(
      text.encode('确认稿')
    )

    const reopened = createProjectVersioningGateways(world.userDirectory).content
    await expect(reopened.retain(request)).resolves.toEqual(retained)
    await expect(readRetainedBlob(root, retained[0]!.retentionRef!)).resolves.toEqual(
      text.encode('确认稿')
    )
    await files.writeFile(
      await files.restoreRevision({
        projectId: 'project-1',
        threadId: 'thread-1',
        operationId: 'caller-scene',
        revisionId: revision.revisionId
      }),
      'story.txt',
      text.encode('工作区已变')
    )
    await expect(reopened.retain(request)).resolves.toEqual(retained)
    await expect(readRetainedBlob(root, retained[0]!.retentionRef!)).resolves.toEqual(
      text.encode('确认稿')
    )
  })

  it('无法证明的候选引用和错绑的工程、操作或指纹不能形成凭据', async () => {
    const world = await seededProject('原稿')
    const files = new AiProjectFileSystemImpl(world.userDirectory)
    const workspace = await files.createWorkspace({
      projectId: 'project-1',
      threadId: 'thread-1',
      operationId: 'caller-scene',
      projectRoot: world.projectRoot,
      sourcePaths: ['story.txt']
    })
    await files.writeFile(workspace, 'story.txt', text.encode('确认稿'))
    const revision = await files.saveRevision(workspace)
    const content = createProjectVersioningGateways(world.userDirectory).content
    const proven = {
      projectId: 'project-1',
      operationId: 'op-scene-proof',
      fingerprint: 'fingerprint-proof',
      input: {
        kind: 'candidate' as const,
        candidateRef: `scene-generation\0project-1\0thread-1\0caller-scene\0${revision.revisionId}`,
        changes: [{ relativePath: 'story.txt', action: 'modify' as const }]
      }
    }
    await content.retain(proven)

    await expect(retainCandidate(content, 'candidate-1')).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.invalidContentFingerprint
    })
    await expect(retainCandidate(content, workspace.rootDirectory)).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.invalidContentFingerprint
    })
    await expect(retainCandidate(content, revision.revisionId)).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.invalidContentFingerprint
    })
    await expect(
      content.retain({ ...proven, projectId: 'project-2', operationId: 'op-other-project' })
    ).rejects.toMatchObject({ code: ErrorCodes.invalidRequest, message: '工程不可用' })
    await expect(
      content.retain({
        ...proven,
        operationId: 'op-other',
        input: {
          ...proven.input,
          candidateRef: `scene-generation\0project-1\0thread-1\0other-caller\0${revision.revisionId}`
        }
      })
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.invalidContentFingerprint })
    await expect(
      content.retain({ ...proven, fingerprint: 'fingerprint-other' })
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.contentFingerprintConflict })
  })

  it('清理只移除可见历史，作品提交和操作记录仍在', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['op-clear', 'hist-clear'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'file-1' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const committed = await commitStory(versioning, 'op-clear', prepared.baselineRef, '已保存')
    const cleared = await versioning.clearHistory({
      projectId: 'project-1',
      selection: { kind: 'entry', historyId: 'hist-clear' }
    })
    expect(cleared.clearedCount).toBe(1)
    await expect(versioning.listHistory({ projectId: 'project-1', pageSize: 10 })).resolves.toEqual(
      {
        entries: [],
        nextCursor: null
      }
    )
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('已保存')
    await expect(
      git.readBlob({
        fs,
        dir: world.projectRoot,
        oid: committed.revisionRef,
        filepath: 'story.txt'
      })
    ).resolves.toBeTruthy()
    const reopened = createProjectVersioningGateways(world.userDirectory)
    await expect(reopened.records.read('project-1', 'op-clear')).resolves.toMatchObject({
      operationId: 'op-clear',
      commitIntent: { historyId: 'hist-clear' }
    })
    await expect(reopened.history.resolveActive('project-1', 'hist-clear')).resolves.toBeNull()
  })

  it('技术失败不把路径、原始错误或堆栈返回给应用', async () => {
    const world = await seededProject('原始')
    const secret = 'SECRET_PROJECT_ROOT'
    const effects: GitEffects = {
      ...realGitEffects,
      writeCommit: () => {
        throw new Error(`fatal: ${secret}\\.git write failed\n${new Error(secret).stack}`)
      }
    }
    const versioning = serviceFor(world.userDirectory, ['op-fail', 'hist-fail'], effects)
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const error = await rejectionOf(
      commitStory(versioning, 'op-fail', prepared.baselineRef, '失败章节')
    )
    expect(error).toBeInstanceOf(AppException)
    expect(error.code).toBe(ProjectVersioningErrorCodes.gitUnavailable)
    expect(error.message).not.toContain(secret)
    expect(error.message).not.toContain('fatal')
    expect(error.message).not.toContain('.git')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
  })

  it('符号链接不能把仓库外文件提交进作品', async () => {
    const world = await seededProject('原始')
    const outside = await temporaryDirectory('opengalgame-version-link-')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(world.projectRoot, 'linked.txt'))
    const versioning = serviceFor(world.userDirectory, ['op-link', 'hist-link'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['linked.txt'],
      watchedPaths: []
    })
    const error = await rejectionOf(
      commitStory(versioning, 'op-link', prepared.baselineRef, '链接', 'linked.txt')
    )
    expect(error).toBeInstanceOf(AppException)
    expect(error.code).toBe(ErrorCodes.forbidden)
    expect(error.message).not.toContain(outside)
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function registeredProject(): Promise<{ userDirectory: string; projectRoot: string }> {
  const root = await temporaryDirectory('opengalgame-version-')
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(projectRoot)
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: projectRoot, operationId: 'op-register' }
  ])
  return { userDirectory, projectRoot }
}

async function seededProject(
  content: string
): Promise<{ userDirectory: string; projectRoot: string }> {
  const world = await registeredProject()
  await writeFile(join(world.projectRoot, 'story.txt'), content)
  await writeFile(join(world.projectRoot, 'watch.txt'), '观察')
  await createProjectVersioningGateways(world.userDirectory).transactions.initializeBaseline({
    projectId: 'project-1',
    initialPaths: ['story.txt', 'watch.txt']
  })
  return world
}

function serviceFor(
  userDirectory: string,
  ids: readonly string[],
  effects?: GitEffects
): ProjectVersioningApplicationServiceImpl {
  const remaining = [...ids]
  const gateways = createProjectVersioningGateways(userDirectory, effects)
  return new ProjectVersioningApplicationServiceImpl({
    ...gateways,
    nextId: () => {
      const next = remaining.shift()
      if (!next) throw new Error('测试身份已用尽')
      return next
    }
  })
}

function commitStory(
  versioning: ProjectVersioningApplicationServiceImpl,
  operationId: string,
  baselineRef: string,
  content: string,
  relativePath = 'story.txt'
): Promise<{ operationId: string; state: '已提交' | '无变更'; revisionRef: string }> {
  return versioning.commitOperation(
    {
      projectId: 'project-1',
      operationId,
      baselineRef,
      input: {
        kind: 'files',
        changes: [
          {
            relativePath,
            action: 'modify',
            content: { kind: 'bytes', bytes: text.encode(content) }
          }
        ]
      },
      saveMode: 'manual',
      contentSource: 'operation',
      title: '保存章节',
      summary: '更新正文'
    },
    () => undefined
  )
}

async function rejectionOf(operation: Promise<unknown>): Promise<AppException> {
  try {
    await operation
  } catch (error) {
    return error as AppException
  }
  throw new Error('操作应当失败')
}

function retainCandidate(
  content: VersionContentGateway,
  candidateRef: string
): Promise<readonly unknown[]> {
  return content.retain({
    projectId: 'project-1',
    operationId: 'op-unproven',
    fingerprint: 'fingerprint-unproven',
    input: {
      kind: 'candidate',
      candidateRef,
      changes: [{ relativePath: 'story.txt', action: 'modify' }]
    }
  })
}

async function committedPaths(projectRoot: string, revisionRef: string): Promise<string[]> {
  const published = await git.readCommit({ fs, dir: projectRoot, oid: revisionRef })
  const changed = await git.walk({
    fs,
    dir: projectRoot,
    trees: [git.TREE({ ref: published.commit.parent[0] }), git.TREE({ ref: revisionRef })],
    map: async (filepath, [before, after]) => {
      if (!before && !after) return
      if (
        (before && (await before.type()) === 'tree') ||
        (after && (await after.type()) === 'tree')
      ) {
        return
      }
      const beforeOid = before ? await before.oid() : null
      const afterOid = after ? await after.oid() : null
      return beforeOid === afterOid ? undefined : filepath
    }
  })
  return changed.filter((path): path is string => path !== undefined)
}
