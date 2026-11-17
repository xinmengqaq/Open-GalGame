import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectFileOperationSettlementVO } from '@application/project-files/vo/ProjectFileOperationVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import {
  beginCatalogWrite,
  catalogProjectNeedsRecovery,
  endCatalogWrite,
  isUncertainCatalogWrite,
  resolveCatalogWrite,
  settleCatalogProjectAfterOpen
} from '@presentation/features/input-catalog/catalogWrites'
import { COMMIT_UNCLEAR_CODE } from '@presentation/feedback/projectFilesFeedback'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function clientReturning(
  settlement: ProjectFileOperationSettlementVO['settlement'],
  linked = true,
  recoveryState: 'pending' | 'notStarted' | 'committed' | 'notCommitted' =
    settlement === 'committed'
      ? 'committed'
      : settlement === 'notCommitted'
        ? 'notCommitted'
        : 'pending'
): { client: ProjectFilesClient; calls: Array<{ projectId: string; operationId: string }> } {
  const calls: Array<{ projectId: string; operationId: string }> = []
  return {
    calls,
    client: {
      readProjectFileOperation: async (request) => {
        calls.push(request)
        return ok({ operationId: request.operationId, settlement, linked })
      },
      recoverProjectFileOperations: async (request) =>
        ok(
          request.operationIds.map((operationId) => ({
            operationId,
            state: recoveryState
          }))
        )
    } as unknown as ProjectFilesClient
  }
}

function openProject(projectId: string): void {
  useWorkbenchSessionStore.getState().startSession({
    projectId,
    projectName: projectId,
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
}

afterEach(() => {
  useWorkbenchSessionStore.getState().reset()
  endCatalogWrite('', () => undefined)
})

describe('文件写结果核对', () => {
  it('通信中断与提交不明需要核对', () => {
    expect(isUncertainCatalogWrite({ code: COMMIT_UNCLEAR_CODE, msg: '不明' })).toBe(true)
    expect(isUncertainCatalogWrite({ code: 5102, msg: '通信失败' })).toBe(true)
    expect(isUncertainCatalogWrite({ code: 4323, msg: '文件名冲突' })).toBe(false)
  })

  it('已提交操作核对外成功后返回，未重复调用写入', async () => {
    const read = clientReturning('committed')
    await expect(
      resolveCatalogWrite(read.client, 'project-1', 'op-1')
    ).resolves.toBe('committed')
    expect(read.calls).toEqual([{ projectId: 'project-1', operationId: 'op-1' }])
  })

  it('确定未提交时抛出确定失败，不继续等待', async () => {
    const read = clientReturning('notCommitted')
    await expect(
      resolveCatalogWrite(read.client, 'project-1', 'op-1')
    ).rejects.toMatchObject({
      code: 4329,
      message: '文件操作未提交，请重试。'
    })
  })

  it('仍无法核对时硬报错，不建立待核对状态', async () => {
    const read = clientReturning('unsettled')
    await expect(
      resolveCatalogWrite(read.client, 'project-unsettled', 'op-1')
    ).rejects.toMatchObject({
      code: COMMIT_UNCLEAR_CODE,
      message: '文件操作结果仍无法核对，请重新打开工程恢复。'
    })
  })

  it('核对读取本身失败时不降级为成功或长期忙碌', async () => {
    const client = {
      readProjectFileOperation: async () => ({
        code: ErrorCodes.communicationFailed,
        msg: '通信失败'
      })
    } as unknown as ProjectFilesClient
    await expect(resolveCatalogWrite(client, 'project-read-failure', 'op-1')).rejects.toMatchObject({
      code: COMMIT_UNCLEAR_CODE,
      message: '文件操作结果仍无法核对，请重新打开工程恢复。'
    })
  })

  it('写入闸在核对失败后释放，不长期拦住其他工程', async () => {
    openProject('project-1')
    const busy = { value: false }
    const setBusy = (value: boolean): void => {
      busy.value = value
    }
    expect(beginCatalogWrite('project-1', false, setBusy)).toBe(true)
    expect(beginCatalogWrite('project-2', false, setBusy)).toBe(false)
    endCatalogWrite('project-1', setBusy)
    expect(busy.value).toBe(false)
    expect(beginCatalogWrite('project-2', false, setBusy)).toBe(true)
    endCatalogWrite('project-2', setBusy)
  })

  it('切走后旧工程核对结果不改当前工程忙碌态', async () => {
    openProject('project-1')
    const busy = { value: false }
    const setBusy = (value: boolean): void => {
      busy.value = value
    }
    expect(beginCatalogWrite('project-1', false, setBusy)).toBe(true)
    openProject('project-2')
    busy.value = false
    await resolveCatalogWrite(clientReturning('committed').client, 'project-1', 'op-1')
    endCatalogWrite('project-1', setBusy)
    expect(busy.value).toBe(false)
    expect(beginCatalogWrite('project-2', false, setBusy)).toBe(true)
    endCatalogWrite('project-2', setBusy)
  })

  it('未核实后保留同次操作并阻止同工程再写，显式终态才解除', async () => {
    openProject('project-pending')
    const busy = { value: false }
    const setBusy = (value: boolean): void => {
      busy.value = value
    }
    const unsettled = clientReturning('unsettled')
    await expect(
      resolveCatalogWrite(unsettled.client, 'project-pending', 'op-pending')
    ).rejects.toMatchObject({ code: COMMIT_UNCLEAR_CODE })
    expect(catalogProjectNeedsRecovery('project-pending')).toBe(true)
    expect(beginCatalogWrite('project-pending', false, setBusy)).toBe(false)
    expect(busy.value).toBe(false)

    const pending = clientReturning('unsettled', false, 'pending')
    await settleCatalogProjectAfterOpen(pending.client, 'project-pending')
    expect(catalogProjectNeedsRecovery('project-pending')).toBe(true)

    const committed = clientReturning('committed', true, 'committed')
    await settleCatalogProjectAfterOpen(committed.client, 'project-pending')
    expect(catalogProjectNeedsRecovery('project-pending')).toBe(false)
    expect(beginCatalogWrite('project-pending', false, setBusy)).toBe(true)
    endCatalogWrite('project-pending', setBusy)
  })

  it('核对抛出的异常携带可展示消息', async () => {
    const error = await resolveCatalogWrite(
      clientReturning('notCommitted').client,
      'project-1',
      'op-1'
    ).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(AppException)
    expect((error as AppException).message).toBe('文件操作未提交，请重试。')
  })
})
