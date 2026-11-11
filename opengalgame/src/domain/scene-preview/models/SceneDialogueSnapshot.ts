import type { SceneIdentity } from '../../scenes/models/SceneIdentity'

export type EditableDialogueSnapshot = {
  readonly dialogueId: string
  readonly text: string
  readonly editable: boolean
}

export type SceneDialogueSnapshot = {
  readonly scene: SceneIdentity
  readonly dialogues: readonly EditableDialogueSnapshot[]
}
