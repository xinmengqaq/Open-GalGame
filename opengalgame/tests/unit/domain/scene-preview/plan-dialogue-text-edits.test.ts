import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import {
  ScenePreviewErrorCodes,
  type ScenePreviewErrorCode
} from '@domain/scene-preview/errors/ScenePreviewErrorCodes'
import type { DialogueTextEdit } from '@domain/scene-preview/models/DialogueTextEdit'
import type { SceneDialogueSnapshot } from '@domain/scene-preview/models/SceneDialogueSnapshot'
import { planDialogueTextEdits } from '@domain/scene-preview/services/planDialogueTextEdits'

const scene = { projectId: 'project-1', sceneId: 'scene-1' }

function snapshot(
  dialogues: SceneDialogueSnapshot['dialogues'] = [
    { dialogueId: '1', text: '原来的一句', editable: true },
    { dialogueId: '2', text: '  保留空白  ', editable: true },
    { dialogueId: '3', text: '不能改', editable: false }
  ]
): SceneDialogueSnapshot {
  return { scene, dialogues }
}

function expectCode(run: () => unknown, code: ScenePreviewErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

describe('planDialogueTextEdits', () => {
  it('把变化和未变化分开，并保留正文原样', () => {
    const plan = planDialogueTextEdits(snapshot(), [
      { dialogueId: '2', text: '  保留空白  ' },
      { dialogueId: '1', text: '  改过的一句  ' }
    ])

    expect(plan.scene).toBe(scene)
    expect(plan.unchangedEdits).toEqual([{ dialogueId: '2', text: '  保留空白  ' }])
    expect(plan.changedEdits).toEqual([{ dialogueId: '1', text: '  改过的一句  ' }])
  })

  it('拒绝空修改、空白正文、不可编辑和缺失目标，且不返回部分计划', () => {
    expectCode(() => planDialogueTextEdits(snapshot(), []), ScenePreviewErrorCodes.emptyEditSet)
    expectCode(
      () => planDialogueTextEdits(snapshot(), [{ dialogueId: '1', text: '   ' }]),
      ScenePreviewErrorCodes.blankDialogueText
    )
    expectCode(
      () => planDialogueTextEdits(snapshot(), [{ dialogueId: '1', text: '' }]),
      ScenePreviewErrorCodes.blankDialogueText
    )
    expectCode(
      () =>
        planDialogueTextEdits(snapshot(), [
          { dialogueId: '1', text: '先改这句' },
          { dialogueId: '3', text: '不该写上' }
        ]),
      ScenePreviewErrorCodes.dialogueNotEditable
    )
    expectCode(
      () => planDialogueTextEdits(snapshot(), [{ dialogueId: '9', text: '没有这句' }]),
      ScenePreviewErrorCodes.dialogueTargetMissing
    )
  })

  it('先拒绝重复目标，再拒绝不存在的目标', () => {
    expectCode(
      () =>
        planDialogueTextEdits(snapshot(), [
          { dialogueId: '1', text: '一' },
          { dialogueId: '1', text: '二' }
        ]),
      ScenePreviewErrorCodes.duplicateEditDialogueId
    )
  })

  it('拒绝无效快照，不规划编辑', () => {
    expectCode(
      () =>
        planDialogueTextEdits({ scene: { projectId: '  ', sceneId: 'scene-1' }, dialogues: [] }, [
          { dialogueId: '1', text: '有字' }
        ]),
      ScenePreviewErrorCodes.invalidSceneIdentity
    )
    expectCode(
      () =>
        planDialogueTextEdits(
          snapshot([
            { dialogueId: '1', text: '甲', editable: true },
            { dialogueId: '1', text: '乙', editable: true }
          ]),
          [{ dialogueId: '1', text: '丙' }]
        ),
      ScenePreviewErrorCodes.duplicateDialogueId
    )
    const broken = snapshot([{ dialogueId: '1', text: 1 as unknown as string, editable: true }])
    expectCode(
      () => planDialogueTextEdits(broken, [{ dialogueId: '1', text: '有字' }]),
      ScenePreviewErrorCodes.invalidSnapshotEntry
    )
    const unmarked = snapshot([
      { dialogueId: '1', text: '甲', editable: 'yes' as unknown as boolean }
    ])
    expectCode(
      () => planDialogueTextEdits(unmarked, [{ dialogueId: '1', text: '乙' }]),
      ScenePreviewErrorCodes.invalidSnapshotEntry
    )
  })

  it('拒绝无效正文类型，不把空白判断用到非字符串上', () => {
    const edit = { dialogueId: '1', text: 1 } as unknown as DialogueTextEdit
    expectCode(
      () => planDialogueTextEdits(snapshot(), [edit]),
      ScenePreviewErrorCodes.invalidDialogueText
    )
  })
})
