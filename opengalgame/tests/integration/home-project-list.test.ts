import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntryVO, ProjectListPageVO } from '@application/projects/vo/ProjectVO'
import { createProjectServices } from '@bootstrap/projects'
import { Project } from '@domain/projects/models/Project'
import {
  readProjectRegistrations,
  writeProjectRegistrations
} from '@infrastructure/projects/projectRegistrations'

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function fixture(): Promise<
  ReturnType<typeof createProjectServices> & {
    root: string
    userDirectory: string
    dialogs: {
      selectDirectory: ReturnType<typeof vi.fn<() => Promise<{ directory: string }>>>
      takeSaveLocation: ReturnType<typeof vi.fn<() => Promise<{ directory: string }>>>
      chooseSaveLocation: ReturnType<typeof vi.fn<() => Promise<{ directory: string }>>>
      clearSaveLocation: ReturnType<typeof vi.fn<() => void>>
    }
  }
> {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-list-'))
  const selectDirectory = vi.fn(async () => ({ directory: '' }))
  const dialogs = {
    selectDirectory,
    takeSaveLocation: vi.fn(async () => selectDirectory()),
    chooseSaveLocation: vi.fn(async () => selectDirectory()),
    clearSaveLocation: vi.fn()
  }
  const userDirectory = join(root, 'app')
  const services = createProjectServices({ userDirectory, dialogs, logger })
  closers.push(services.close)
  return { root, dialogs, userDirectory, ...services }
}

let operationSequence = 0
async function createIn(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  directoryName: string,
  synopsis = ''
): Promise<{ projectId: string; directory: string }> {
  const directory = join(f.root, directoryName)
  await mkdir(directory)
  f.dialogs.selectDirectory.mockResolvedValueOnce({ directory })
  const result = await f.projects.createProject({
    operationId: `create-${++operationSequence}`,
    name,
    synopsis
  })
  if (result.status !== 'completed') throw new Error('项目创建未完成')
  return { projectId: result.projectId, directory }
}

function entryOf(entries: ProjectListEntryVO[], id: string): ProjectListEntryVO {
  const entry = entries.find((item) => item.id === id)
  if (!entry) throw new Error('未找到列表条目')
  return entry
}

function listPage(
  projects: Awaited<ReturnType<typeof fixture>>['projects'],
  offset = 0,
  limit = 24
): Promise<ProjectListPageVO> {
  return projects.listProjects({ offset, limit })
}

