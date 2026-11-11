import { describe, expect, it } from 'vitest'

import { nodesFromCards } from '@presentation/features/scene-canvas/sceneCanvasLayout'
import type {
  SessionCard,
  SessionPromptCard
} from '@presentation/features/workbench-session/workbenchSession.types'

function promptCard(): SessionPromptCard {
  return {
    kind: 'prompt',
    cardId: 'prompt',
    body: '正文',
    references: [],
    layout: { x: 10, y: 260, width: 480, height: 360 }
  }
}

describe('提示词节点布局', () => {
  it('把卡片高度写进节点尺寸和样式', () => {
    const [node] = nodesFromCards([promptCard()])
    expect(node?.width).toBe(480)
    expect(node?.height).toBe(360)
    expect(node?.style).toEqual({ width: 480, height: 360 })
  })

  it('非预览卡片继续随内容决定高度', () => {
    const document: SessionCard = {
      kind: 'document',
      cardId: 'doc',
      sourceId: 'source',
      title: '设定',
      summary: '',
      layout: { x: 0, y: 0, width: 300, height: 224 }
    }
    const [node] = nodesFromCards([document])
    expect(node?.height).toBeUndefined()
    expect(node?.style).toEqual({ width: 300 })
  })
})
