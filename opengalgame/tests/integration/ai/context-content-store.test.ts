import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FileContextContentStore } from '@infrastructure/ai/context/FileContextContentStore'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('外置内容', () => {
  it('按引用读回全文和范围，版本不符或越界引用失败', async () => {
    const root = await createRoot()
    const store = new FileContextContentStore(root)
    const text = `开头${'文'.repeat(100)}结尾`
    const reference = await store.put(text)

    expect(reference.truncated).toBe(true)
    expect(reference.summary.endsWith('…')).toBe(true)
    expect(reference.summary).not.toBe(text)
    const full = await store.read({ id: reference.id, version: reference.version })
    expect(full).toMatchObject({ content: text, complete: true, truncated: false })
    const range = await store.read({
      id: reference.id,
      version: reference.version,
      start: 2,
      maxChars: 2
    })
    expect(range).toMatchObject({ content: '文文', complete: false, truncated: true })
    expect(range.charLength).toBeUndefined()
    const longText = '字'.repeat(1000)
    const longReference = await store.put(longText)
    const head = await store.read({
      id: longReference.id,
      version: longReference.version,
      start: 0,
      maxChars: 10
    })
    expect(head.content).toBe('字'.repeat(10))
    expect(head.charLength).toBeUndefined()
    expect(head.end).toBe(10)
    const entire = await store.read({ id: longReference.id, version: longReference.version })
    expect(entire.charLength).toBe(1000)
    await expect(store.read({ id: reference.id, version: 'a'.repeat(64) })).rejects.toThrow(
      '外置内容版本不存在'
    )
    await expect(store.read({ id: '../outside', version: reference.version })).rejects.toThrow(
      '外置内容引用无效'
    )
    const stored = await readFile(join(root, reference.id, `${reference.version}.txt`), 'utf8')
    expect(stored).toBe(text)
  })

  it('不能通过引用读到存储根之外的文件', async () => {
    const root = await createRoot()
    const outside = await createRoot()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const store = new FileContextContentStore(root)

    await expect(store.read({ id: `../../${outside}`, version: 'b'.repeat(64) })).rejects.toThrow(
      '外置内容引用无效'
    )
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'context-'))
  roots.push(root)
  return root
}
