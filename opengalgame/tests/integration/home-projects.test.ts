import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as git from 'isomorphic-git'
import * as fs from 'node:fs'

import { ProjectWorkspaceServiceImpl } from '@application/projects/services/impl/ProjectWorkspaceServiceImpl'
import { AppException } from '@common/errors/AppException'
import { ProjectErrorCodes } from '@domain/projects/errors/ProjectErrorCodes'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { LocalProjectBaselineGatewayImpl } from '@infrastructure/projects/LocalProjectBaselineGatewayImpl'
import { LocalProjectSceneIdentityGatewayImpl } from '@infrastructure/projects/LocalProjectSceneIdentityGatewayImpl'
import { LocalProjectSceneSeedGatewayImpl } from '@infrastructure/projects/LocalProjectSceneSeedGatewayImpl'
import { createProjectServices } from '@bootstrap/projects'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { arrangementPath } from '@infrastructure/project-files/projectFilePaths'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function fixture(): Promise<
  ReturnType<typeof createProjectServices> & {
    root: string
    userDirectory: string
    workspace: string
    workspaceService: ProjectWorkspaceServiceImpl
    dialogs: {
      selectDirectory: ReturnType<typeof vi.fn<() => Promise<{ directory: string } | null>>>
      takeSaveLocation: ReturnType<typeof vi.fn<() => Promise<{ directory: string } | null>>>
      chooseSaveLocation: ReturnType<typeof vi.fn<() => Promise<{ directory: string } | null>>>
      clearSaveLocation: ReturnType<typeof vi.fn<() => void>>
    }
  }
> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-test-'))
  const workspace = join(root, '故事')
  await mkdir(workspace)
  const selectDirectory = vi.fn(async () => ({ directory: workspace }))
  const dialogs = {
    selectDirectory,
    takeSaveLocation: vi.fn(async () => selectDirectory()),
    chooseSaveLocation: vi.fn(async () => selectDirectory()),
    clearSaveLocation: vi.fn()
  }
  const userDirectory = join(root, 'app')
  const workspaceService = new ProjectWorkspaceServiceImpl({
    identity: new LocalProjectSceneIdentityGatewayImpl(userDirectory),
    seeds: new LocalProjectSceneSeedGatewayImpl(userDirectory),
    baseline: new LocalProjectBaselineGatewayImpl(
      createProjectVersioningGateways(userDirectory).transactions
    )
  })
  const services = createProjectServices({
    userDirectory,
    dialogs,
    logger,
    workspace: workspaceService
  })
  closers.push(services.close)
  return { root, workspace, userDirectory, workspaceService, dialogs, ...services }
}

