import { describe, expect, it } from 'vitest'

import { guideImportAttemptKey } from '@presentation/features/beginner-guide/guideMedia'

const BASE = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  canvasId: 'canvas-1',
  stepId: 'arrange-scene',
  stepAttempt: 2,
  arrangeKey: 'opening:place:opening:open'
} as const

describe('导入按钮的本次练习作用域', () => {
  it('同一工程、场景和本次练习得到同一键', () => {
    expect(guideImportAttemptKey({ ...BASE })).toBe(guideImportAttemptKey({ ...BASE }))
  })

  it('切换工程、场景或画布都会让旧导入结果失效', () => {
    const key = guideImportAttemptKey({ ...BASE })
    expect(guideImportAttemptKey({ ...BASE, projectId: 'project-2' })).not.toBe(key)
    expect(guideImportAttemptKey({ ...BASE, sceneId: 'scene-2' })).not.toBe(key)
    expect(guideImportAttemptKey({ ...BASE, canvasId: 'canvas-2' })).not.toBe(key)
  })

  it('跳回、重进步骤或转到下一拍都会让旧导入结果失效', () => {
    const key = guideImportAttemptKey({ ...BASE })
    expect(guideImportAttemptKey({ ...BASE, stepAttempt: 3 })).not.toBe(key)
    expect(guideImportAttemptKey({ ...BASE, stepId: 'save-and-generate' })).not.toBe(key)
    expect(
      guideImportAttemptKey({ ...BASE, arrangeKey: 'opening:usage:opening:open' })
    ).not.toBe(key)
  })
})
