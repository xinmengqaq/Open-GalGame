import { AppException } from '@common/errors/AppException'

import {
  ScenePreviewErrorCodes,
  scenePreviewErrorMessages,
  type ScenePreviewErrorCode
} from '../errors/ScenePreviewErrorCodes'
import type { SceneDialogueSnapshot } from '../models/SceneDialogueSnapshot'

function fail(code: ScenePreviewErrorCode): never {
  throw new AppException({ code, msg: scenePreviewErrorMessages[code] })
}

export function validateSceneDialogueSnapshot(snapshot: SceneDialogueSnapshot): void {
  const projectId = snapshot?.scene?.projectId
  const sceneId = snapshot?.scene?.sceneId
  if (
    typeof projectId !== 'string' ||
    projectId.trim() === '' ||
    typeof sceneId !== 'string' ||
    sceneId.trim() === ''
  ) {
    fail(ScenePreviewErrorCodes.invalidSceneIdentity)
  }
  if (!Array.isArray(snapshot.dialogues)) fail(ScenePreviewErrorCodes.invalidSnapshotEntry)
  const seen = new Set<string>()
  for (const dialogue of snapshot.dialogues) {
    if (typeof dialogue?.dialogueId !== 'string' || dialogue.dialogueId.trim() === '') {
      fail(ScenePreviewErrorCodes.invalidSnapshotEntry)
    }
    if (seen.has(dialogue.dialogueId)) fail(ScenePreviewErrorCodes.duplicateDialogueId)
    seen.add(dialogue.dialogueId)
    if (typeof dialogue.text !== 'string' || typeof dialogue.editable !== 'boolean') {
      fail(ScenePreviewErrorCodes.invalidSnapshotEntry)
    }
  }
}
