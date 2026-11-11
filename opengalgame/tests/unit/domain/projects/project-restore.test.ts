import { expect, it } from 'vitest'

import { Project } from '@domain/projects/models/Project'

it('仓储恢复项目不产生创建或导入事件', () => {
  const project = Project.restore({ id: 'saved', name: '已保存', synopsis: '原文' })
  expect(project.events).toEqual([])
  expect(project.name).toBe('已保存')
})
