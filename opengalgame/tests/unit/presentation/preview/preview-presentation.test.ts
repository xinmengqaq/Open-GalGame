import { describe, expect, it } from 'vitest'

import {
  blockedAvailabilityCopy,
  dialogueNumber,
  failureFromError,
  historyHint,
  phaseStatusOf,
  positionTextOf,
  prepareFailureAction,
  previewIssueList,
  previewUpdateCopy,
  saveFailureAction,
  saveHintOf,
  saveStatusOf,
  selectFailureAction,
  settlementCopy,
  settlementPendingQueryNote,
  settlementQueryFailureNote,
  settlementQueryOutcome,
  type PreviewSaveUiState
} from '@presentation/pages/preview/previewPresentation'
import type { DialogueSaveSettlementVO } from '@application/scene-preview/vo/DialogueSaveVO'
import type { SceneDialogueVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

const dialogues: readonly SceneDialogueVO[] = [
  { dialogueId: 'line-1', text: '第一句', editable: true },
  { dialogueId: 'line-2', text: '第二句', editable: true }
]

const idle: PreviewSaveUiState = { status: 'idle' }

describe('预览文案映射', () => {
  it('引擎错误只显示安全人话，不暴露错误码或会话身份', () => {
    const failure = failureFromError({
      code: 'prepareFailed',
      message: 'prepareFailed',
      recovery: 'retry'
    })

    expect(failure.message).toContain('舞台没有加载成功')
    expect(failure.message).not.toContain('prepareFailed')
    expect(failure.message).not.toContain('previewSessionId')
    expect(failure.code).toBe('prepareFailed')
  })

  it('位置只显示句序，不显示台词身份', () => {
    expect(dialogueNumber(dialogues, 'line-2')).toBe(2)
    expect(dialogueNumber(dialogues, 'missing')).toBeNull()
    expect(positionTextOf({ kind: 'dialogue', dialogueId: 'line-1' }, dialogues)).toBe(
      '第 1 句 / 共 2 句'
    )
    expect(positionTextOf({ kind: 'nonDialogue' }, dialogues)).toBe('演出中')
    expect(positionTextOf({ kind: 'completed' }, dialogues)).toBe('共 2 句')
    expect(positionTextOf({ kind: 'unknown' }, dialogues)).toBe('位置待确认')
  })

  it('阶段未确认时用真实句位表达已定位，不伪造播放或暂停', () => {
    expect(
      phaseStatusOf({ stage: 'preparing', phase: 'unknown', position: { kind: 'unknown' } })
    ).toEqual({ label: '准备中', tone: 'busy' })
    expect(
      phaseStatusOf({ stage: 'ready', phase: 'unknown', position: { kind: 'unknown' } })
    ).toEqual({ label: '正在进入', tone: 'busy' })
    expect(
      phaseStatusOf({
        stage: 'ready',
        phase: 'unknown',
        position: { kind: 'dialogue', dialogueId: 'line-1' }
      })
    ).toEqual({ label: '已定位', tone: 'ok' })
    expect(
      phaseStatusOf({ stage: 'ready', phase: 'unknown', position: { kind: 'nonDialogue' } })
    ).toEqual({ label: '演出中', tone: 'ok' })
    expect(
      phaseStatusOf({ stage: 'ready', phase: 'unknown', position: { kind: 'completed' } })
    ).toEqual({ label: '本场结束', tone: 'quiet' })
    expect(
      phaseStatusOf({
        stage: 'ready',
        phase: 'playing',
        position: { kind: 'dialogue', dialogueId: 'line-1' }
      })
    ).toEqual({ label: '播放中', tone: 'ok' })
    expect(
      phaseStatusOf({
        stage: 'ready',
        phase: 'paused',
        position: { kind: 'dialogue', dialogueId: 'line-1' }
      })
    ).toEqual({ label: '已暂停', tone: 'quiet' })
    expect(
      phaseStatusOf({
        stage: 'ready',
        phase: 'completed',
        position: { kind: 'completed' }
      })
    ).toEqual({ label: '本场结束', tone: 'quiet' })
    expect(
      phaseStatusOf({ stage: 'failed', phase: 'unknown', position: { kind: 'unknown' } })
    ).toEqual({ label: '无法试玩', tone: 'error' })
  })

  it('保存状态同时表达未保存、保存中、等待确认和失败', () => {
    expect(
      saveStatusOf({ state: idle, dirtyCount: 0, lockState: 'editable', previewSyncLost: false })
    ).toEqual({ label: '已保存', tone: 'ok' })
    expect(
      saveStatusOf({ state: idle, dirtyCount: 2, lockState: 'editable', previewSyncLost: false })
    ).toEqual({ label: '2 处未保存', tone: 'dirty' })
    expect(
      saveStatusOf({
        state: { status: 'saving' },
        dirtyCount: 2,
        lockState: 'editable',
        previewSyncLost: false
      })
    ).toEqual({ label: '保存中…', tone: 'busy' })
    expect(
      saveStatusOf({
        state: {
          status: 'pending',
          requestId: 'request',
          failure: { code: 'saveOutcomeUnknown', message: '', recovery: 'querySettlement' },
          querying: false,
          queryNote: null
        },
        dirtyCount: 0,
        lockState: 'editable',
        previewSyncLost: false
      })
    ).toEqual({ label: '等待确认', tone: 'busy' })
    expect(
      saveStatusOf({
        state: { status: 'saved' },
        dirtyCount: 0,
        lockState: 'editable',
        previewSyncLost: true
      })
    ).toEqual({ label: '已保存 · 预览未同步', tone: 'warning' })
    expect(
      saveStatusOf({ state: idle, dirtyCount: 0, lockState: 'locked', previewSyncLost: false })
    ).toEqual({ label: '只读', tone: 'muted' })
  })

  it('保存提示优先说明只读、空正文和确认中', () => {
    expect(
      saveHintOf({
        state: idle,
        dirtyCount: 1,
        blankCount: 0,
        lockState: 'locked',
        blockedReason: null,
        sessionOpen: true
      })
    ).toContain('正在别处编辑')
    expect(
      saveHintOf({
        state: idle,
        dirtyCount: 1,
        blankCount: 1,
        lockState: 'editable',
        blockedReason: null,
        sessionOpen: true
      })
    ).toContain('补上后再保存')
    expect(
      saveHintOf({
        state: idle,
        dirtyCount: 0,
        blankCount: 0,
        lockState: 'editable',
        blockedReason: null,
        sessionOpen: true
      })
    ).toContain('没有需要保存')
  })

  it('撤销重做提示能区分输入中、保存中和只读', () => {
    expect(
      historyHint({
        action: 'undo',
        available: false,
        editing: true,
        lockState: 'editable',
        saveState: idle
      })
    ).toContain('结束本次编辑')
    expect(
      historyHint({
        action: 'redo',
        available: false,
        editing: false,
        lockState: 'editable',
        saveState: { status: 'saving' }
      })
    ).toContain('保存期间')
    expect(
      historyHint({
        action: 'undo',
        available: false,
        editing: false,
        lockState: 'locked',
        saveState: idle
      })
    ).toBe('当前场景只读')
  })

  it('保存后的预览更新失败不混成保存失败', () => {
    expect(
      previewUpdateCopy(
        {
          status: 'unavailable',
          reason: 'stageNeverPrepared'
        },
        3
      )
    ).toEqual({
      tone: 'quiet',
      message: '已保存。舞台还没有准备过，预览没有更新。',
      action: 'none'
    })
    expect(
      previewUpdateCopy(
        { status: 'failed', failure: { code: 'commandTimeout', message: '', recovery: 'retry' } },
        3
      )
    ).toEqual({
      tone: 'warning',
      message: '已保存。预览没有回到第 3 句。',
      action: 'retryLocate'
    })
    expect(
      previewUpdateCopy(
        {
          status: 'failed',
          failure: { code: 'staleRuntimeGeneration', message: '', recovery: 'retry' }
        },
        3
      )
    ).toMatchObject({ action: 'reopen' })
  })

  it('保存结算按真实结果分别表达', () => {
    expect(
      settlementCopy({
        status: 'saved',
        contentBasis: { digest: 'a', parserVersion: 'p', engineVersion: 'e' },
        committedEdits: []
      })
    ).toEqual({ tone: 'ok', message: '保存已核对，修改已经写入场景。' })
    expect(
      settlementCopy({
        status: 'pendingVerification',
        request: { projectId: 'p', sceneId: 's', requestId: 'r' },
        failure: { code: 'saveOutcomeUnknown', message: '', recovery: 'querySettlement' }
      })
    ).toEqual({ tone: 'busy', message: '保存结果仍在核对，请稍后再查一次。' })
    expect(
      settlementCopy({
        status: 'notFound',
        request: { projectId: 'p', sceneId: 's', requestId: 'r' }
      })
    ).toEqual({ tone: 'error', message: '没有找到这次保存记录，内容仍保留在左侧。' })
  })

  it('读取提示按句归组，空场景和不可用各有可执行文案', () => {
    const issues = previewIssueList([
      { code: 'missingAsset', message: 'raw', dialogueId: 'line-1' },
      { code: 'missingAsset', message: 'raw', dialogueId: 'line-2' }
    ])

    expect(issues).toHaveLength(2)
    expect(issues[0]?.message).toContain('素材')
    expect(issues[0]?.key).not.toBe(issues[1]?.key)
    expect(blockedAvailabilityCopy('noArtifact').copy).toContain('生成并保存')
    expect(blockedAvailabilityCopy('readUnavailable').title).toContain('读不到')
  })

  it('恢复动作只在真实可恢复时出现', () => {
    expect(
      selectFailureAction({
        code: 'runtimeDisconnected',
        message: '',
        recovery: 'retry'
      })
    ).toBe('reopen')
    expect(
      selectFailureAction({
        code: 'engineCapabilityUnavailable',
        message: '',
        recovery: 'none'
      })
    ).toBe('none')
    expect(
      prepareFailureAction({
        code: 'engineCapabilityUnavailable',
        message: '',
        recovery: 'none'
      })
    ).toBe('none')
    expect(
      saveFailureAction({
        code: 'contentLocked',
        message: '',
        recovery: 'none'
      })
    ).toBe('none')
    expect(
      saveFailureAction({
        code: 'saveOutcomeUnknown',
        message: '',
        recovery: 'querySettlement'
      })
    ).toBe('querySettlement')
  })
})

const contentBasis = { digest: 'digest-1', parserVersion: '4.6.5', engineVersion: '4.6.5' }

const pendingSettlement: DialogueSaveSettlementVO = {
  status: 'pendingVerification',
  request: { projectId: 'project-1', sceneId: 'scene-1', requestId: 'request-1' },
  failure: { code: 'saveOutcomeUnknown', message: '保存结果尚未核对', recovery: 'querySettlement' }
}

const savedSettlement: DialogueSaveSettlementVO = {
  status: 'saved',
  contentBasis,
  committedEdits: [{ dialogueId: 'dialogue-1', text: '修改后的台词' }]
}

const unchangedSettlement: DialogueSaveSettlementVO = {
  status: 'unchanged',
  contentBasis,
  confirmedEdits: []
}

const conflictSettlement: DialogueSaveSettlementVO = {
  status: 'conflict',
  request: { projectId: 'project-1', sceneId: 'scene-1', requestId: 'request-1' },
  failure: { code: 'saveSettlementConflict', message: '', recovery: 'reopen' }
}

describe('保存结算查询结果', () => {
  it('仍待核对时给出带时间的重新查询提示，让「查看结果」有可见变化', () => {
    const outcome = settlementQueryOutcome(
      { code: 2000, data: pendingSettlement },
      new Date(2026, 10, 6, 9, 12, 34)
    )

    expect(outcome.kind).toBe('pending')
    if (outcome.kind === 'pending') {
      expect(outcome.queryNote).toBe('已于 09:12:34 重新查询，仍在核对')
      expect(outcome.queryNote).not.toBe(settlementCopy(pendingSettlement).message)
    }
  })

  it('查询到已保存时进入保存完成分支', () => {
    const outcome = settlementQueryOutcome({ code: 2000, data: savedSettlement }, new Date())

    expect(outcome.kind).toBe('saved')
    if (outcome.kind === 'saved') {
      expect(outcome.settlement.contentBasis.digest).toBe('digest-1')
    }
  })

  it('查询到内容没有变化时进入无变化分支', () => {
    expect(settlementQueryOutcome({ code: 2000, data: unchangedSettlement }, new Date()).kind).toBe(
      'unchanged'
    )
  })

  it('查询失败时给出可重试的可见提示', () => {
    const outcome = settlementQueryOutcome({ code: 5000 }, new Date())

    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.queryNote).toBe(settlementQueryFailureNote)
      expect(outcome.queryNote).toBe('查询失败，请稍后再试')
    }
    expect(settlementQueryOutcome({ code: 2000 }, new Date())).toEqual({
      kind: 'error',
      queryNote: '查询失败，请稍后再试'
    })
  })

  it('未提交、冲突和找不到记录仍交给拒绝分支', () => {
    expect(
      settlementQueryOutcome({ code: 2000, data: conflictSettlement }, new Date())
    ).toMatchObject({ kind: 'settled', settlement: { status: 'conflict' } })
  })

  it('时间提示补零到两位', () => {
    expect(settlementPendingQueryNote(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      '已于 03:04:05 重新查询，仍在核对'
    )
  })
})
