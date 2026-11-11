import { describe, expect, it, vi } from 'vitest'

import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import type {
  VersionHistoryEntryVO,
  VersionHistoryPageVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { ProjectVersioningClientImpl } from '@interfaces/project-versioning/client/ProjectVersioningClientImpl'
import { ProjectVersioningController } from '@interfaces/project-versioning/ipc/ProjectVersioningController'
import { registerProjectVersioningIpc } from '@interfaces/project-versioning/ipc/registerProjectVersioningIpc'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown) => {
      ipc.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipc.handlers.delete(channel)
    }
  }
}))

const access = { trusted: true, requestId: 'req-1' }

function entry(overrides: Partial<VersionHistoryEntryVO> = {}): VersionHistoryEntryVO {
  return {
    historyId: 'history-1',
    sourceModule: 'scene-canvas',
    targets: [{ kind: 'scene-canvas', id: 'canvas-1' }],
    saveMode: 'manual',
    contentSource: 'operation',
    title: '保存场景编排',
    summary: '更新了 4 张卡片。',
    createdAt: '2026-10-18T08:00:00.000Z',
    state: '已提交',
    canUndo: true,
    canClear: true,
    ...overrides
  }
}

function historyPage(): VersionHistoryPageVO {
  return { entries: [entry()], nextCursor: 'history-1' }
}

function createController(service: Partial<ProjectVersioningApplicationService>): {
  controller: ProjectVersioningController
  calls: string[]
} {
  const calls: string[] = []
  const logger: LoggerGateway = {
    debug: (event) => calls.push(event),
    info: (event) => calls.push(event),
    warn: (event) => calls.push(event),
    error: (event) => calls.push(event)
  }
  return {
    calls,
    controller: new ProjectVersioningController(
      service as ProjectVersioningApplicationService,
      new IpcExceptionHandler(logger)
    )
  }
}

