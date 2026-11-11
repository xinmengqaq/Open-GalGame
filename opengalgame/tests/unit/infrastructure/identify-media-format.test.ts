import { describe, expect, it } from 'vitest'

import {
  identifyMediaFormat,
  mediaFormatMatchesFileType
} from '@infrastructure/media/identifyMediaFormat'

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000000020001e221bc330000000049454e44ae426082',
  'hex'
)

describe('identifyMediaFormat', () => {
  it('识别 PNG 和带命名空间的 SVG，并拒绝用途不匹配', async () => {
    await expect(identifyMediaFormat(PNG)).resolves.toMatchObject({
      supported: true,
      category: 'image',
      extension: 'png'
    })
    await expect(
      identifyMediaFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8'))
    ).resolves.toMatchObject({ supported: true, category: 'image', extension: 'svg' })
    await expect(identifyMediaFormat(Buffer.from('<svg></svg>', 'utf8'))).resolves.toMatchObject({
      supported: false
    })
    const png = await identifyMediaFormat(PNG)
    expect(mediaFormatMatchesFileType('image', png)).toBe(true)
    expect(mediaFormatMatchesFileType('audio', png)).toBe(false)
  })

  it('接受前缀绑定的 SVG 命名空间，拒绝布尔属性非法 XML', async () => {
    await expect(
      identifyMediaFormat(Buffer.from('<s:svg xmlns:s="http://www.w3.org/2000/svg"/>', 'utf8'))
    ).resolves.toMatchObject({ supported: true, category: 'image', extension: 'svg' })
    await expect(
      identifyMediaFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" disabled/>', 'utf8'))
    ).resolves.toMatchObject({ supported: false })
  })
})