describe('首页真实目录与持久提交', () => {
  it('登记唯一键同时撞上多条记录时不能误判为同操作重放', async () => {
    const f = await fixture()
    const operation = {
      operationId: 'same-operation',
      project: { id: 'same-id' },
      location: { directory: f.workspace }
    } as Parameters<typeof f.registration.registerProject>[0]
    expect(await f.registration.registerProject(operation)).toEqual({ status: 'registered' })
    await writeProjectRegistrations(f.userDirectory, [
      { id: 'same-id', directory: f.workspace, operationId: 'same-operation' },
      { id: 'other-id', directory: join(f.root, 'other'), operationId: 'other-operation' }
    ])
    expect(await f.registration.registerProject(operation)).toEqual({ status: 'alreadyRegistered' })
    expect(
      await f.registration.registerProject({
        ...operation,
        location: { directory: join(f.root, 'other') }
      })
    ).toEqual({ status: 'conflict' })
  })

  it('普通目录导入自动初始化，保留原文件，重放不再次选择目录或发通知', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, '原稿.txt'), '不能丢失', 'utf8')
    const progress = vi.fn()
    const result = await f.projects.importProject({ operationId: 'import-1' }, progress)
    expect(result).toMatchObject({ status: 'completed', name: '故事' })
    const manifest = JSON.parse(
      await readFile(join(f.workspace, '.opengalgame/manifest.json'), 'utf8')
    )
    expect(manifest).toMatchObject({
      formatVersion: 2,
      projectId: result.status === 'completed' && result.projectId
    })
    expect(
      JSON.parse(await readFile(join(f.workspace, '.opengalgame/project.json'), 'utf8'))
    ).toMatchObject({ id: manifest.projectId, name: '故事', synopsis: '' })
    expect((await readdir(f.workspace)).sort()).toEqual([
      '.git',
      '.opengalgame',
      'assets',
      'game',
      '原稿.txt'
    ])
    expect(await readFile(join(f.workspace, '原稿.txt'), 'utf8')).toBe('不能丢失')
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ stage: 'completed', event: 'imported' })
    const again = await f.projects.importProject({ operationId: 'import-1' }, progress)
    expect(again).toEqual(result)
    expect(f.dialogs.selectDirectory).toHaveBeenCalledTimes(1)
    expect(progress.mock.calls.filter(([p]) => p.stage === 'completed')).toHaveLength(1)
  })

  it('新建和导入都建立仓库、场景和锁，重复创建不新增提交', async () => {
    const created = await fixture()
    const result = await created.projects.createProject({
      operationId: 'workspace-create',
      name: '新故事',
      synopsis: '简介'
    })
    expect(result).toMatchObject({ status: 'completed', name: '新故事' })
    if (result.status !== 'completed') throw new Error('创建未完成')
    await expectWorkspace(created.workspace, result.projectId, { scene: '', lock: 'unlocked' })
    const firstHead = await git.resolveRef({ fs, dir: created.workspace, ref: 'HEAD' })
    const replay = await created.projects.createProject({
      operationId: 'workspace-create',
      name: '新故事',
      synopsis: '简介'
    })
    expect(replay).toEqual(result)
    expect(await git.resolveRef({ fs, dir: created.workspace, ref: 'HEAD' })).toBe(firstHead)

    const imported = await fixture()
    await mkdir(join(imported.workspace, 'game/scene'), { recursive: true })
    await writeFile(join(imported.workspace, 'game/scene/start.txt'), '保留正文', 'utf8')
    const importResult = await imported.projects.importProject({ operationId: 'workspace-import' })
    expect(importResult.status).toBe('completed')
    if (importResult.status !== 'completed') throw new Error('导入未完成')
    await expectWorkspace(imported.workspace, importResult.projectId, {
      scene: '保留正文',
      lock: 'unlocked'
    })
    const importHead = await git.resolveRef({ fs, dir: imported.workspace, ref: 'HEAD' })
    await imported.projects.ensureProjectWorkspace({ projectId: importResult.projectId })
    expect(await git.resolveRef({ fs, dir: imported.workspace, ref: 'HEAD' })).toBe(importHead)
    expect(await readFile(join(imported.workspace, 'game/scene/start.txt'), 'utf8')).toBe(
      '保留正文'
    )
  })

  it('已有工程缺少场景和锁时只补缺失，并保留已有锁定', async () => {
    const f = await fixture()
    const created = await f.projects.createProject({ operationId: 'seeded', name: '已有故事' })
    if (created.status !== 'completed') throw new Error('创建未完成')
    await writeFile(join(f.workspace, 'game/scene/start.txt'), '原场景', 'utf8')
    await writeFile(
      join(f.workspace, '.opengalgame/scene-locks.json'),
      JSON.stringify({
        scenes: [
          { sceneId: 'scene-1', lockState: 'locked' },
          { sceneId: 'scene-2', lockState: 'unlocked', note: '保留' }
        ],
        extra: true
      }),
      'utf8'
    )
    await rm(join(f.workspace, '.git'), { recursive: true, force: true })
    await f.projects.ensureProjectWorkspace({ projectId: created.projectId })
    expect(await readFile(join(f.workspace, 'game/scene/start.txt'), 'utf8')).toBe('原场景')
    expect(
      JSON.parse(await readFile(join(f.workspace, '.opengalgame/scene-locks.json'), 'utf8'))
    ).toEqual({
      scenes: [
        { sceneId: 'scene-1', lockState: 'locked' },
        { sceneId: 'scene-2', lockState: 'unlocked', note: '保留' }
      ],
      extra: true
    })
    const head = await git.resolveRef({ fs, dir: f.workspace, ref: 'HEAD' })
    await expect(
      git.readBlob({ fs, dir: f.workspace, oid: head, filepath: 'game/scene/start.txt' })
    ).resolves.toBeTruthy()
    await f.projects.ensureProjectWorkspace({ projectId: created.projectId })
    expect(await git.resolveRef({ fs, dir: f.workspace, ref: 'HEAD' })).toBe(head)
  })

  it('只读检查不写盘；删除仓库后保存不落盘，显式重建才补齐', async () => {
    const f = await fixture()
    const created = await f.projects.createProject({ operationId: 'inspect-ready', name: '可检查' })
    if (created.status !== 'completed') throw new Error('创建未完成')
    const head = await git.resolveRef({ fs, dir: f.workspace, ref: 'HEAD' })
    const script = await readFile(join(f.workspace, 'game/scene/start.txt'))
    await expect(
      f.projects.inspectProjectWorkspace({ projectId: created.projectId })
    ).resolves.toEqual({
      ready: true,
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(await git.resolveRef({ fs, dir: f.workspace, ref: 'HEAD' })).toBe(head)
    expect(await readFile(join(f.workspace, 'game/scene/start.txt'))).toEqual(script)

    const infoPath = join(f.workspace, '.opengalgame/project.json')
    const info = JSON.parse(await readFile(infoPath, 'utf8')) as {
      sceneId?: string
      canvasId?: string
    }
    const savedInfo = await readFile(infoPath)
    delete info.sceneId
    delete info.canvasId
    await writeFile(infoPath, JSON.stringify(info))
    await expect(
      f.projects.inspectProjectWorkspace({ projectId: created.projectId })
    ).resolves.toEqual({ ready: false })
    expect(JSON.parse(await readFile(infoPath, 'utf8'))).not.toHaveProperty('sceneId')
    await writeFile(infoPath, savedInfo)

    await rm(join(f.workspace, '.git'), { recursive: true, force: true })
    await expect(
      f.projects.inspectProjectWorkspace({ projectId: created.projectId })
    ).resolves.toEqual({
      ready: false,
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    await expect(lstat(join(f.workspace, '.git'))).rejects.toThrow()
    const canvasFile = join(f.workspace, arrangementPath('scene-1', 'canvas-1'))
    await expect(
      f.sceneCanvas.saveSceneCanvasArrangement({
        projectId: created.projectId,
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'manual',
        arrangement: {
          projectId: created.projectId,
          sceneId: 'scene-1',
          canvasId: 'canvas-1',
          viewport: { x: 1, y: 2, zoom: 1 },
          cards: [],
          relations: []
        }
      })
    ).rejects.toMatchObject({
      code: ProjectErrorCodes.workspaceNotReady,
      message: '工程初始化未完成，请重新构建'
    })
    await expect(lstat(canvasFile)).rejects.toThrow()
    await expect(lstat(join(f.workspace, '.git'))).rejects.toThrow()
    expect(await readFile(join(f.workspace, 'game/scene/start.txt'))).toEqual(script)

    await f.projects.ensureProjectWorkspace({ projectId: created.projectId })
    await expect(
      f.projects.inspectProjectWorkspace({ projectId: created.projectId })
    ).resolves.toEqual({
      ready: true,
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(await readFile(join(f.workspace, 'game/scene/start.txt'))).toEqual(script)
  })

  it('工作区初始化失败保留登记且不完成日志', async () => {
    const f = await fixture()
    const ensure = vi.spyOn(f.workspaceService, 'ensureProjectWorkspace').mockRejectedValueOnce(
      new AppException({
        code: ProjectErrorCodes.workspaceNotReady,
        msg: '工程初始化未完成，请重新构建',
        cause: new Error('D:/secret/.git fatal')
      })
    )
    await expect(
      f.projects.createProject({ operationId: 'workspace-fail', name: '失败故事' })
    ).rejects.toMatchObject({ code: 1309, message: '工程初始化未完成，请重新构建' })
    expect((await f.journal.find('workspace-fail'))?.stage).toBe('published')
    expect(await lstat(join(f.workspace, '.opengalgame'))).toBeTruthy()
    ensure.mockRestore()
  })

  it('已有目录直接导入，保留身份与所有管理文件', async () => {
    const f = await fixture()
    const created = await f.projects.createProject({
      operationId: 'create-1',
      name: '原来的名字',
      synopsis: '一\n二'
    })
    const before = await readFile(join(f.workspace, '.opengalgame/manifest.json'), 'utf8')
    const other = createProjectServices({
      userDirectory: join(f.root, 'other-app'),
      dialogs: f.dialogs,
      logger
    })
    closers.push(other.close)
    const imported = await other.projects.importProject({ operationId: 'import-other' })
    expect(imported).toEqual(created)
    expect(await readFile(join(f.workspace, '.opengalgame/manifest.json'), 'utf8')).toBe(before)
    await expect(
      other.projects.importProject({ operationId: 'import-duplicate' })
    ).rejects.toMatchObject({ code: 1205 })
  })

  it('标识存在但损坏时拒绝，不重新初始化', async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, '.opengalgame'))
    await writeFile(join(f.workspace, '.opengalgame/manifest.json'), '{broken', 'utf8')
    await expect(f.projects.importProject({ operationId: 'broken' })).rejects.toMatchObject({
      code: 1203
    })
    expect(await readFile(join(f.workspace, '.opengalgame/manifest.json'), 'utf8')).toBe('{broken')
    expect(await readdir(join(f.workspace, '.opengalgame'))).toEqual(['manifest.json'])
  })

  it('同名普通文件不能冒充标识目录', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, '.opengalgame'), '保留', 'utf8')
    await expect(f.projects.importProject({ operationId: 'marker-file' })).rejects.toMatchObject({
      code: 1203
    })
    expect(await readFile(join(f.workspace, '.opengalgame'), 'utf8')).toBe('保留')
  })

  it('新建名称不合法时不选目录、不写文件；取消时无持久副作用', async () => {
    const f = await fixture()
    await expect(
      f.projects.createProject({ operationId: 'bad-name', name: '  ' })
    ).rejects.toMatchObject({ code: 1101 })
    expect(f.dialogs.selectDirectory).not.toHaveBeenCalled()
    f.dialogs.selectDirectory.mockResolvedValueOnce(null as never)
    expect(await f.projects.createProject({ operationId: 'cancelled', name: '新故事' })).toEqual({
      status: 'cancelled'
    })
    expect(await readdir(f.workspace)).toEqual([])
    expect(await f.journal.find('cancelled')).toBeNull()
  })

  it('同一操作不同内容拒绝，并发同一请求只创建一次', async () => {
    const f = await fixture()
    const command = { operationId: 'concurrent', name: '故事' }
    const results = await Promise.all([
      f.projects.createProject(command),
      f.projects.createProject(command)
    ])
    expect(results[0]).toEqual(results[1])
    expect(f.dialogs.selectDirectory).toHaveBeenCalledTimes(1)
    await expect(f.projects.createProject({ ...command, name: '其他' })).rejects.toMatchObject({
      code: 4103
    })
  })

  it('发布后登记失败保留工程，重启恢复只补登记', async () => {
    const f = await fixture()
    const register = vi
      .spyOn(f.registration, 'registerProject')
      .mockRejectedValueOnce(new Error('disk failure'))
    const progress = vi.fn()
    await expect(
      f.projects.createProject({ operationId: 'recover', name: '保留作品' }, progress)
    ).rejects.toMatchObject({ code: 1306 })
    const before = await readFile(join(f.workspace, '.opengalgame/manifest.json'), 'utf8')
    expect(progress.mock.calls.some(([p]) => p.stage === 'completed')).toBe(false)
    register.mockRestore()
    await f.close()
    const resumed = createProjectServices({
      userDirectory: f.userDirectory,
      dialogs: f.dialogs,
      logger
    })
    closers.push(resumed.close)
    await resumed.recovery.recoverIncompleteOperations()
    expect((await resumed.journal.find('recover'))?.stage).toBe('completed')
    expect(await readFile(join(f.workspace, '.opengalgame/manifest.json'), 'utf8')).toBe(before)
    const result = await resumed.projects.createProject({
      operationId: 'recover',
      name: '保留作品'
    })
    expect(result).toMatchObject({ status: 'completed', name: '保留作品' })
    expect(f.dialogs.selectDirectory).toHaveBeenCalledTimes(1)
  })

  it('通知监听失败不把已提交作品误报为创建失败', async () => {
    const f = await fixture()
    const result = await f.projects.createProject(
      { operationId: 'listener', name: '已保存' },
      () => {
        throw new Error('window closed')
      }
    )
    expect(result).toMatchObject({ status: 'completed' })
    expect((await f.journal.find('listener'))?.stage).toBe('completed')
  })

  it('单条恢复记录损坏不阻断其余项目恢复', async () => {
    const f = await fixture()
    await mkdir(join(f.userDirectory, 'operations'), { recursive: true })
    await writeFile(join(f.userDirectory, 'operations/corrupt.json'), '{bad', 'utf8')
    vi.spyOn(f.registration, 'registerProject').mockRejectedValueOnce(new Error('offline'))
    await expect(
      f.projects.createProject({ operationId: 'good', name: '待恢复' })
    ).rejects.toMatchObject({ code: 1306 })
    expect(await f.recovery.recoverIncompleteOperations()).toBe(1)
    expect((await f.journal.find('good'))?.stage).toBe('completed')
  })

  it('清单与工程信息身份不一致拒绝且不覆盖', async () => {
    const f = await fixture()
    await f.projects.createProject({ operationId: 'original', name: '故事' })
    const path = join(f.workspace, '.opengalgame/manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...manifest, projectId: 'different' }))
    await expect(f.projects.importProject({ operationId: 'mismatch' })).rejects.toMatchObject({
      code: 1203
    })
  })

  it('标识目录联接不能让初始化或清理越出项目', async () => {
    const f = await fixture()
    const outside = join(f.root, '外部目录')
    await mkdir(outside)
    await writeFile(join(outside, '保留.txt'), '安全')
    await symlink(outside, join(f.workspace, '.opengalgame'), 'junction')
    await expect(f.projects.importProject({ operationId: 'junction' })).rejects.toMatchObject({
      code: 1203
    })
    expect(await readFile(join(outside, '保留.txt'), 'utf8')).toBe('安全')
  })

  it('暂存失败清理后允许同一操作重试，不删除用户文件', async () => {
    const f = await fixture()
    await writeFile(join(f.workspace, '保留.txt'), '安全')
    vi.spyOn(f.storage, 'initialize').mockRejectedValueOnce(new Error('before publication'))
    await expect(f.projects.createProject({ operationId: 'retry', name: '重试' })).rejects.toThrow(
      'before publication'
    )
    expect(await f.journal.find('retry')).toBeNull()
    expect(await readdir(f.workspace)).toEqual(['保留.txt'])
    expect(await f.projects.createProject({ operationId: 'retry', name: '重试' })).toMatchObject({
      status: 'completed'
    })
  })
})

