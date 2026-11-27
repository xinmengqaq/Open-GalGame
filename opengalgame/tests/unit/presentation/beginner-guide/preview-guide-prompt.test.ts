import { describe, expect, it } from 'vitest'

import { createGuideState } from '@presentation/features/beginner-guide/advanceGuide'
import { previewGuidePrompt } from '@presentation/features/beginner-guide/guidePrompt'
import { GUIDE_STEP_ID } from '@presentation/features/beginner-guide/guideSteps'

describe('预览里的教程文案', () => {
  it('第 7 步改为预览里实际能做的选中、修改和保存', () => {
    const state = createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue })
    const prompt = previewGuidePrompt(state)
    expect(prompt?.title).toBe('选一句，改成新台词')
    expect(prompt?.text).toContain('在左侧点一句对白')
    expect(prompt?.text).toContain('按铅笔或回车修改')
    expect(prompt?.text).toContain('点顶部「保存」')
    expect(prompt?.text).toContain('只读时先返回工作台处理')
    expect(prompt?.text).not.toContain('打开「试玩预览」')
  })

  it('已有草稿、保存失败或已保存时保留原提示，不覆盖', () => {
    const dirty = {
      ...createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue }),
      dialogueDraftDirty: true
    }
    expect(previewGuidePrompt(dirty)).toBeNull()

    const unresolved = {
      ...createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue }),
      dialogueSaveUnresolved: true
    }
    expect(previewGuidePrompt(unresolved)).toBeNull()

    const saved = {
      ...createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue }),
      milestoneIndex: 1,
      status: 'completed' as const
    }
    expect(previewGuidePrompt(saved)).toBeNull()
  })

  it('第 8 步在预览里先指向真实返回控件', () => {
    const state = createGuideState({ stepId: GUIDE_STEP_ID.exportBuild })
    const prompt = previewGuidePrompt(state)
    expect(prompt?.title).toBe('先回到工作台')
    expect(prompt?.text).toContain('点左上角「返回工作台」')
    expect(prompt?.milestoneId).toBe('export-return-preview')
  })

  it('其他步骤和折叠状态不伪造预览文案', () => {
    expect(previewGuidePrompt(createGuideState({ stepId: GUIDE_STEP_ID.playtestCandidate }))).toBeNull()
    const collapsed = {
      ...createGuideState({ stepId: GUIDE_STEP_ID.polishDialogue }),
      collapsed: true
    }
    expect(previewGuidePrompt(collapsed)?.hidden).toBe(true)
  })
})
