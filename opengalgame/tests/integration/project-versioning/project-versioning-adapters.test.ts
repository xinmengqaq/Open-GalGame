import * as fs from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as git from 'isomorphic-git'

import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import type { VersionContentGateway } from '@application/project-versioning/ports/VersionContentGateway'
import { createProjectServices } from '@bootstrap/projects'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { readRetainedBlob } from '@infrastructure/project-versioning/FileVersionContentGateway'
import { resolveProjectWorkRoot } from '@infrastructure/project-versioning/projectWorkRoot'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectVersioningErrorCodes } from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import { realGitEffects, type GitEffects } from '@infrastructure/git/gitEffects'
import { readStageOids } from '@infrastructure/git/repository/WorkBaseline'
import { repairPublishedMetadata } from '@infrastructure/git/transaction/LimitedCommit'
import { assessOperation } from '@infrastructure/git/transaction/OperationQuery'
import { LocalProjectWorkVersionGatewayImpl } from '@infrastructure/project-files/LocalProjectWorkVersionGatewayImpl'
import { GitVersionTransactionGateway } from '@infrastructure/project-versioning/GitVersionTransactionGateway'
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

  it('项目文件显式回退先完整备份，只恢复记录路径', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-backup'
    const versioning = serviceFor(world.userDirectory, [operationId, 'hist-rollback-backup'])
    await commitProjectFile(versioning, operationId, '新章节')
    const before = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { paths: Array<{ originalStageOid: string }> }
    await writeFile(join(world.projectRoot, 'story.txt'), '外部修改')
    await git.add({ fs, dir: world.projectRoot, filepath: 'story.txt' })
    await writeFile(join(world.projectRoot, 'unrelated.txt'), '旁路内容')

    const rolled = await versioning.rollbackOperation({
      projectId: 'project-1',
      operationId
    })
    expect(rolled.state).toBe('已回退')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'unrelated.txt'), 'utf8')).resolves.toBe(
      '旁路内容'
    )
    const attempts = await backupAttempts(world.projectRoot, operationId)
    expect(attempts).toHaveLength(1)
    expect(await backupContainsText(world.projectRoot, operationId, '外部修改')).toBe(true)
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; rollbackBackupId?: string }
    expect(record.phase).toBe('rolled-back')
    expect(record.rollbackBackupId).toBe(attempts[0])
    expect((await readStageOids(world.projectRoot, ['story.txt'])).get('story.txt')).toBe(
      before.paths[0].originalStageOid
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
    await expect(
      versioning.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toMatchObject({ state: '已回退' })
  })

  it('回退父基于后续已提交修改时允许备份回退并保留无关提交/暂存', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-successor-parent'
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-successor-parent']
    )
    await commitProjectFile(versioning, operationId, '新章节')
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { forwardCommitId: string }
    await writeFile(join(world.projectRoot, 'story.txt'), '外部已提交目标')
    await writeFile(join(world.projectRoot, 'other.txt'), '外部已提交旁路')
    await git.add({
      fs,
      dir: world.projectRoot,
      filepath: ['story.txt', 'other.txt']
    })
    const author = {
      name: 'test',
      email: 'test@example.com',
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0
    }
    const successor = await git.commit({
      fs,
      dir: world.projectRoot,
      message: '外部提交目标修改',
      author
    })
    await writeFile(join(world.projectRoot, 'staged.txt'), '暂存旁路')
    await git.add({ fs, dir: world.projectRoot, filepath: 'staged.txt' })
    const stagedBefore = await readStageOids(world.projectRoot, ['staged.txt'])

    const rolled = await versioning.rollbackOperation({
      projectId: 'project-1',
      operationId
    })
    expect(rolled.state).toBe('已回退')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'other.txt'), 'utf8')).resolves.toBe(
      '外部已提交旁路'
    )
    await expect(readFile(join(world.projectRoot, 'staged.txt'), 'utf8')).resolves.toBe('暂存旁路')
    expect((await readStageOids(world.projectRoot, ['staged.txt'])).get('staged.txt')).toBe(
      stagedBefore.get('staged.txt')
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(4)
    expect(record.forwardCommitId).not.toBe(successor)
    await expect(
      assessOperation(world.projectRoot, operationId)
    ).resolves.toMatchObject({ state: 'rolledBack' })

    const restarted = serviceFor(world.userDirectory, [])
    await restarted.recoverProject('project-1', 'project-files')
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toMatchObject({ state: '已回退' })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(4)
  })

  it('回退提交内容、身份或父祖先不符时硬错误且不写阶段结算', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-proof-conflict'
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-proof-conflict']
    )
    await commitProjectFile(versioning, operationId, '新章节')
    const recordPath = operationRecordPath(world.projectRoot, operationId)
    const baseRecord = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    const forward = baseRecord.forwardCommitId as string
    const baseline = baseRecord.baselineCommitId as string
    const author = {
      name: 'test',
      email: 'test@example.com',
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0
    }
    const writeRecord = async (patch: Record<string, unknown>): Promise<void> => {
      await writeFile(recordPath, JSON.stringify({ ...baseRecord, ...patch }))
    }

    await writeFile(join(world.projectRoot, 'story.txt'), '错误回退内容')
    await git.add({ fs, dir: world.projectRoot, filepath: 'story.txt' })
    const wrongContent = await git.commit({
      fs,
      dir: world.projectRoot,
      message: `回退作品文件\n\nOperation-Id: ${operationId}\nRollback-Of: ${forward}\n`,
      author
    })
    await writeRecord({ phase: 'rolled-back', rollbackCommitId: wrongContent })
    const contentError = await rejectionOf(assessOperation(world.projectRoot, operationId))
    expect(contentError.code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    expect(contentError.message).toContain('回退提交内容与原始字节不一致')

    await writeFile(join(world.projectRoot, 'story.txt'), '原始')
    await git.add({ fs, dir: world.projectRoot, filepath: 'story.txt' })
    const wrongIdentity = await git.commit({
      fs,
      dir: world.projectRoot,
      message: `回退作品文件\n\nOperation-Id: other-operation\nRollback-Of: ${forward}\n`,
      author
    })
    await writeRecord({ phase: 'rolled-back', rollbackCommitId: wrongIdentity })
    const identityError = await rejectionOf(assessOperation(world.projectRoot, operationId))
    expect(identityError.code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    expect(identityError.message).toContain('回退提交身份与操作不一致')

    const headCommit = await git.readCommit({
      fs,
      dir: world.projectRoot,
      oid: wrongIdentity
    })
    const wrongParent = await git.writeCommit({
      fs,
      dir: world.projectRoot,
      commit: {
        tree: headCommit.commit.tree,
        parent: [baseline],
        message: `回退作品文件\n\nOperation-Id: ${operationId}\nRollback-Of: ${forward}\n`,
        author,
        committer: author
      }
    })
    await writeRecord({ phase: 'rolled-back', rollbackCommitId: wrongParent })
    const parentError = await rejectionOf(assessOperation(world.projectRoot, operationId))
    expect(parentError.code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    expect(parentError.message).toContain('回退提交父提交不基于前向提交')

    await writeRecord({ phase: 'rollback-required', rollbackCommitId: wrongContent })
    const recordStat = (await stat(recordPath)).mtimeMs
    const settlementStat = (await stat(settlementPath(world.projectRoot, operationId))).mtimeMs
    const logBefore = (await git.log({ fs, dir: world.projectRoot })).length
    const restarted = serviceFor(world.userDirectory, [])
    await expect(restarted.recoverProject('project-1', 'project-files')).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed
    })
    expect((await stat(recordPath)).mtimeMs).toBe(recordStat)
    expect((await stat(settlementPath(world.projectRoot, operationId))).mtimeMs).toBe(
      settlementStat
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(logBefore)
  })

  it('项目文件回退备份写入失败时不改正式文件和记录', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-backup-fail'
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (absolutePath.includes('compensation-backups')) {
          throw new Error('回退备份写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-backup-fail'],
      effects
    )
    await commitProjectFile(versioning, operationId, '新章节')
    await writeFile(join(world.projectRoot, 'story.txt'), '外部修改')
    const stageBefore = await readStageOids(world.projectRoot, ['story.txt'])

    const error = await rejectionOf(
      versioning.rollbackOperation({ projectId: 'project-1', operationId })
    )
    expect(error.code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('外部修改')
    expect((await readStageOids(world.projectRoot, ['story.txt'])).get('story.txt')).toBe(
      stageBefore.get('story.txt')
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; rollbackBackupId?: string }
    expect(record.phase).toBe('published')
    expect(record.rollbackBackupId).toBeUndefined()
    await expect(
      versioning.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toMatchObject({ state: '已提交' })
  })

  it('项目文件回退备份后发生外部修改时停止恢复', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-backup-changed'
    let mutated = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        await realGitEffects.writeBytes(absolutePath, bytes)
        if (
          !mutated &&
          absolutePath.includes('compensation-backups') &&
          absolutePath.endsWith('manifest.json')
        ) {
          mutated = true
          await writeFile(join(world.projectRoot, 'story.txt'), '备份后外部修改')
        }
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-backup-changed'],
      effects
    )
    await commitProjectFile(versioning, operationId, '新章节')
    await writeFile(join(world.projectRoot, 'story.txt'), '外部修改')

    const error = await rejectionOf(
      versioning.rollbackOperation({ projectId: 'project-1', operationId })
    )
    expect(error.code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '备份后外部修改'
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    expect(await backupContainsText(world.projectRoot, operationId, '外部修改')).toBe(true)
    expect(await backupContainsText(world.projectRoot, operationId, '备份后外部修改')).toBe(false)
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string }
    expect(record.phase).toBe('published')
  })

  it('已发布回退缺记录和结算时由工程打开补证且不重复回退', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-published-repair'
    let failed = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeRecord: async (projectRoot, record) => {
        if (record.phase === 'rolled-back' && !failed) {
          failed = true
          throw new Error('回退完成记录写入失败')
        }
        return realGitEffects.writeRecord(projectRoot, record)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-published-repair'],
      effects
    )
    await commitProjectFile(versioning, operationId, '新章节')
    const outcome = await versioning
      .rollbackOperation({ projectId: 'project-1', operationId })
      .catch((error: unknown) => error)
    if (outcome instanceof AppException) {
      expect(outcome.code).toBe(ProjectVersioningErrorCodes.insufficientEvidence)
    } else {
      expect(outcome).toMatchObject({ state: '已回退' })
    }
    const head = await git.resolveRef({ fs, dir: world.projectRoot, ref: 'HEAD' })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
    const failedRecord = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; rollbackCommitId?: string }
    expect(failedRecord.phase).toBe('rollback-required')
    expect(failedRecord.rollbackCommitId).toBe(head)

    const missing = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as Record<string, unknown>
    missing.phase = 'published'
    missing.rollbackCommitId = null
    await writeFile(
      operationRecordPath(world.projectRoot, operationId),
      JSON.stringify(missing)
    )
    await rm(settlementPath(world.projectRoot, operationId), { force: true })

    const restarted = serviceFor(world.userDirectory, [])
    await restarted.recoverProject('project-1', 'project-files')
    const repaired = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; rollbackCommitId?: string }
    expect(repaired.phase).toBe('rolled-back')
    expect(repaired.rollbackCommitId).toBe(head)
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toMatchObject({ state: '已回退' })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)

    const recordStat = (await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs
    const settlementStat = (await stat(settlementPath(world.projectRoot, operationId))).mtimeMs
    await restarted.recoverProject('project-1', 'project-files')
    expect((await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs).toBe(
      recordStat
    )
    expect((await stat(settlementPath(world.projectRoot, operationId))).mtimeMs).toBe(
      settlementStat
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
  })

  it('回退中断后工程打开恢复且重复恢复不新增提交', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-interrupted'
    const effects: GitEffects = {
      ...realGitEffects,
      writeCommit: async (projectRoot, input) => {
        if (input.message.includes('回退作品文件')) {
          throw new Error('回退提交写入中断')
        }
        return realGitEffects.writeCommit(projectRoot, input)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-interrupted'],
      effects
    )
    await commitProjectFile(versioning, operationId, '新章节')
    await writeFile(join(world.projectRoot, 'story.txt'), '外部修改')
    await expect(
      versioning.rollbackOperation({ projectId: 'project-1', operationId })
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    const interrupted = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; rollbackBackupId?: string }
    expect(interrupted.phase).toBe('rollback-required')
    expect(interrupted.rollbackBackupId).toBeTruthy()
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(1)

    const restarted = serviceFor(world.userDirectory, [])
    await restarted.recoverProject('project-1', 'project-files')
    const rolled = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string }
    expect(rolled.phase).toBe('rolled-back')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toMatchObject({ state: '已回退' })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(2)

    const recordStat = (await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs
    const settlementStat = (await stat(settlementPath(world.projectRoot, operationId))).mtimeMs
    await restarted.recoverProject('project-1', 'project-files')
    expect((await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs).toBe(
      recordStat
    )
    expect((await stat(settlementPath(world.projectRoot, operationId))).mtimeMs).toBe(
      settlementStat
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(2)
  })

  it('回退备份清单损坏时工程打开硬错误且不继续恢复', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-corrupt-backup'
    const effects: GitEffects = {
      ...realGitEffects,
      writeCommit: async (projectRoot, input) => {
        if (input.message.includes('回退作品文件')) {
          throw new Error('回退提交写入中断')
        }
        return realGitEffects.writeCommit(projectRoot, input)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-corrupt-backup'],
      effects
    )
    await commitProjectFile(versioning, operationId, '新章节')
    await writeFile(join(world.projectRoot, 'story.txt'), '外部修改')
    await expect(
      versioning.rollbackOperation({ projectId: 'project-1', operationId })
    ).rejects.toBeInstanceOf(AppException)
    const attempts = await backupAttempts(world.projectRoot, operationId)
    expect(attempts).toHaveLength(1)
    await writeFile(
      join(compensationBackupRoot(world.projectRoot, operationId), attempts[0], 'manifest.json'),
      '{损坏'
    )

    const restarted = serviceFor(world.userDirectory, [])
    await expect(restarted.recoverProject('project-1', 'project-files')).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed
    })
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(1)
  })

  it('回退记录标识或提交证据冲突时查询硬错误且只读', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-rollback-query-conflict'
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-rollback-query-conflict']
    )
    await commitProjectFile(versioning, operationId, '新章节')
    await versioning.rollbackOperation({ projectId: 'project-1', operationId })
    const recordPath = operationRecordPath(world.projectRoot, operationId)
    const original = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    const head = await git.resolveRef({ fs, dir: world.projectRoot, ref: 'HEAD' })
    const headCommit = await git.readCommit({ fs, dir: world.projectRoot, oid: head })
    const author = {
      name: 'test',
      email: 'test@example.com',
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0
    }
    const orphan = await git.writeCommit({
      fs,
      dir: world.projectRoot,
      commit: {
        tree: headCommit.commit.tree,
        parent: [head],
        message: `回退作品文件\n\nOperation-Id: ${operationId}\nRollback-Of: ${String(original.forwardCommitId)}\n`,
        author: { ...author, timestamp: (headCommit.commit.author.timestamp ?? 0) + 1 },
        committer: { ...author, timestamp: (headCommit.commit.author.timestamp ?? 0) + 1 }
      }
    })

    const missingId = { ...original }
    missingId.rollbackCommitId = null
    await writeFile(recordPath, JSON.stringify(missingId))
    await expect(assessOperation(world.projectRoot, operationId)).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      message: '回退记录缺少回退提交标识'
    })

    await writeFile(recordPath, JSON.stringify({ ...original, rollbackCommitId: '0'.repeat(40) }))
    await expect(assessOperation(world.projectRoot, operationId)).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      message: '回退提交对象缺失'
    })

    await writeFile(recordPath, JSON.stringify({ ...original, rollbackCommitId: orphan }))
    const statBefore = (await stat(recordPath)).mtimeMs
    await expect(assessOperation(world.projectRoot, operationId)).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed,
      message: '回退提交不在当前历史中'
    })
    expect((await stat(recordPath)).mtimeMs).toBe(statBefore)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(3)
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

  it('操作引用缺失时按只读证明认领已提交且不写回引用', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['op-ref', 'hist-ref'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const committed = await commitStory(versioning, 'op-ref', prepared.baselineRef, '新章节')
    await rm(
      join(world.projectRoot, '.git', 'refs', 'opengalgame', 'operations', 'op-ref'),
      { force: true }
    )

    const restarted = serviceFor(world.userDirectory, [])
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-ref' })
    ).resolves.toEqual({
      operationId: 'op-ref',
      state: '已提交',
      revisionRef: committed.revisionRef
    })
    await expect(
      git.resolveRef({
        fs,
        dir: world.projectRoot,
        ref: 'refs/opengalgame/operations/op-ref'
      })
    ).rejects.toBeTruthy()
    await expect(
      commitStory(restarted, 'op-ref', prepared.baselineRef, '新章节')
    ).resolves.toEqual(committed)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('记录阶段缺失时按只读证明认领已提交且不写回阶段', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['op-phase', 'hist-phase'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const committed = await commitStory(versioning, 'op-phase', prepared.baselineRef, '新章节')
    const recordPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'operations',
      'op-phase.json'
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { phase: string }
    record.phase = 'object-written'
    await writeFile(recordPath, JSON.stringify(record))
    await rm(
      join(world.projectRoot, '.git', 'opengalgame', 'version-settlements', 'op-phase.json'),
      { force: true }
    )

    const restarted = serviceFor(world.userDirectory, [])
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-phase' })
    ).resolves.toEqual({
      operationId: 'op-phase',
      state: '已提交',
      revisionRef: committed.revisionRef
    })
    const unchanged = JSON.parse(await readFile(recordPath, 'utf8')) as { phase: string }
    expect(unchanged.phase).toBe('object-written')
    await expect(
      readFile(
        join(world.projectRoot, '.git', 'opengalgame', 'version-settlements', 'op-phase.json'),
        'utf8'
      )
    ).rejects.toBeTruthy()
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('发布证明与操作引用冲突时报告冲突且不覆盖引用', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['op-conflict', 'hist-conflict'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    await commitStory(versioning, 'op-conflict', prepared.baselineRef, '新章节')
    const operationReference = 'refs/opengalgame/operations/op-conflict'
    await git.writeRef({
      fs,
      dir: world.projectRoot,
      ref: operationReference,
      value: prepared.baselineRef,
      force: true
    })

    await expect(
      repairPublishedMetadata(world.projectRoot, 'op-conflict', realGitEffects)
    ).resolves.toBe('conflict')
    await expect(
      git.resolveRef({ fs, dir: world.projectRoot, ref: operationReference })
    ).resolves.toBe(prepared.baselineRef)
  })

  it('发布后操作引用写入失败时保留工作区并在提交恢复边界补引用', async () => {
    const world = await seededProject('原始')
    let referenceWrites = 0
    const effects: GitEffects = {
      ...realGitEffects,
      writeOperationRef: async (projectRoot: string, operationId: string, oid: string) => {
        referenceWrites += 1
        if (referenceWrites === 1) throw new Error('引用写入失败')
        return realGitEffects.writeOperationRef(projectRoot, operationId, oid)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-ref-fail', 'hist-ref-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    const committed = await commitStory(
      versioning,
      'op-ref-fail',
      prepared.baselineRef,
      '新章节'
    )
    expect(committed.state).toBe('已提交')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('新章节')
    expect(referenceWrites).toBeGreaterThanOrEqual(2)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
    await expect(
      git.resolveRef({
        fs,
        dir: world.projectRoot,
        ref: 'refs/opengalgame/operations/op-ref-fail'
      })
    ).resolves.toBe(committed.revisionRef)
    const record = JSON.parse(
      await readFile(
        join(world.projectRoot, '.git', 'opengalgame', 'operations', 'op-ref-fail.json'),
        'utf8'
      )
    ) as { phase: string }
    expect(record.phase).toBe('published')
  })

  it('结算写入器真实抛错时仍按已提交成功且不重复提交', async () => {
    const world = await seededProject('原始')
    const gateways = createProjectVersioningGateways(world.userDirectory)
    const nextIds = ['op-settle-fail', 'hist-settle-fail']
    const versioning = new ManageProjectVersioning({
      ...gateways,
      transactions: new GitVersionTransactionGateway(
        world.userDirectory,
        realGitEffects,
        async () => {
          throw new Error('结算写入失败')
        }
      ),
      nextId: () => {
        const next = nextIds.shift()
        if (!next) throw new Error('测试身份已用尽')
        return next
      }
    })
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const settlementPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'version-settlements',
      'op-settle-fail.json'
    )

    const committed = await commitStory(
      versioning,
      'op-settle-fail',
      prepared.baselineRef,
      '新章节'
    )
    expect(committed.state).toBe('已提交')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('新章节')
    await expect(readFile(settlementPath, 'utf8')).rejects.toBeTruthy()
    await expect(
      git.resolveRef({
        fs,
        dir: world.projectRoot,
        ref: 'refs/opengalgame/operations/op-settle-fail'
      })
    ).resolves.toBe(committed.revisionRef)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)

    const restarted = serviceFor(world.userDirectory, [])
    await expect(
      commitStory(restarted, 'op-settle-fail', prepared.baselineRef, '新章节')
    ).resolves.toEqual(committed)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('记录和引用同时缺失且引用写故障时，历史补证写回记录并可重建认领', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-history-recover'
    const recordPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'operations',
      `${operationId}.json`
    )
    const effects: GitEffects = {
      ...realGitEffects,
      updateBranch: async (...args) => {
        await realGitEffects.updateBranch(...args)
        await rm(recordPath, { force: true })
        await rm(
          join(
            world.projectRoot,
            '.git',
            'refs',
            'opengalgame',
            'operations',
            operationId
          ),
          { force: true }
        )
      },
      writeOperationRef: async () => {
        throw new Error('引用写入失败')
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-history-recover'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    const committed = await commitStory(
      versioning,
      operationId,
      prepared.baselineRef,
      '历史补证后保留'
    )
    expect(committed.state).toBe('已提交')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '历史补证后保留'
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      phase: string
      forwardCommitId: string
    }
    expect(record.phase).toBe('published')
    expect(record.forwardCommitId).toBe(committed.revisionRef)
    await expect(
      git.resolveRef({
        fs,
        dir: world.projectRoot,
        ref: `refs/opengalgame/operations/${operationId}`
      })
    ).rejects.toBeTruthy()
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)

    const restarted = serviceFor(world.userDirectory, [])
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toEqual({
      operationId,
      state: '已提交',
      revisionRef: committed.revisionRef
    })
    await expect(
      commitStory(restarted, operationId, prepared.baselineRef, '历史补证后保留')
    ).resolves.toEqual(committed)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('历史补证遇到引用冲突时硬错误且不覆盖', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-history-ref-conflict'
    const operationReference = `refs/opengalgame/operations/${operationId}`
    let baselineRef = ''
    const effects: GitEffects = {
      ...realGitEffects,
      updateBranch: async (...args) => {
        await realGitEffects.updateBranch(...args)
        await git.writeRef({
          fs,
          dir: world.projectRoot,
          ref: operationReference,
          value: baselineRef,
          force: true
        })
      },
      writeOperationRef: async () => {
        throw new Error('引用写入失败')
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-history-ref-conflict'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    baselineRef = prepared.baselineRef

    const error = await rejectionOf(
      commitStory(versioning, operationId, prepared.baselineRef, '引用冲突保留')
    )
    expect(error.code).toBe(ProjectVersioningErrorCodes.insufficientEvidence)
    expect((error.cause as AppException).code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '引用冲突保留'
    )
    await expect(
      git.resolveRef({ fs, dir: world.projectRoot, ref: operationReference })
    ).resolves.toBe(prepared.baselineRef)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('历史补证遇到记录身份冲突时硬错误且不覆盖记录', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-history-record-conflict'
    const recordPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'operations',
      `${operationId}.json`
    )
    const effects: GitEffects = {
      ...realGitEffects,
      updateBranch: async (...args) => {
        await realGitEffects.updateBranch(...args)
        const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
        await writeFile(
          recordPath,
          JSON.stringify({
            ...record,
            phase: 'prepared',
            forwardCommitId: null,
            fingerprint: 'conflicting-fingerprint'
          })
        )
      },
      writeOperationRef: async () => {
        throw new Error('引用写入失败')
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-history-record-conflict'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    const error = await rejectionOf(
      commitStory(versioning, operationId, prepared.baselineRef, '记录冲突保留')
    )
    expect(error.code).toBe(ProjectVersioningErrorCodes.insufficientEvidence)
    expect((error.cause as AppException).code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '记录冲突保留'
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { fingerprint: string }
    expect(record.fingerprint).toBe('conflicting-fingerprint')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('历史补证遇到回退阶段记录时硬错误且不认领已发布', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-history-rollback-phase'
    const recordPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'operations',
      `${operationId}.json`
    )
    const effects: GitEffects = {
      ...realGitEffects,
      updateBranch: async (...args) => {
        await realGitEffects.updateBranch(...args)
        const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
        await writeFile(recordPath, JSON.stringify({ ...record, phase: 'rollback-required' }))
      },
      writeOperationRef: async () => {
        throw new Error('引用写入失败')
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-history-rollback-phase'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    const error = await rejectionOf(
      commitStory(versioning, operationId, prepared.baselineRef, '回退阶段保留')
    )
    expect(error.code).toBe(ProjectVersioningErrorCodes.insufficientEvidence)
    expect((error.cause as AppException).code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '回退阶段保留'
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { phase: string }
    expect(record.phase).toBe('rollback-required')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('project-files 第二路径失败时备份后恢复全部路径', async () => {
    const world = await seededProject('原始')
    let failed = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (absolutePath.endsWith('watch.txt') && !failed) {
          failed = true
          throw new Error('第二路径写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-second-fail', 'hist-second-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })

    await expect(
      commitFiles(versioning, 'op-second-fail', prepared.baselineRef, [
        { relativePath: 'story.txt', content: '新故事' },
        { relativePath: 'watch.txt', content: '新观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
    expect(await backupAttempts(world.projectRoot, 'op-second-fail')).not.toHaveLength(0)
  })

  it('project-files 外部修改先完整备份再恢复', async () => {
    const world = await seededProject('原始')
    let storyWritten = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        const backup = absolutePath.includes('compensation-backups')
        if (!backup && absolutePath.endsWith('story.txt') && !storyWritten) {
          storyWritten = true
          await realGitEffects.writeBytes(absolutePath, bytes)
          await writeFile(join(world.projectRoot, 'watch.txt'), '外部修改')
          return
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-external-backup', 'hist-external-backup'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })

    await expect(
      commitFiles(versioning, 'op-external-backup', prepared.baselineRef, [
        { relativePath: 'story.txt', content: '新故事' },
        { relativePath: 'watch.txt', content: '新观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    expect(await backupContainsText(world.projectRoot, 'op-external-backup', '外部修改')).toBe(true)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('project-files 备份写入失败时不改正式路径', async () => {
    const world = await seededProject('原始')
    let failed = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (absolutePath.includes('compensation-backups')) {
          throw new Error('备份写入失败')
        }
        if (absolutePath.endsWith('watch.txt') && !failed) {
          failed = true
          throw new Error('第二路径写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-backup-fail', 'hist-backup-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })

    await expect(
      commitFiles(versioning, 'op-backup-fail', prepared.baselineRef, [
        { relativePath: 'story.txt', content: '新故事' },
        { relativePath: 'watch.txt', content: '新观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('新故事')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('project-files 备份后覆盖前再次变化时停止恢复', async () => {
    const world = await seededProject('原始')
    let writeFailed = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (
          absolutePath.includes('compensation-backups') &&
          absolutePath.endsWith('manifest.json')
        ) {
          await realGitEffects.writeBytes(absolutePath, bytes)
          await writeFile(join(world.projectRoot, 'story.txt'), '备份后变化')
          return
        }
        if (!absolutePath.includes('compensation-backups') && absolutePath.endsWith('story.txt') && !writeFailed) {
          writeFailed = true
          throw new Error('首次写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-backup-race', 'hist-backup-race'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    await expect(
      commitStory(versioning, 'op-backup-race', prepared.baselineRef, '新故事')
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '备份后变化'
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('project-files 第二路径备份后变化时 preflight 阻止任何恢复', async () => {
    const world = await seededProject('原始')
    const originalStage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    let watchFailed = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (
          absolutePath.includes('compensation-backups') &&
          absolutePath.endsWith('manifest.json')
        ) {
          await realGitEffects.writeBytes(absolutePath, bytes)
          await writeFile(join(world.projectRoot, 'watch.txt'), '备份后变化')
          return
        }
        if (
          !absolutePath.includes('compensation-backups') &&
          absolutePath.endsWith('watch.txt') &&
          !watchFailed
        ) {
          watchFailed = true
          throw new Error('第二路径写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-two-path-change', 'hist-two-path-change'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })

    await expect(
      commitFiles(versioning, 'op-two-path-change', prepared.baselineRef, [
        { relativePath: 'story.txt', content: '新故事' },
        { relativePath: 'watch.txt', content: '新观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('新故事')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe(
      '备份后变化'
    )
    const stage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    expect(stage.get('story.txt')).toBe(originalStage.get('story.txt'))
    expect(stage.get('watch.txt')).toBe(originalStage.get('watch.txt'))
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
    expect(await backupAttempts(world.projectRoot, 'op-two-path-change')).not.toHaveLength(0)
  })

  it('project-files 恢复中途 I/O 失败保留可恢复备份和已恢复路径', async () => {
    const world = await seededProject('原始')
    const originalStage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    let watchWrites = 0
    const effects: GitEffects = {
      ...realGitEffects,
      writeCommit: async () => {
        throw new Error('提交对象写入失败')
      },
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (!absolutePath.includes('compensation-backups') && absolutePath.endsWith('watch.txt')) {
          watchWrites += 1
          if (watchWrites > 1) throw new Error('恢复第二路径失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-restore-fail', 'hist-restore-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })

    await expect(
      commitFiles(versioning, 'op-restore-fail', prepared.baselineRef, [
        { relativePath: 'story.txt', content: '新故事' },
        { relativePath: 'watch.txt', content: '新观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('新观察')
    const record = JSON.parse(
      await readFile(
        join(world.projectRoot, '.git', 'opengalgame', 'operations', 'op-restore-fail.json'),
        'utf8'
      )
    ) as { paths: Array<{ relativePath: string; intendedStageOid?: string | null }> }
    const watchIntended = record.paths.find((path) => path.relativePath === 'watch.txt')
      ?.intendedStageOid
    const stage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    expect(stage.get('story.txt')).toBe(originalStage.get('story.txt'))
    expect(stage.get('watch.txt')).toBe(watchIntended)
    expect(watchIntended).toMatch(/^[0-9a-f]{40}$/u)
    expect(await backupAttempts(world.projectRoot, 'op-restore-fail')).not.toHaveLength(0)
    expect(await backupContainsText(world.projectRoot, 'op-restore-fail', '新观察')).toBe(true)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('project-files 暂存失败时保留 intendedStageOid 并恢复索引', async () => {
    const world = await seededProject('原始')
    const originalStage = await readStageOids(world.projectRoot, ['story.txt'])
    let stageFailed = false
    const effects: GitEffects = {
      ...realGitEffects,
      stageBlob: async (projectRoot: string, relativePath: string, oid: string | null) => {
        if (!stageFailed) {
          stageFailed = true
          throw new Error('暂存写入失败')
        }
        return realGitEffects.stageBlob(projectRoot, relativePath, oid)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-stage-fail', 'hist-stage-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    await expect(
      commitStory(versioning, 'op-stage-fail', prepared.baselineRef, '新故事')
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    const record = JSON.parse(
      await readFile(
        join(world.projectRoot, '.git', 'opengalgame', 'operations', 'op-stage-fail.json'),
        'utf8'
      )
    ) as { paths: Array<{ intendedStageOid?: string | null }> }
    expect(record.paths[0]?.intendedStageOid).toMatch(/^[0-9a-f]{40}$/u)
    const stage = await readStageOids(world.projectRoot, ['story.txt'])
    expect(stage.get('story.txt')).toBe(originalStage.get('story.txt'))
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('scene-canvas 外部修改仍拒绝备份式恢复', async () => {
    const world = await seededProject('原始')
    let storyWritten = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (absolutePath.endsWith('story.txt') && !storyWritten) {
          storyWritten = true
          await realGitEffects.writeBytes(absolutePath, bytes)
          await writeFile(join(world.projectRoot, 'watch.txt'), '外部修改')
          return
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-scene-external', 'hist-scene-external'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'scene-canvas',
      targets: [{ kind: 'scene', id: 'scene-1' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })

    await expect(
      commitFiles(versioning, 'op-scene-external', prepared.baselineRef, [
        { relativePath: 'story.txt', content: '新故事' },
        { relativePath: 'watch.txt', content: '新观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe(
      '外部修改'
    )
    expect(await backupAttempts(world.projectRoot, 'op-scene-external')).toHaveLength(0)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('技术WAL恢复已发布缺元数据且不依赖version投影', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-open-published'
    const versioning = serviceFor(world.userDirectory, [operationId, 'hist-open-published'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    const committed = await commitStory(
      versioning,
      operationId,
      prepared.baselineRef,
      '打开恢复已发布'
    )
    await rm(join(world.projectRoot, '.git', 'refs', 'opengalgame', 'operations', operationId), {
      force: true
    })
    await rm(settlementPath(world.projectRoot, operationId), { force: true })
    await rm(versionOperationPath(world.projectRoot, operationId), { force: true })
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string }
    record.phase = 'object-written'
    await writeFile(operationRecordPath(world.projectRoot, operationId), JSON.stringify(record))

    const restarted = serviceFor(world.userDirectory, [])
    await restarted.recoverProject('project-1', 'project-files')
    await expect(
      git.resolveRef({
        fs,
        dir: world.projectRoot,
        ref: `refs/opengalgame/operations/${operationId}`
      })
    ).resolves.toBe(committed.revisionRef)
    await expect(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toMatchObject({ state: '已提交', revisionRef: committed.revisionRef })
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe(
      '打开恢复已发布'
    )
    const repaired = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string }
    expect(repaired.phase).toBe('published')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)

    const recordStat = (await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs
    const settlementStat = (await stat(settlementPath(world.projectRoot, operationId))).mtimeMs
    await restarted.recoverProject('project-1', 'project-files')
    expect((await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs).toBe(
      recordStat
    )
    expect((await stat(settlementPath(world.projectRoot, operationId))).mtimeMs).toBe(
      settlementStat
    )
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('技术记录来源未知时恢复硬错误', async () => {
    const world = await seededProject('原始')
    const operationId = 'op-open-unknown-source'
    const versioning = serviceFor(world.userDirectory, [operationId, 'hist-open-unknown-source'])
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    await commitStory(versioning, operationId, prepared.baselineRef, '来源未知')
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { sourceModule?: string }
    delete record.sourceModule
    await writeFile(operationRecordPath(world.projectRoot, operationId), JSON.stringify(record))
    await rm(versionOperationPath(world.projectRoot, operationId), { force: true })

    const restarted = serviceFor(world.userDirectory, [])
    await expect(restarted.recoverProject('project-1', 'project-files')).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed
    })
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('来源未知')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
  })

  it('技术WAL恢复未发布半写并标记补偿完成', async () => {
    const world = await seededProject('原始')
    const originalStage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    const operationId = 'op-open-half-write'
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (absolutePath.includes('compensation-backups')) {
          throw new Error('补偿备份写入失败')
        }
        if (absolutePath.endsWith('watch.txt')) {
          throw new Error('第二路径写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-open-half-write'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })
    await expect(
      commitFiles(versioning, operationId, prepared.baselineRef, [
        { relativePath: 'story.txt', content: '半写故事' },
        { relativePath: 'watch.txt', content: '半写观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('半写故事')

    const restarted = serviceFor(world.userDirectory, [])
    await restarted.recoverProject('project-1', 'project-files')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    const stage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    expect(stage.get('story.txt')).toBe(originalStage.get('story.txt'))
    expect(stage.get('watch.txt')).toBe(originalStage.get('watch.txt'))
    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string }
    expect(record.phase).toBe('compensated')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
    expect(await backupAttempts(world.projectRoot, operationId)).not.toHaveLength(0)
  })

  it('技术WAL恢复S2中途部分恢复并保留旧备份', async () => {
    const world = await seededProject('原始')
    const originalStage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    const operationId = 'op-open-partial-restore'
    let watchWrites = 0
    const effects: GitEffects = {
      ...realGitEffects,
      writeCommit: async () => {
        throw new Error('提交对象写入失败')
      },
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (!absolutePath.includes('compensation-backups') && absolutePath.endsWith('watch.txt')) {
          watchWrites += 1
          if (watchWrites > 1) throw new Error('恢复第二路径失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-open-partial-restore'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt', 'watch.txt'],
      watchedPaths: []
    })
    await expect(
      commitFiles(versioning, operationId, prepared.baselineRef, [
        { relativePath: 'story.txt', content: '部分恢复故事' },
        { relativePath: 'watch.txt', content: '部分恢复观察' }
      ])
    ).rejects.toBeInstanceOf(AppException)
    const partial = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; compensationBackupId?: string }
    expect(partial.phase).toBe('restoring')
    expect(partial.compensationBackupId).toMatch(/^[\w-]+$/u)
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(1)

    const restarted = serviceFor(world.userDirectory, [])
    await restarted.recoverProject('project-1', 'project-files')
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    await expect(readFile(join(world.projectRoot, 'watch.txt'), 'utf8')).resolves.toBe('观察')
    const stage = await readStageOids(world.projectRoot, ['story.txt', 'watch.txt'])
    expect(stage.get('story.txt')).toBe(originalStage.get('story.txt'))
    expect(stage.get('watch.txt')).toBe(originalStage.get('watch.txt'))
    const recovered = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string }
    expect(recovered.phase).toBe('compensated')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
    expect((await backupAttempts(world.projectRoot, operationId)).length).toBeGreaterThanOrEqual(2)
  })

  it('updateBranch失败补偿后打开返回未提交且重复打开无新备份', async () => {
    const world = await seededProject('原始')
    await mkdir(join(world.projectRoot, '.opengalgame'), { recursive: true })
    await writeFile(
      join(world.projectRoot, '.opengalgame', 'project.json'),
      JSON.stringify({
        id: 'project-1',
        name: '冒烟工程',
        synopsis: 'S3',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    )
    await writeFile(
      join(world.projectRoot, '.opengalgame', 'manifest.json'),
      JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-register' })
    )
    const operationId = 'op-branch-fail'
    const effects: GitEffects = {
      ...realGitEffects,
      updateBranch: async () => {
        throw new Error('分支更新失败')
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      [operationId, 'hist-branch-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })
    await expect(
      commitStory(versioning, operationId, prepared.baselineRef, '分支失败')
    ).rejects.toBeInstanceOf(AppException)

    const record = JSON.parse(
      await readFile(operationRecordPath(world.projectRoot, operationId), 'utf8')
    ) as { phase: string; forwardCommitId?: string | null }
    expect(record.phase).toBe('compensated')
    expect(record.forwardCommitId ?? '').toMatch(/^[0-9a-f]{40}$/u)
    await expect(
      git.resolveRef({
        fs,
        dir: world.projectRoot,
        ref: `refs/opengalgame/operations/${operationId}`
      })
    ).rejects.toBeTruthy()
    const attemptsBefore = await backupAttempts(world.projectRoot, operationId)
    expect(attemptsBefore).not.toHaveLength(0)
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)

    const services = createProjectServices({
      userDirectory: world.userDirectory,
      dialogs: {
        selectDirectory: async () => null,
        takeSaveLocation: async () => null,
        chooseSaveLocation: async () => null,
        clearSaveLocation: () => undefined
      },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    })
    await services.projects.openProject({ id: 'project-1' })
    await expect(
      services.versioning.readOperationSettlement({ projectId: 'project-1', operationId })
    ).resolves.toEqual({ operationId, state: '未提交' })
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(
      attemptsBefore.length
    )
    const recordStat = (await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs
    const settlementStat = (await stat(settlementPath(world.projectRoot, operationId))).mtimeMs
    await services.projects.openProject({ id: 'project-1' })
    expect((await stat(operationRecordPath(world.projectRoot, operationId))).mtimeMs).toBe(
      recordStat
    )
    expect((await stat(settlementPath(world.projectRoot, operationId))).mtimeMs).toBe(
      settlementStat
    )
    expect(await backupAttempts(world.projectRoot, operationId)).toHaveLength(
      attemptsBefore.length
    )
    await services.close()
  })

  it('未发布的工作区写入失败时恢复原文件并报告失败', async () => {
    const world = await seededProject('原始')
    let failed = false
    const effects: GitEffects = {
      ...realGitEffects,
      writeBytes: async (absolutePath: string, bytes: Uint8Array) => {
        if (!failed && absolutePath.endsWith('story.txt')) {
          failed = true
          throw new Error('写入失败')
        }
        return realGitEffects.writeBytes(absolutePath, bytes)
      }
    }
    const versioning = serviceFor(
      world.userDirectory,
      ['op-write-fail', 'hist-write-fail'],
      effects
    )
    const prepared = await versioning.prepareOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      targets: [{ kind: 'file', id: 'story' }],
      changePaths: ['story.txt'],
      watchedPaths: []
    })

    await expect(
      commitStory(versioning, 'op-write-fail', prepared.baselineRef, '新章节')
    ).rejects.toBeInstanceOf(AppException)
    await expect(readFile(join(world.projectRoot, 'story.txt'), 'utf8')).resolves.toBe('原始')
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(1)
  })

  it('动作被改成删除时，读取结算抛技术错误且不能认领已提交', async () => {
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
    const error = await rejectionOf(
      restarted.readOperationSettlement({ projectId: 'project-1', operationId: 'op-action' })
    )
    expect(error.code).toBe(ProjectVersioningErrorCodes.insufficientEvidence)
    expect((error.cause as AppException).code).toBe(ProjectVersioningErrorCodes.gitQueryFailed)
    expect(committed.revisionRef).toMatch(/^[0-9a-f]{40}$/u)
  })

  it('真实工程文件消费者读取证据冲突时抛出技术错误而不是 unsettled', async () => {
    const world = await seededProject('原始')
    const versioning = serviceFor(world.userDirectory, ['version-consumer', 'hist-consumer'])
    const gateway = new LocalProjectWorkVersionGatewayImpl(
      versioning,
      async () => 'catalog-v1'
    )
    const project = { projectId: 'project-1', location: { directory: world.projectRoot } }
    await gateway.publish({
      project,
      operationId: 'caller-conflict',
      changes: [
        {
          relativePath: 'story.txt',
          action: 'modify',
          bytes: text.encode('新章节')
        }
      ],
      expectedCatalogVersion: 'catalog-v1'
    })
    const link = await versioning.readCallerOperation({
      projectId: 'project-1',
      sourceModule: 'project-files',
      callerOperationId: 'caller-conflict'
    })
    if (!link) throw new Error('调用方身份未绑定')
    const recordPath = join(
      world.projectRoot,
      '.git',
      'opengalgame',
      'operations',
      `${link.operationId}.json`
    )
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      paths: Array<{ action: string }>
    }
    record.paths[0]!.action = 'delete'
    await writeFile(recordPath, JSON.stringify(record))
    await rm(
      join(
        world.projectRoot,
        '.git',
        'opengalgame',
        'version-settlements',
        `${link.operationId}.json`
      ),
      { force: true }
    )

    await expect(
      versioning.readOperationSettlement({
        projectId: 'project-1',
        operationId: link.operationId
      })
    ).rejects.toMatchObject({ code: ProjectVersioningErrorCodes.insufficientEvidence })
    await expect(gateway.readOperation(project, 'caller-conflict')).rejects.toMatchObject({
      code: ProjectVersioningErrorCodes.gitQueryFailed
    })
    expect((await git.log({ fs, dir: world.projectRoot })).length).toBe(2)
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
): ManageProjectVersioning {
  const remaining = [...ids]
  const gateways = createProjectVersioningGateways(userDirectory, effects)
  return new ManageProjectVersioning({
    ...gateways,
    nextId: () => {
      const next = remaining.shift()
      if (!next) throw new Error('测试身份已用尽')
      return next
    }
  })
}

function commitStory(
  versioning: ManageProjectVersioning,
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

async function commitProjectFile(
  versioning: ManageProjectVersioning,
  operationId: string,
  content: string
): Promise<{ operationId: string; state: '已提交' | '无变更'; revisionRef: string }> {
  const prepared = await versioning.prepareOperation({
    projectId: 'project-1',
    sourceModule: 'project-files',
    targets: [{ kind: 'file', id: 'story' }],
    changePaths: ['story.txt'],
    watchedPaths: []
  })
  return commitStory(versioning, operationId, prepared.baselineRef, content)
}

function commitFiles(
  versioning: ManageProjectVersioning,
  operationId: string,
  baselineRef: string,
  changes: readonly { relativePath: string; content: string }[]
): Promise<{ operationId: string; state: '已提交' | '无变更'; revisionRef: string }> {
  return versioning.commitOperation(
    {
      projectId: 'project-1',
      operationId,
      baselineRef,
      input: {
        kind: 'files',
        changes: changes.map((change) => ({
          relativePath: change.relativePath,
          action: 'modify' as const,
          content: { kind: 'bytes' as const, bytes: text.encode(change.content) }
        }))
      },
      saveMode: 'manual',
      contentSource: 'operation',
      title: '保存章节',
      summary: '更新正文'
    },
    () => undefined
  )
}

function operationRecordPath(projectRoot: string, operationId: string): string {
  return join(projectRoot, '.git', 'opengalgame', 'operations', `${operationId}.json`)
}

function versionOperationPath(projectRoot: string, operationId: string): string {
  return join(
    projectRoot,
    '.git',
    'opengalgame',
    'version-operations',
    `${operationId}.json`
  )
}

function settlementPath(projectRoot: string, operationId: string): string {
  return join(
    projectRoot,
    '.git',
    'opengalgame',
    'version-settlements',
    `${operationId}.json`
  )
}

function compensationBackupRoot(projectRoot: string, operationId: string): string {
  return join(projectRoot, '.git', 'opengalgame', 'compensation-backups', operationId)
}

async function backupAttempts(projectRoot: string, operationId: string): Promise<string[]> {
  try {
    return await readdir(compensationBackupRoot(projectRoot, operationId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function backupContainsText(
  projectRoot: string,
  operationId: string,
  content: string
): Promise<boolean> {
  const expected = Buffer.from(content)
  for (const attempt of await backupAttempts(projectRoot, operationId)) {
    const directory = join(compensationBackupRoot(projectRoot, operationId), attempt)
    for (const file of await readdir(directory)) {
      const bytes = await readFile(join(directory, file))
      if (expected.equals(bytes)) return true
    }
  }
  return false
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
