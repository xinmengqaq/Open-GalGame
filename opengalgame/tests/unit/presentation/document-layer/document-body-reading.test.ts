import { describe, expect, it } from 'vitest'

import { documentBodyDisplayable } from '@presentation/features/document-layer/useDocumentLayer'

describe('文档阅读事实的正文条件', () => {
  it('加载中、失败与空正文都不算可显示正文', () => {
    expect(documentBodyDisplayable({ status: 'loading', body: '' })).toBe(false)
    expect(documentBodyDisplayable({ status: 'failed', body: '' })).toBe(false)
    expect(documentBodyDisplayable({ status: 'empty', body: '' })).toBe(false)
    expect(documentBodyDisplayable({ status: 'ready', body: ' \n\t ' })).toBe(false)
  })

  it('缓存或异步读取完成且正文非空才算可显示正文', () => {
    expect(documentBodyDisplayable({ status: 'ready', body: '第一句台词' })).toBe(true)
  })
})
