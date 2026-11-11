import { describe, expect, it } from 'vitest'

import { toSceneDialogueSnapshot } from '@application/scene-preview/mapping/toSceneDialogueSnapshot'

const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const dialogues = [
  { dialogueId: '1', text: '  原样  ', located: true },
  { dialogueId: '2', text: '定位不了', located: false }
]

describe('toSceneDialogueSnapshot', () => {
  it('只有锁定为可编辑且能定位的台词可改，正文不做裁剪', () => {
    expect(toSceneDialogueSnapshot(scene, 'editable', dialogues)).toEqual({
      scene,
      dialogues: [
        { dialogueId: '1', text: '  原样  ', editable: true },
        { dialogueId: '2', text: '定位不了', editable: false }
      ]
    })
    expect(
      toSceneDialogueSnapshot(scene, 'unknown', dialogues).dialogues.every((item) => !item.editable)
    ).toBe(true)
    expect(
      toSceneDialogueSnapshot(scene, 'locked', dialogues).dialogues.every((item) => !item.editable)
    ).toBe(true)
  })
})