describe('提交与回滚用户接口', () => {
  it('严格解析历史筛选并原样交给应用服务', async () => {
    const page = historyPage()
    const listHistory = vi.fn(async () => page)
    const { controller } = createController({ listHistory })
    const request = {
      projectId: 'project-1',
      saveMode: 'manual',
      cursor: 'history-0',
      pageSize: 20
    }
    await expect(controller.listHistory(request, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: page
    })
    expect(listHistory).toHaveBeenCalledWith(request)

    await expect(
      controller.listHistory({ ...request, path: 'scenes/start.txt' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      controller.listHistory({ ...request, pageSize: 0 }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      controller.listHistory({ ...request, pageSize: 1.5 }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(listHistory).toHaveBeenCalledTimes(1)
  })

  it('请求来源不可信时拒绝，不调用应用用例', async () => {
    const listHistory = vi.fn(async () => historyPage())
    const { controller } = createController({ listHistory })
    await expect(
      controller.listHistory(
        { projectId: 'project-1', pageSize: 20 },
        { trusted: false, requestId: 'req-2' }
      )
    ).resolves.toMatchObject({ code: ErrorCodes.forbidden })
    expect(listHistory).not.toHaveBeenCalled()
  })

  it('撤销只接受工程和历史身份', async () => {
    const undoHistoryEntry = vi.fn(async () => ({
      historyId: 'history-1',
      state: '已回退' as const
    }))
    const { controller } = createController({ undoHistoryEntry })
    const request = { projectId: 'project-1', historyId: 'history-1' }
    await expect(controller.undoHistoryEntry(request, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: { historyId: 'history-1', state: '已回退' }
    })
    expect(undoHistoryEntry).toHaveBeenCalledWith(request)

    await expect(
      controller.undoHistoryEntry({ ...request, operationId: 'operation-1' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(undoHistoryEntry).toHaveBeenCalledTimes(1)
  })

  it('清理接受单条和已确认类别边界，拒绝缺失边界', async () => {
    const clearHistory = vi.fn(async () => ({ clearedCount: 2 }))
    const { controller } = createController({ clearHistory })
    await expect(
      controller.clearHistory(
        { projectId: 'project-1', selection: { kind: 'entry', historyId: 'history-1' } },
        access
      )
    ).resolves.toMatchObject({ code: ErrorCodes.success, data: { clearedCount: 2 } })

    const category = {
      projectId: 'project-1',
      selection: {
        kind: 'category' as const,
        saveMode: 'system' as const,
        throughHistoryId: 'history-1'
      }
    }
    await expect(controller.clearHistory(category, access)).resolves.toMatchObject({
      code: ErrorCodes.success
    })
    expect(clearHistory).toHaveBeenCalledTimes(2)

    await expect(
      controller.clearHistory(
        {
          projectId: 'project-1',
          selection: { kind: 'category', saveMode: 'system' }
        },
        access
      )
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(clearHistory).toHaveBeenCalledTimes(2)
  })

  it('应用失败按错误码返回，不携带 data，日志只记一次', async () => {
    const undoHistoryEntry = vi.fn(async () => {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '目标已有后续修改' })
    })
    const { controller, calls } = createController({ undoHistoryEntry })
    await expect(
      controller.undoHistoryEntry({ projectId: 'project-1', historyId: 'history-1' }, access)
    ).resolves.toEqual({ code: ErrorCodes.operationConflict, msg: '目标已有后续修改' })
    expect(calls.filter((event) => event === '请求执行失败')).toHaveLength(1)
  })
})

describe('提交与回滚客户端', () => {
  it('校验历史页响应，缺失或多余字段都不是成功', async () => {
    const valid = new ProjectVersioningClientImpl({
      listVersionHistory: async () => ({
        code: ErrorCodes.success,
        msg: 'ok',
        data: historyPage()
      })
    } as unknown as DesktopBridge)
    await expect(
      valid.listHistory({ projectId: 'project-1', pageSize: 20 })
    ).resolves.toMatchObject({ code: ErrorCodes.success, data: historyPage() })

    const missingData = new ProjectVersioningClientImpl({
      listVersionHistory: async () => ({ code: ErrorCodes.success, msg: 'ok' })
    } as unknown as DesktopBridge)
    await expect(
      missingData.listHistory({ projectId: 'project-1', pageSize: 20 })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })

    const extraField = new ProjectVersioningClientImpl({
      listVersionHistory: async () => ({
        code: ErrorCodes.success,
        msg: 'ok',
        data: { entries: [{ ...entry(), path: 'scenes/start.txt' }], nextCursor: null }
      })
    } as unknown as DesktopBridge)
    await expect(
      extraField.listHistory({ projectId: 'project-1', pageSize: 20 })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })

    const failureWithData = new ProjectVersioningClientImpl({
      listVersionHistory: async () => ({
        code: ErrorCodes.internalError,
        msg: '失败',
        data: historyPage()
      })
    } as unknown as DesktopBridge)
    await expect(
      failureWithData.listHistory({ projectId: 'project-1', pageSize: 20 })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })
  })

  it('撤销状态和清理数量必须符合协议，传输中断返回通信失败', async () => {
    const wrongUndo = new ProjectVersioningClientImpl({
      undoVersionHistoryEntry: async () => ({
        code: ErrorCodes.success,
        msg: 'ok',
        data: { historyId: 'history-1', state: '已提交' }
      })
    } as unknown as DesktopBridge)
    await expect(
      wrongUndo.undoHistoryEntry({ projectId: 'project-1', historyId: 'history-1' })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })

    const negativeCount = new ProjectVersioningClientImpl({
      clearVersionHistory: async () => ({
        code: ErrorCodes.success,
        msg: 'ok',
        data: { clearedCount: -1 }
      })
    } as unknown as DesktopBridge)
    await expect(
      negativeCount.clearHistory({
        projectId: 'project-1',
        selection: { kind: 'entry', historyId: 'history-1' }
      })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })

    const interrupted = new ProjectVersioningClientImpl({
      clearVersionHistory: async () => {
        throw new Error('bridge down')
      }
    } as unknown as DesktopBridge)
    await expect(
      interrupted.clearHistory({
        projectId: 'project-1',
        selection: { kind: 'entry', historyId: 'history-1' }
      })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })
  })
})

describe('提交与回滚通道注册', () => {
  it('注册和注销同一份固定通道表，不暴露内部版本方法', () => {
    const detach = registerProjectVersioningIpc({
      projectVersioning: {} as ProjectVersioningController,
      getWindow: () => null,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    expect(ipc.handlers.has('project-versioning:list-history')).toBe(true)
    expect(ipc.handlers.has('project-versioning:undo-history-entry')).toBe(true)
    expect(ipc.handlers.has('project-versioning:clear-history')).toBe(true)
    expect(ipc.handlers.has('project-versioning:commit-operation')).toBe(false)
    expect(ipc.handlers.has('project-versioning:rollback-operation')).toBe(false)
    detach()
    expect(ipc.handlers.size).toBe(0)
  })
})