async function expectWorkspace(
  workspace: string,
  projectId: string,
  expected: { scene: string; lock: 'unlocked' | 'locked' }
): Promise<void> {
  expect((await lstat(join(workspace, '.git'))).isDirectory()).toBe(true)
  const project = JSON.parse(await readFile(join(workspace, '.opengalgame/project.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(workspace, '.opengalgame/manifest.json'), 'utf8'))
  expect(project).toMatchObject({ id: projectId, sceneId: 'scene-1', canvasId: 'canvas-1' })
  expect(manifest.projectId).toBe(projectId)
  expect(await readFile(join(workspace, 'game/scene/start.txt'), 'utf8')).toBe(expected.scene)
  const locks = JSON.parse(await readFile(join(workspace, '.opengalgame/scene-locks.json'), 'utf8'))
  expect(locks.scenes).toContainEqual({ sceneId: 'scene-1', lockState: expected.lock })
  const head = await git.resolveRef({ fs, dir: workspace, ref: 'HEAD' })
  for (const path of [
    '.opengalgame/project.json',
    '.opengalgame/manifest.json',
    'game/scene/start.txt',
    '.opengalgame/scene-locks.json'
  ]) {
    await expect(
      git.readBlob({ fs, dir: workspace, oid: head, filepath: path })
    ).resolves.toBeTruthy()
  }
}
