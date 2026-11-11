import { AppException } from '@common/errors/AppException'

import {
  ScenePreviewErrorCodes,
  scenePreviewErrorMessages,
  type ScenePreviewErrorCode
} from '../errors/ScenePreviewErrorCodes'
import type { DialogueEditPlan } from '../models/DialogueEditPlan'
import type { DialogueTextEdit } from '../models/DialogueTextEdit'
import type { SceneDialogueSnapshot } from '../models/SceneDialogueSnapshot'
import { validateSceneDialogueSnapshot } from './validateSceneDialogueSnapshot'

function fail(code: ScenePreviewErrorCode): never {
  throw new AppException({ code, msg: scenePreviewErrorMessages[code] })
}

/**
 * 规划已有台词的正文修改。
 * 空白只用于拒绝，不替换将要写入的正文；任一失败都不返回部分计划。
 */
export function planDialogueTextEdits(
  snapshot: SceneDialogueSnapshot,
  edits: readonly DialogueTextEdit[]
): DialogueEditPlan {
  validateSceneDialogueSnapshot(snapshot)
  if (!Array.isArray(edits) || edits.length === 0) fail(ScenePreviewErrorCodes.emptyEditSet)
  const seen = new Set<string>()
  for (const edit of edits) {
    if (typeof edit?.dialogueId !== 'string' || edit.dialogueId.trim() === '') {
      fail(ScenePreviewErrorCodes.blankDialogueId)
    }
    if (seen.has(edit.dialogueId)) fail(ScenePreviewErrorCodes.duplicateEditDialogueId)
    seen.add(edit.dialogueId)
  }
  const byId = new Map(snapshot.dialogues.map((dialogue) => [dialogue.dialogueId, dialogue]))
  const changedEdits: DialogueTextEdit[] = []
  const unchangedEdits: DialogueTextEdit[] = []
  for (const edit of edits) {
    const target = byId.get(edit.dialogueId)
    if (!target) fail(ScenePreviewErrorCodes.dialogueTargetMissing)
    if (!target.editable) fail(ScenePreviewErrorCodes.dialogueNotEditable)
    if (typeof edit.text !== 'string') fail(ScenePreviewErrorCodes.invalidDialogueText)
    if (edit.text.trim() === '') fail(ScenePreviewErrorCodes.blankDialogueText)
    const kept = { dialogueId: edit.dialogueId, text: edit.text }
    if (edit.text === target.text) unchangedEdits.push(kept)
    else changedEdits.push(kept)
  }
  return { scene: snapshot.scene, changedEdits, unchangedEdits }
}
