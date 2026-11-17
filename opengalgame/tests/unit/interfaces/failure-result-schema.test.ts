import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FailureReasons } from '@common/errors/FailureReasons'
import { SceneCanvasErrorCodes } from '@common/errors/SceneCanvasErrorCodes'
import {
  parseInstallUpdateResult,
  parseUpdateCheckResult,
  parseUpdateStatusResult
} from '@interfaces/app-update/contracts/AppUpdateResponseSchema'
import { isAjaxResult } from '@interfaces/contracts/AjaxResultSchema'
import { failureResultSchema } from '@interfaces/contracts/FailureResultSchema'
import { isProjectListResult } from '@interfaces/contracts/ProjectResponseSchema'
import { isResponse } from '@interfaces/contracts/ResponseSchema'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { parseProjectFileNullResult } from '@interfaces/project-files/contracts/ProjectFilesResponseSchema'
import { parseVersionHistoryClearResult } from '@interfaces/project-versioning/contracts/ProjectVersioningResponseSchema'
import { parseSceneCanvasSaveResult } from '@interfaces/scene-canvas/contracts/SceneCanvasResponseSchema'
import {
  parseLatestPreviewSaveResult,
  parseSceneExportResult
} from '@interfaces/scene-export/contracts/SceneExportResponseSchema'
import { parseSceneGenerationNullResult } from '@interfaces/scene-generation/contracts/SceneGenerationResponseSchema'
import { parseScenePreviewNullResult } from '@interfaces/scene-preview/contracts/ScenePreviewResponseSchema'
import { parseOpenDirectoryResult } from '@interfaces/system-path/contracts/SystemPathResponseSchema'

/** 失败信封的公共形状；data 只在成功时存在。 */
type FailureEnvelope = { code: number; msg: string; reason?: string; data?: unknown }

const failure = { code: 4401, msg: '安全失败消息' }
const reasonedFailure = {
  code: SceneCanvasErrorCodes.identityConflict,
  msg: '安全失败消息',
  reason: FailureReasons.promptReferenceDuplicate
}
/** 未知、且长于旧 1..64 约束的结构化原因；schema 与消费方都必须原样放行。 */
const unknownStructuralReason = `r18-future-structural-reason-${'x'.repeat(96)}`

/**
 * 所有已注册 IPC 域的失败信封解析入口。
 * 覆盖 app-update、home/project、project-files、project-versioning、scene-canvas、
 * scene-export、scene-generation、scene-preview、system-path；新增注册域必须补进本表。
 */
const channelFailureParsers: ReadonlyArray<
  readonly [string, (value: unknown) => FailureEnvelope | null]
> = [
  ['app-update:status', parseUpdateStatusResult],
  ['app-update:check', parseUpdateCheckResult],
  ['app-update:install', parseInstallUpdateResult],
  ['project-files:null', parseProjectFileNullResult],
  ['project-versioning:clear', parseVersionHistoryClearResult],
  ['scene-canvas:save', parseSceneCanvasSaveResult],
  ['scene-export:export', parseSceneExportResult],
  ['scene-generation:null', parseSceneGenerationNullResult],
  ['scene-preview:null', parseScenePreviewNullResult],
  ['system-path:open-directory', parseOpenDirectoryResult]
]

/**
 * 旧失败信封本就限制 `msg≤200` 的解析入口；其余已注册通道的旧边界没有该上限。
 * 两组都直接使用真实解析函数，不经过客户端接线或 mock 回声。
 */
const boundedMsgFailureParsers: ReadonlyArray<
  readonly [string, (value: unknown) => FailureEnvelope | null]
> = [
  ['app-update:status', parseUpdateStatusResult],
  ['app-update:check', parseUpdateCheckResult],
  ['app-update:install', parseInstallUpdateResult],
  ['scene-export:export', parseSceneExportResult],
  ['scene-export:latest-preview-save', parseLatestPreviewSaveResult],
  ['system-path:open-directory', parseOpenDirectoryResult]
]

const unboundedMsgFailureParsers: ReadonlyArray<
  readonly [string, (value: unknown) => FailureEnvelope | null]
> = [
  ['project-files:null', parseProjectFileNullResult],
  ['project-versioning:clear', parseVersionHistoryClearResult],
  ['scene-canvas:save', parseSceneCanvasSaveResult],
  ['scene-generation:null', parseSceneGenerationNullResult],
  ['scene-preview:null', parseScenePreviewNullResult]
]

