import { describe, expect, it } from 'vitest'

import type { SavedSceneVersionVO } from '@application/scene-export/vo/SavedSceneVersionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  latestSavedSceneVersionOfResult,
  savedSceneVersionOfPreviewSave,
  savedSceneVersionOfResult,
  sceneExportEntryOf,
  type SceneExportEntryState
} from '@presentation/pages/workbench/shell/sceneExportEntry'
import type { SavedSceneVersionFact } from '@presentation/pages/workbench/shell/WorkbenchPreviewLayer'

const contentBasis = {
  digest: 'content-digest-1',
  parserVersion: '4.6.5',
  engineVersion: '4.6.5'
}

const previewVersion: SavedSceneVersionVO = {
  versionReference: { kind: 'preview-save', requestId: 'save-request-1' },
  revisionDigest: 'revision-1',
  contentBasis
}

const generationVersion: SavedSceneVersionVO = {
  versionReference: {
    kind: 'generation-commit',
    operationId: 'generation-operation-1',
    commitId: 'a'.repeat(40)
  },
  revisionDigest: 'revision-2',
  contentBasis
}

const savedVersion: SavedSceneVersionFact = {
  versionReference: previewVersion.versionReference,
  contentBasis
}

const generationSavedVersion: SavedSceneVersionFact = {
  versionReference: generationVersion.versionReference,
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

describe('latestSavedSceneVersionOfResult', () => {
  it('读取到预览保存版本时返回版本引用', () => {
    expect(
      latestSavedSceneVersionOfResult({
        code: ErrorCodes.success,
        msg: 'ok',
        data: previewVersion
      })
    ).toBe(previewVersion)
  })

  it('读取到生成提交版本时返回版本引用', () => {
    expect(
      latestSavedSceneVersionOfResult({
        code: ErrorCodes.success,
        msg: 'ok',
        data: generationVersion
      })
    ).toBe(generationVersion)
  })

  it('没有版本时返回 null', () => {
    expect(
      latestSavedSceneVersionOfResult({ code: ErrorCodes.success, msg: 'ok', data: null })
    ).toBeNull()
  })

  it('查询失败时按未恢复处理，不抛错', () => {
    expect(
      latestSavedSceneVersionOfResult({ code: ErrorCodes.internalError, msg: '读取失败' })
    ).toBeNull()
  })

  it('成功响应但缺少数据时按未恢复处理', () => {
    expect(latestSavedSceneVersionOfResult({ code: ErrorCodes.success, msg: 'ok' })).toBeNull()
  })
})

describe('savedSceneVersionOfResult', () => {
  it('还原预览保存身份与内容依据，不携带 revision', () => {
    const version = savedSceneVersionOfResult(previewVersion)
    expect(version).toEqual(savedVersion)
    expect(Object.keys(version ?? {})).toEqual(['versionReference', 'contentBasis'])
  })

  it('还原生成提交身份与内容依据', () => {
    expect(savedSceneVersionOfResult(generationVersion)).toEqual(generationSavedVersion)
  })

  it('没有版本时保持未保存', () => {
    expect(savedSceneVersionOfResult(null)).toBeNull()
  })

  it('身份或内容依据为空时按未保存处理', () => {
    expect(
      savedSceneVersionOfResult({
        ...previewVersion,
        versionReference: { kind: 'preview-save', requestId: '   ' }
      })
    ).toBeNull()
    expect(
      savedSceneVersionOfResult({
        ...generationVersion,
        versionReference: {
          kind: 'generation-commit',
          operationId: 'generation-operation-1',
          commitId: '   '
        }
      })
    ).toBeNull()
    expect(
      savedSceneVersionOfResult({
        ...generationVersion,
        versionReference: {
          kind: 'generation-commit',
          operationId: '   ',
          commitId: 'a'.repeat(40)
        }
      })
    ).toBeNull()
    expect(
      savedSceneVersionOfResult({
        ...previewVersion,
        contentBasis: { ...contentBasis, digest: '  ' }
      })
    ).toBeNull()
  })
})

describe('savedSceneVersionOfPreviewSave', () => {
  it('预览保存成功后生成预览来源的导出事实', () => {
    expect(savedSceneVersionOfPreviewSave({ requestId: 'save-request-1', contentBasis })).toEqual(
      savedVersion
    )
  })

  it('预览保存身份为空时忽略', () => {
    expect(savedSceneVersionOfPreviewSave({ requestId: '  ', contentBasis })).toBeNull()
  })
})

describe('sceneExportEntryOf', () => {
  it('有预览保存版本且工作台就绪时允许导出', () => {
    expect(sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion }))).toEqual({
      canRun: true,
      hint: '导出已保存的当前场景为 Windows WebGAL 游戏'
    })
  })

  it('有生成提交版本时同样允许导出', () => {
    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: generationSavedVersion }))
    ).toEqual({
      canRun: true,
      hint: '导出已保存的当前场景为 Windows WebGAL 游戏'
    })
  })

  it('没有已保存版本时保持禁用并提示先保存或接受生成结果', () => {
    expect(sceneExportEntryOf(entryState())).toEqual({
      canRun: false,
      hint: '还没有可导出的已保存场景；先在试玩预览里保存，或接受一次生成结果'
    })
  })

  it('hydration 读到预览保存版本后放行导出', () => {
    const version = savedSceneVersionOfResult(
      latestSavedSceneVersionOfResult({
        code: ErrorCodes.success,
        msg: 'ok',
        data: previewVersion
      })
    )
    expect(sceneExportEntryOf(entryState({ savedSceneVersion: version })).canRun).toBe(true)
  })

  it('hydration 读到生成提交版本后放行导出', () => {
    const version = savedSceneVersionOfResult(
      latestSavedSceneVersionOfResult({
        code: ErrorCodes.success,
        msg: 'ok',
        data: generationVersion
      })
    )
    expect(sceneExportEntryOf(entryState({ savedSceneVersion: version })).canRun).toBe(true)
  })

  it('hydration 查询失败时保持禁用', () => {
    const version = savedSceneVersionOfResult(
      latestSavedSceneVersionOfResult({ code: ErrorCodes.internalError, msg: '读取失败' })
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

  it('多个阻断同时成立时按固定顺序给出唯一原因', () => {
    expect(
      sceneExportEntryOf(
        entryState({
          savedSceneVersion: null,
          exporting: true,
          pageBlocked: true,
          generationActive: true,
          viewStale: true
        })
      )
    ).toEqual({ canRun: false, hint: '正在导出当前场景…' })

    expect(
      sceneExportEntryOf(
        entryState({
          savedSceneVersion: null,
          generationActive: true,
          viewStale: true,
          saveState: 'saving'
        })
      )
    ).toEqual({ canRun: false, hint: '工作台正在恢复历史视图，暂不导出' })

    expect(
      sceneExportEntryOf(
        entryState({
          savedSceneVersion: savedVersion,
          generationActive: true,
          viewStale: true,
          saveState: 'saving'
        })
      )
    ).toEqual({ canRun: false, hint: '工作台正在恢复历史视图，暂不导出' })

    expect(
      sceneExportEntryOf(
        entryState({
          savedSceneVersion: savedVersion,
          generationActive: true,
          saveState: 'saving'
        })
      )
    ).toEqual({ canRun: false, hint: '生成进行中，暂不导出' })

    expect(
      sceneExportEntryOf(
        entryState({
          savedSceneVersion: savedVersion,
          saveState: 'failed',
          saveLabel: '保存失败'
        })
      )
    ).toEqual({
      canRun: false,
      hint: '工作台保存状态是“保存失败”，先处理后再导出'
    })

    expect(
      sceneExportEntryOf(entryState({ savedSceneVersion: savedVersion, saveState: 'dirty' }))
    ).toEqual({ canRun: true, hint: '先保存工作台改动，再导出已保存的当前场景' })
  })
})
