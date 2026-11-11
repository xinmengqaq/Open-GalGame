import { describe, expect, it } from 'vitest'

import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  latestPreviewSaveOfResult,
  savedSceneVersionOfPreviewSave,
  sceneExportEntryOf,
  type SceneExportEntryState
} from '@presentation/pages/workbench/shell/sceneExportEntry'
import type { SavedSceneVersionFact } from '@presentation/pages/workbench/shell/WorkbenchPreviewLayer'

const contentBasis = {
  digest: 'content-digest-1',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}

const savedVersion: SavedSceneVersionFact = {
  requestId: 'save-request-1',
  contentBasis
}

const latestPreviewSave: PreviewSaveVersionVO = {
  requestId: 'save-request-1',
  revisionDigest: 'revision-1',
  contentBasis
}

function entryState(overrides: Partial<SceneExportEntryState> = {}): SceneExportEntryState {
  return {
    savedSceneVersion: null,
    exporting: false,
    pageBlocked: false,
    workspaceBlocked: false,
    generationActive: false,
    viewStale: false,
    saveState: 'saved',
    saveLabel: '已保存',
    ...overrides
  }
}

describe('latestPreviewSaveOfResult', () => {
  it('读取到已结算版本时返回版本引用', () => {
    expect(
      latestPreviewSaveOfResult({ code: ErrorCodes.success, msg: 'ok', data: latestPreviewSave })
    ).toBe(latestPreviewSave)
  })

  it('没有已结算版本时返回 null', () => {
    expect(latestPreviewSaveOfResult({ code: ErrorCodes.success, msg: 'ok', data: null })).toBeNull()
  })

  it('查询失败时按未恢复处理，不抛错', () => {
    expect(
      latestPreviewSaveOfResult({ code: ErrorCodes.internalError, msg: '读取失败' })
    ).toBeNull()
  })

  it('成功响应但缺少数据时按未恢复处理', () => {
    expect(latestPreviewSaveOfResult({ code: ErrorCodes.success, msg: 'ok' })).toBeNull()
  })
})

describe('savedSceneVersionOfPreviewSave', () => {
  it('只还原保存身份与内容依据，不携带 revision', () => {
    const version = savedSceneVersionOfPreviewSave(latestPreviewSave)
    expect(version).toEqual(savedVersion)
    expect(Object.keys(version ?? {})).toEqual(['requestId', 'contentBasis'])
  })

  it('没有已结算版本时保持未保存', () => {
    expect(savedSceneVersionOfPreviewSave(null)).toBeNull()
  })

  it('身份或内容依据为空时按未保存处理', () => {
    expect(
      savedSceneVersionOfPreviewSave({ ...latestPreviewSave, requestId: '   ' })
    ).toBeNull()
    expect(
      savedSceneVersionOfPreviewSave({
        ...latestPreviewSave,
        contentBasis: { ...contentBasis, digest: '  ' }
      })
    ).toBeNull()
  })
})

describe('sceneExportEntryOf', () => {
  it('有已结算版本且工作台就绪时允许导出', () => {
    expect(sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion }))).toEqual({
      canRun: true,
      hint: '导出已保存的当前场景为 Windows WebGAL 游戏'
    })
  })

  it('没有已结算版本时保持禁用并提示先保存', () => {
    expect(sceneExportEntryOf(entryState())).toEqual({
      canRun: false,
      hint: '还没有保存成功的场景内容；先在试玩预览里保存一次'
    })
  })

  it('hydration 读到已结算版本后放行导出', () => {
    const version = savedSceneVersionOfPreviewSave(
      latestPreviewSaveOfResult({
        code: ErrorCodes.success,
        msg: 'ok',
        data: latestPreviewSave
      })
    )
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: version })).canRun
    ).toBe(true)
  })

  it('hydration 查询失败时保持禁用', () => {
    const version = savedSceneVersionOfPreviewSave(
      latestPreviewSaveOfResult({ code: ErrorCodes.internalError, msg: '读取失败' })
    )
    expect(version).toBeNull()
    expect(sceneExportEntryOf(entryState({ savedSceneVersion: version })).canRun).toBe(false)
  })

  it('导出进行中时禁用并说明原因', () => {
    expect(sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, exporting: true })))
      .toEqual({ canRun: false, hint: '正在导出当前场景…' })
  })

  it('生成进行中或视图恢复中时禁用', () => {
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, generationActive: true }))
    ).toEqual({ canRun: false, hint: '生成进行中，暂不导出' })
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, viewStale: true }))
    ).toEqual({ canRun: false, hint: '工作台正在恢复历史视图，暂不导出' })
  })

  it('工作台保存未落定时禁用并引用保存状态', () => {
    expect(
      sceneExportEntryOf(
        entryState({ savedSceneVersion: savedVersion, saveState: 'saving', saveLabel: '正在保存' })
      )
    ).toEqual({
      canRun: false,
      hint: '工作台保存状态是“正在保存”，先处理后再导出'
    })
  })

  it('有未保存改动时可导出但提示先保存工作台改动', () => {
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, saveState: 'dirty' }))
    ).toEqual({
      canRun: true,
      hint: '先保存工作台改动，再导出已保存的当前场景'
    })
  })

  it('页面或工程未就绪时禁用', () => {
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, pageBlocked: true }))
    ).toEqual({ canRun: false, hint: '导出已保存的当前场景为 Windows WebGAL 游戏' })
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, workspaceBlocked: true }))
    ).toEqual({ canRun: false, hint: '导出已保存的当前场景为 Windows WebGAL 游戏' })
  })
})