describe('R18 失败码与失败 schema 冻结', () => {
  it('SceneCanvasErrorCodes 的 4401/4402/4416/4417 数值不变', () => {
    expect(SceneCanvasErrorCodes.identityConflict).toBe(4401)
    expect(SceneCanvasErrorCodes.targetMissing).toBe(4402)
    expect(SceneCanvasErrorCodes.contentDamaged).toBe(4416)
    expect(SceneCanvasErrorCodes.unsupportedFormat).toBe(4417)
  })

  it('所有注册通道的失败信封仍接受无 reason 的旧 payload，并原样交回 code/msg', () => {
    for (const [channel, parse] of channelFailureParsers) {
      const parsed = parse(failure)
      expect(parsed, channel).not.toBeNull()
      expect(parsed, channel).toMatchObject({ code: 4401, msg: '安全失败消息' })
      expect(parsed !== null && 'reason' in parsed, channel).toBe(false)
      expect(parsed !== null && 'data' in parsed, channel).toBe(false)
    }
    expect(isProjectListResult(failure)).toBe(true)
    expect(isAjaxResult(failure)).toBe(true)
    expect(isResponse(failure)).toBe(true)
  })

  it('所有注册通道的失败信封接受结构化 reason 并原样交回', () => {
    for (const [channel, parse] of channelFailureParsers) {
      const parsed = parse(reasonedFailure)
      expect(parsed, channel).not.toBeNull()
      expect(parsed, channel).toMatchObject(reasonedFailure)
    }
    expect(isProjectListResult(reasonedFailure)).toBe(true)
    expect(isAjaxResult(reasonedFailure)).toBe(true)
    expect(isResponse(reasonedFailure)).toBe(true)
  })

  it('失败信封不接受成功码，成功信封仍保持 code/msg/data 且不携带 reason', () => {
    expect(
      parseSceneCanvasSaveResult({ code: ErrorCodes.success, msg: '缺少 data 的成功不是失败信封' })
    ).toBeNull()

    const success = { code: ErrorCodes.success, msg: '编排已保存', data: null }
    expect(parseSceneCanvasSaveResult(success)).toEqual(success)
    expect(
      parseSceneCanvasSaveResult({ ...success, reason: FailureReasons.promptReferenceDuplicate })
    ).toBeNull()
    expect(isAjaxResult(success)).toBe(true)
  })

  it('失败结果 schema 只接受失败码与已知键，reason 是可选自由字符串', () => {
    const successCode = { code: ErrorCodes.success, msg: '成功不是失败' }
    const extraKey = { code: 4416, msg: '编排内容损坏', extra: 1 }
    const shortUnknownReason = { ...failure, reason: 'r18-future-structural-reason' }
    const longUnknownReason = { ...failure, reason: unknownStructuralReason }

    expect(failureResultSchema.safeParse(successCode).success).toBe(false)
    expect(failureResultSchema.safeParse(extraKey).success).toBe(false)
    expect(failureResultSchema.safeParse(shortUnknownReason).success).toBe(true)
    expect(failureResultSchema.safeParse(longUnknownReason).success).toBe(true)
    expect(failureResultSchema.parse(longUnknownReason)).toEqual(longUnknownReason)
  })

  it('旧消费忽略新增可选字段：未知超长 reason 不破坏基础判别且原样交回', () => {
    const withReason = { ...failure, reason: unknownStructuralReason }
    expect(isAjaxResult(withReason)).toBe(true)
    expect(isResponse(withReason)).toBe(true)
    for (const [channel, parse] of channelFailureParsers) {
      expect(parse(withReason), channel).toMatchObject(withReason)
    }
  })

  it('旧三域失败信封保持 msg≤200：200 接受并原样交回，201 判通信失败', () => {
    const accepted = { code: 4416, msg: 'x'.repeat(200), reason: unknownStructuralReason }
    const rejected = { ...accepted, msg: 'x'.repeat(201) }

    expect(failureResultSchema.safeParse(accepted).success).toBe(true)
    for (const [channel, parse] of boundedMsgFailureParsers) {
      expect(parse(accepted), channel).toMatchObject(accepted)
      expect(parse(rejected), channel).toBeNull()
    }
  })

  it('其余通道维持旧边界：201 字符失败消息仍原样交回', () => {
    const failure201 = { ...failure, msg: 'x'.repeat(201) }
    for (const [channel, parse] of unboundedMsgFailureParsers) {
      expect(parse(failure201), channel).toMatchObject(failure201)
    }
    expect(isProjectListResult(failure201)).toBe(true)
  })
})