describe('项目列表只读查询', () => {
  it('按登记标识升序读取多个真实工程', async () => {
    const f = await fixture()
    const first = await createIn(f, '月光工坊', '甲', '一\n二')
    const second = await createIn(f, '潮汐旅馆', '乙')

    const page = await listPage(f.projects)

    expect(page.entries).toHaveLength(2)
    expect(page.total).toBe(2)
    expect(entryOf(page.entries, first.projectId)).toEqual({
      status: 'available',
      id: first.projectId,
      name: '月光工坊',
      synopsis: '一\n二'
    })
    expect(entryOf(page.entries, second.projectId)).toMatchObject({
      status: 'available',
      synopsis: ''
    })
    const ids = page.entries.map((entry) => entry.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('列出已有工程时，名称规则只在领域恢复执行一次', async () => {
    const f = await fixture()
    const project = await createIn(f, '完好作品', '完好')
    const restore = vi.spyOn(Project, 'restore')

    await listPage(f.projects)

    expect(restore.mock.calls.filter((call) => call[0].id === project.projectId)).toHaveLength(1)
    restore.mockRestore()
  })

  it('无登记时返回空数组', async () => {
    const f = await fixture()

    expect(await listPage(f.projects)).toEqual({
      entries: [],
      total: 0,
      offset: 0,
      limit: 24
    })
  })

  it('登记目录不存在时该条不可用，其余条目继续返回', async () => {
    const f = await fixture()
    const kept = await createIn(f, '保留作品', '保留')
    const missing = await createIn(f, '被删作品', '被删')
    await rm(missing.directory, { recursive: true })

    const entries = (await listPage(f.projects)).entries

    expect(entryOf(entries, missing.projectId)).toMatchObject({ status: 'unavailable', code: 1308 })
    expect(entryOf(entries, kept.projectId)).toMatchObject({ status: 'available' })
  })

  it('管理目录整体缺失时按不可用处理，不当作未初始化工程', async () => {
    const f = await fixture()
    const project = await createIn(f, '内容缺失', '内容缺失')
    await rm(join(project.directory, '.opengalgame'), { recursive: true })

    expect(entryOf((await listPage(f.projects)).entries, project.projectId)).toMatchObject({
      status: 'unavailable',
      code: 1206
    })
  })

  it('清单损坏或版本不支持时该条不可用', async () => {
    const f = await fixture()
    const broken = await createIn(f, '损坏作品', '损坏')
    const path = join(broken.directory, '.opengalgame/manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))

    await writeFile(path, '{broken')
    expect(entryOf((await listPage(f.projects)).entries, broken.projectId)).toMatchObject({
      status: 'unavailable',
      code: 1203
    })

    await writeFile(path, JSON.stringify({ ...manifest, formatVersion: 3 }))
    expect(entryOf((await listPage(f.projects)).entries, broken.projectId)).toMatchObject({
      status: 'unavailable',
      code: 1202
    })
  })

  it('工程信息文件缺失时该条不可用', async () => {
    const f = await fixture()
    const project = await createIn(f, '缺文件作品', '缺文件')
    await rm(join(project.directory, '.opengalgame/project.json'))

    expect(entryOf((await listPage(f.projects)).entries, project.projectId)).toMatchObject({
      status: 'unavailable',
      code: 1206
    })
  })

  it('登记标识与工程标识不一致时回传登记标识与安全原因', async () => {
    const f = await fixture()
    await createIn(f, '身份不符', '身份不符')
    const registrations = await readProjectRegistrations(f.userDirectory)
    await writeProjectRegistrations(
      f.userDirectory,
      registrations.map((registration) => ({ ...registration, id: 'other' }))
    )

    const entries = (await listPage(f.projects)).entries

    expect(entries).toEqual([
      {
        status: 'unavailable',
        id: 'other',
        code: 1203,
        msg: '工程身份与登记不一致'
      }
    ])
  })

  it('登记表整体读取失败时向外传播，不冒充空列表', async () => {
    const f = await fixture()
    await createIn(f, '有登记', '有登记')
    await writeFile(join(f.userDirectory, 'projects.json'), '{broken')

    await expect(listPage(f.projects)).rejects.toMatchObject({ code: 1304 })
  })

  it('未识别的单项失败不被吞成不可用', async () => {
    const f = await fixture()
    await createIn(f, '意外失败', '意外失败')
    const failure = new Error('boom')
    vi.spyOn(f.storage, 'inspect').mockRejectedValueOnce(failure)

    await expect(listPage(f.projects)).rejects.toBe(failure)
  })

  it('查询不产生写入，也不为缺失工程重建目录或工程文件', async () => {
    const f = await fixture()
    const healthy = await createIn(f, '完好作品', '完好')
    const removed = await createIn(f, '缺失作品', '缺失')
    await rm(join(removed.directory, '.opengalgame'), { recursive: true })
    const manifestPath = join(healthy.directory, '.opengalgame/manifest.json')
    const projectPath = join(healthy.directory, '.opengalgame/project.json')
    const registrationsPath = join(f.userDirectory, 'projects.json')
    const manifestBefore = await readFile(manifestPath)
    const projectBefore = await readFile(projectPath)
    const registrationsBefore = await readFile(registrationsPath)

    await listPage(f.projects)

    expect(await readFile(manifestPath)).toEqual(manifestBefore)
    expect(await readFile(projectPath)).toEqual(projectBefore)
    expect(await readFile(registrationsPath)).toEqual(registrationsBefore)
    expect(await readdir(removed.directory)).toEqual(['assets'])
  })

  it('分页只返回当前页，总数仍是全部登记', async () => {
    const f = await fixture()
    const first = await createIn(f, '甲部', '甲')
    const second = await createIn(f, '乙部', '乙')
    const third = await createIn(f, '丙部', '丙')
    const ordered = [first.projectId, second.projectId, third.projectId].sort()

    const page = await listPage(f.projects, 1, 1)
    expect(page.total).toBe(3)
    expect(page.entries).toHaveLength(1)
    expect(page.offset).toBe(1)
    expect(page.limit).toBe(1)
    expect(page.entries[0].id).toBe(ordered[1])
  })

  it('打开返回摘要；重命名只改工程文件；移出只删登记项', async () => {
    const f = await fixture()
    const project = await createIn(f, '旧名', '作品', '原文')
    const filesBefore = await readdir(project.directory, { recursive: true })

    await expect(f.projects.openProject({ id: project.projectId })).resolves.toEqual({
      id: project.projectId,
      name: '旧名',
      synopsis: '原文'
    })

    await expect(
      f.projects.renameProject({ id: project.projectId, name: '新名', synopsis: '新简介' })
    ).resolves.toEqual({ id: project.projectId, name: '新名', synopsis: '新简介' })
    expect(entryOf((await listPage(f.projects)).entries, project.projectId)).toMatchObject({
      name: '新名',
      synopsis: '新简介'
    })

    await expect(f.projects.unregisterProject({ id: project.projectId })).resolves.toEqual({
      id: project.projectId
    })
    expect((await listPage(f.projects)).total).toBe(0)
    expect(await readdir(project.directory, { recursive: true })).toEqual(filesBefore)
  })
})
