/**
 * 修复输入物化后、首个候选写入前中断的恢复回归。
 *
 * 使用真实候选文件系统、真实 Git 修订和真实工作区网关，不启动模型或应用编排；
 * 覆盖已发布输入复用、完整草稿补发布、不可证明现场保留、已持久输入修订恢复。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationRepairSource } from '@application/scene-generation/vo/SceneGenerationVO'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { WebGalSceneGenerationWorkspaceGatewayImpl } from '@infrastructure/scene-generation/artifacts/WebGalSceneGenerationWorkspaceGatewayImpl'
import { readCommitFiles } from '@infrastructure/git/objects/gitTree'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  )
  vi.restoreAllMocks()
})

const ENTRY = 'game/scene/start.txt'
const SCRIPT = 'changeBg:station.svg;\n林:末班车快到了。;\nend;'

type Fixture = {
  root: string
  projectRoot: string
  files: AiProjectFileSystemImpl
  gateway: WebGalSceneGenerationWorkspaceGatewayImpl
  source: SceneGenerationRepairSource
  sourceRevision: string
  sourceFiles: Array<{ relativePath: string; bytes: Uint8Array }>
}

async function sourceFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'repair-input-recovery-'))
  roots.push(root)
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot, { recursive: true })
  const files = new AiProjectFileSystemImpl(root)
  const gateway = new WebGalSceneGenerationWorkspaceGatewayImpl(files)
  const sourceWorkspace = await files.createWorkspace({
    projectId: 'project-repair',
    threadId: 'thread-source',
    operationId: 'op-source',
    projectRoot,
    sourcePaths: []
  })
  await files.writeFile(sourceWorkspace, ENTRY, Buffer.from(SCRIPT, 'utf8'))
  const { revisionId } = await files.saveRevision(sourceWorkspace)
  const sourceFiles = await readCommitFiles(
    { gitdir: sourceWorkspace.revisionGitDir },
    revisionId
  )
  return {
    root,
    projectRoot,
    files,
    gateway,
    source: {
      operationId: 'op-source',
      threadId: 'thread-source',
      branchId: 'branch-source',
      checkpointId: 'checkpoint-source',
      candidateSnapshotId: revisionId
    },
    sourceRevision: revisionId,
    sourceFiles
  }
}

function repairExecution(
  fixture: Fixture,
  input: { operationId: string; threadId: string; repairInputSnapshotId?: string }
): SceneGenerationExecution {
  return {
    projectId: 'project-repair',
    sceneId: 'scene-repair',
    operationId: input.operationId,
    threadId: input.threadId,
    branchId: `branch-${input.operationId}`,
    source: {
      projectRoot: fixture.projectRoot,
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {},
    repairSource: fixture.source,
    ...(input.repairInputSnapshotId === undefined
      ? {}
      : { repairInputSnapshotId: input.repairInputSnapshotId })
  } as unknown as SceneGenerationExecution
}

async function entryOf(root: string): Promise<string> {
  return readFile(join(root, ENTRY), 'utf8')
}

it('[P5] 已发布修复输入在重开后复用同一修订，不重复建目录或清理现场', async () => {
  const fixture = await sourceFixture()
  const execution = repairExecution(fixture, {
    operationId: 'op-repair',
    threadId: 'thread-repair'
  })
  const first = await fixture.gateway.materializeRepairInput(execution, fixture.source)
  expect(first.candidateSnapshotId).not.toBe(fixture.sourceRevision)
  expect(await entryOf(first.rootDirectory)).toBe(SCRIPT)

  // 模拟重开：新文件系统与网关实例，只依赖持久修订、工作区引用和真实字节。
  const reopenedFiles = new AiProjectFileSystemImpl(fixture.root)
  const reopened = new WebGalSceneGenerationWorkspaceGatewayImpl(reopenedFiles)
  const create = vi.spyOn(reopenedFiles, 'createWorkspace')
  const discard = vi.spyOn(reopenedFiles, 'discardWorkspace')
  const proven = await reopened.proveRepairInput(execution, fixture.source)
  expect(proven?.candidateSnapshotId).toBe(first.candidateSnapshotId)
  const reused = await reopened.materializeRepairInput(execution, fixture.source)
  expect(reused.candidateSnapshotId).toBe(first.candidateSnapshotId)
  expect(reused.rootDirectory).toBe(first.rootDirectory)
  expect(create).not.toHaveBeenCalled()
  expect(discard).not.toHaveBeenCalled()
  expect(await entryOf(reused.rootDirectory)).toBe(SCRIPT)
})

it('[P5] 来源草稿已完整复制但修订未发布：补一次本操作修订，不重建目录', async () => {
  const fixture = await sourceFixture()
  const execution = repairExecution(fixture, {
    operationId: 'op-copied',
    threadId: 'thread-copied'
  })
  const files = fixture.files
  const copied = await files.createWorkspace({
    ...execution,
    projectRoot: fixture.projectRoot,
    sourcePaths: []
  })
  for (const file of fixture.sourceFiles)
    await files.writeFile(copied, file.relativePath, file.bytes)
  expect(await files.currentWorkspaceRevision(execution)).toBeUndefined()
  vi.spyOn(files, 'createWorkspace')
  vi.spyOn(files, 'discardWorkspace')

  const reused = await fixture.gateway.materializeRepairInput(execution, fixture.source)
  expect(reused.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(reused.candidateSnapshotId).not.toBe(fixture.sourceRevision)
  expect(files.createWorkspace).not.toHaveBeenCalled()
  expect(files.discardWorkspace).not.toHaveBeenCalled()
  expect(await files.currentWorkspaceRevision(execution)).toBe(reused.candidateSnapshotId)
  expect(await entryOf(reused.rootDirectory)).toBe(SCRIPT)
})

it('[P5] 既有工作区与来源草稿不一致：保留现场并拒绝，不清理未证明目录', async () => {
  const fixture = await sourceFixture()
  const execution = repairExecution(fixture, {
    operationId: 'op-partial',
    threadId: 'thread-partial'
  })
  const files = fixture.files
  const partial = await files.createWorkspace({
    ...execution,
    projectRoot: fixture.projectRoot,
    sourcePaths: []
  })
  const wrong = 'changeBg:station.svg;\n林:这是别的草稿。;\nend;'
  await files.writeFile(partial, ENTRY, Buffer.from(wrong, 'utf8'))
  vi.spyOn(files, 'createWorkspace')
  vi.spyOn(files, 'discardWorkspace')

  await expect(
    fixture.gateway.materializeRepairInput(execution, fixture.source)
  ).rejects.toThrow('已保留现场待核对')
  expect(files.createWorkspace).not.toHaveBeenCalled()
  expect(files.discardWorkspace).not.toHaveBeenCalled()
  expect(await entryOf(partial.rootDirectory)).toBe(wrong)
})

it('[P5] 输入修订已持久化但工作区丢失：只从不可变修订恢复，不重新复制来源', async () => {
  const fixture = await sourceFixture()
  const execution = repairExecution(fixture, {
    operationId: 'op-restore',
    threadId: 'thread-restore'
  })
  const first = await fixture.gateway.materializeRepairInput(execution, fixture.source)
  const pinned = repairExecution(fixture, {
    operationId: execution.operationId,
    threadId: execution.threadId,
    repairInputSnapshotId: first.candidateSnapshotId
  })
  await rm(first.rootDirectory, { recursive: true, force: true })

  const reopenedFiles = new AiProjectFileSystemImpl(fixture.root)
  const reopened = new WebGalSceneGenerationWorkspaceGatewayImpl(reopenedFiles)
  const create = vi.spyOn(reopenedFiles, 'createWorkspace')
  const discard = vi.spyOn(reopenedFiles, 'discardWorkspace')
  const restored = await reopened.materializeRepairInput(pinned, fixture.source)
  expect(restored.candidateSnapshotId).toBe(first.candidateSnapshotId)
  expect(await entryOf(restored.rootDirectory)).toBe(SCRIPT)
  expect(create).not.toHaveBeenCalled()
  expect(discard).not.toHaveBeenCalled()
})

it('[P5] 未完成草稿不能借“工作区已存在”跳过来源校验', async () => {
  const fixture = await sourceFixture()
  const execution = repairExecution(fixture, {
    operationId: 'op-conflict',
    threadId: 'thread-conflict'
  })
  const files = fixture.files
  const partial = await files.createWorkspace({
    ...execution,
    projectRoot: fixture.projectRoot,
    sourcePaths: []
  })
  await mkdir(join(partial.rootDirectory, 'game'), { recursive: true })
  await writeFile(join(partial.rootDirectory, 'game/extra.txt'), 'not from source\n', 'utf8')
  await expect(
    fixture.gateway.materializeRepairInput(execution, fixture.source)
  ).rejects.toThrow('已保留现场待核对')
  expect(await readFile(join(partial.rootDirectory, 'game/extra.txt'), 'utf8')).toBe(
    'not from source\n'
  )
})