describe('IpcErrorMapper 失败投影冻结', () => {
  const mapper = new IpcErrorMapper()

  it('4401/4402/4416/4417 保留数字码与可见文案', () => {
    const failures = [
      [4401, '同一提示词不能重复引用同一卡片'],
      [4402, '提示词引用必须是当前画布中的其他卡片'],
      [4416, '编排内容损坏'],
      [4417, '编排格式不受支持']
    ] as const

    for (const [code, msg] of failures) {
      expect(mapper.map(new AppException({ code, msg }))).toEqual({ code, msg })
    }
  })

  it('结构化 reason 原样投影，不写进失败消息', () => {
    const duplicate = mapper.map(
      new AppException({
        code: SceneCanvasErrorCodes.identityConflict,
        msg: '同一提示词不能重复引用同一卡片',
        reason: FailureReasons.promptReferenceDuplicate
      })
    )
    expect(duplicate).toEqual({
      code: SceneCanvasErrorCodes.identityConflict,
      msg: '同一提示词不能重复引用同一卡片',
      reason: FailureReasons.promptReferenceDuplicate
    })

    const missing = mapper.map(
      new AppException({
        code: SceneCanvasErrorCodes.targetMissing,
        msg: '提示词引用必须是当前画布中的其他卡片',
        reason: FailureReasons.promptReferenceTargetMissing
      })
    )
    expect(missing).toEqual({
      code: SceneCanvasErrorCodes.targetMissing,
      msg: '提示词引用必须是当前画布中的其他卡片',
      reason: FailureReasons.promptReferenceTargetMissing
    })
  })

  it('没有 reason 的 AppException 不产生 reason 键', () => {
    const result = mapper.map(new AppException({ code: 4416, msg: '编排内容损坏' }))
    expect(result).toEqual({ code: 4416, msg: '编排内容损坏' })
    expect('reason' in result).toBe(false)
  })

  it('带路径的 AppException 只替换消息，不用系统码覆盖业务码，reason 仍保留', () => {
    const result = mapper.map(
      new AppException({
        code: 4416,
        msg: 'D:\\projects\\secret\\canvas.json',
        reason: FailureReasons.promptReferenceDuplicate
      })
    )
    expect(result).toEqual({
      code: 4416,
      msg: '系统异常，操作未完成',
      reason: FailureReasons.promptReferenceDuplicate
    })
  })

  it('非 AppException 统一成 5103，且不带原文或调用栈', () => {
    const error = new Error('C:\\Users\\secret\\api-key.txt')
    error.stack = 'Error: C:\\Users\\secret\\api-key.txt\n    at readSecret'

    const result = mapper.map(error)
    expect(result).toEqual({ code: 5103, msg: '系统异常，操作未完成' })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('api-key')
    expect(JSON.stringify(result)).not.toContain('readSecret')
  })

  it('成功码不能用于异常', () => {
    expect(() => new AppException({ code: ErrorCodes.success, msg: '成功不是异常' })).toThrow(
      '成功码不能用于异常'
    )
  })
})

describe('R18 失败原因 mapper→schema 往返', () => {
  const mapper = new IpcErrorMapper()

  it('提示词引用 reason 经真实 mapper 投影后，所有通道失败信封都保留它', () => {
    const failures = [
      new AppException({
        code: SceneCanvasErrorCodes.identityConflict,
        msg: '同一提示词不能重复引用同一卡片',
        reason: FailureReasons.promptReferenceDuplicate
      }),
      new AppException({
        code: SceneCanvasErrorCodes.targetMissing,
        msg: '提示词引用必须是当前画布中的其他卡片',
        reason: FailureReasons.promptReferenceTargetMissing
      })
    ]

    for (const [channel, parse] of channelFailureParsers) {
      for (const error of failures) {
        const mapped = mapper.map(error)
        const parsed = parse(mapped)
        expect(parsed, channel).not.toBeNull()
        expect(parsed, channel).toMatchObject({
          code: error.code,
          msg: error.message,
          reason: error.reason
        })
      }
    }
  })

  it('旧无 reason 失败经 mapper 后在所有通道仍合法，且不伪造 reason', () => {
    for (const [channel, parse] of channelFailureParsers) {
      const mapped = mapper.map(new AppException({ code: 4416, msg: '编排内容损坏' }))
      const parsed = parse(mapped)
      expect(parsed, channel).not.toBeNull()
      expect(parsed, channel).toMatchObject({ code: 4416, msg: '编排内容损坏' })
      expect(parsed !== null && 'reason' in parsed, channel).toBe(false)
    }
  })
})
