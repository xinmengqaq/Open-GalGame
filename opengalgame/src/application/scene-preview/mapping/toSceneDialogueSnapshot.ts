import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'
import type { SceneDialogueSnapshot } from '@domain/scene-preview/models/SceneDialogueSnapshot'

import type { ScenePreviewDialogueFact } from '../models/ScenePreviewSourceFact'
import type { ScenePreviewLockState } from '../vo/ScenePreviewSessionVO'

export function toSceneDialogueSnapshot(
  scene: SceneIdentity,
  lockState: ScenePreviewLockState,
  dialogues: readonly ScenePreviewDialogueFact[]
): SceneDialogueSnapshot {
  return {
    scene,
    dialogues: dialogues.map((dialogue) => ({
      dialogueId: dialogue.dialogueId,
      text: dialogue.text,
      editable: lockState === 'editable' && dialogue.located
    }))
  }
}
