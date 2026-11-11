import { describe, expect, it } from 'vitest'

import {
  DOCUMENT_BODY_MAX_CHARS,
  documentSaveDraft,
  documentsEditable
} from '@presentation/features/document-layer/documentBodyDraft'

describe('文档正文可编辑判定', () => {
  it('Markdown 文档可编辑', () => {
    expect(documentsEditable({ contentKind: 'text', importFormat: 'markdown' })).toBe(true)
  })

  it('纯文本文档保持只读', () => {
    expect(documentsEditable({ contentKind: 'text', importFormat: 'plainText' })).toBe(false)
  })

  it('非文本文档保持只读', () => {
    expect(documentsEditable({ contentKind: 'image', importFormat: 'markdown' })).toBe(false)
  })

  it('缺少格式或未知格式保持只读', () => {
    expect(documentsEditable({ contentKind: 'text' })).toBe(false)
    expect(documentsEditable({ contentKind: 'text', importFormat: 'html' })).toBe(false)
  })
})

describe('文档正文保存草稿', () => {
  const expectedVersion = 'source-version-1'

  it('空正文允许保存', () => {
    expect(documentSaveDraft({ body: '', expectedVersion })).toEqual({ ok: true, body: '' })
  })

  it('长度等于上限允许保存', () => {
    const body = 'a'.repeat(DOCUMENT_BODY_MAX_CHARS)
    expect(documentSaveDraft({ body, expectedVersion })).toEqual({ ok: true, body })
  })

  it('长度超过上限拒绝保存', () => {
    const body = 'a'.repeat(DOCUMENT_BODY_MAX_CHARS + 1)
    expect(documentSaveDraft({ body, expectedVersion })).toEqual({
      ok: false,
      reason: 'too-long'
    })
  })

  it('自定义长度上限生效', () => {
    expect(documentSaveDraft({ body: 'abc', expectedVersion, maxChars: 2 })).toEqual({
      ok: false,
      reason: 'too-long'
    })
  })

  it('缺少来源版本拒绝保存', () => {
    expect(documentSaveDraft({ body: '正文', expectedVersion: null })).toEqual({
      ok: false,
      reason: 'missing-version'
    })
    expect(documentSaveDraft({ body: '正文' })).toEqual({
      ok: false,
      reason: 'missing-version'
    })
  })

  it('空白来源版本拒绝保存', () => {
    expect(documentSaveDraft({ body: '正文', expectedVersion: '   ' })).toEqual({
      ok: false,
      reason: 'missing-version'
    })
  })

  it('正文含未上传图片地址拒绝保存', () => {
    expect(documentSaveDraft({ body: '![图](draft:image-1)', expectedVersion })).toEqual({
      ok: false,
      reason: 'unsupported-image'
    })
    expect(documentSaveDraft({ body: '![图](blob:https://local/image)', expectedVersion })).toEqual(
      { ok: false, reason: 'unsupported-image' }
    )
  })

  it('正文原样返回，不做 trim', () => {
    expect(documentSaveDraft({ body: '  正文  ', expectedVersion })).toEqual({
      ok: true,
      body: '  正文  '
    })
  })
})
