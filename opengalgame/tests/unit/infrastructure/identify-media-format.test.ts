import { describe, expect, it } from 'vitest'

import {
  classifyMediaFileName,
  mediaExtensionsForCategories
} from '@common/media/mediaFileName'
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

  it('按最后一个后缀做大小写无关初筛，共用容器不猜轨道', () => {
    expect(classifyMediaFileName('场景.PNG')).toEqual({
      status: 'identified',
      category: 'image'
    })
    expect(classifyMediaFileName('声音.WaV')).toEqual({
      status: 'identified',
      category: 'audio'
    })
    expect(classifyMediaFileName('片段.OGG')).toEqual({ status: 'container' })
    expect(classifyMediaFileName('片段.Mp4')).toEqual({ status: 'container' })
    expect(classifyMediaFileName('说明.xyz')).toEqual({ status: 'unknown' })
    expect(classifyMediaFileName('无后缀')).toEqual({ status: 'unknown' })
    expect(classifyMediaFileName('archive.tar.gz')).toEqual({ status: 'unknown' })
    expect(classifyMediaFileName('结尾.')).toEqual({ status: 'unknown' })
  })

  it('过滤扩展名包含共用容器，但内容识别仍拒绝伪装格式', async () => {
    expect(mediaExtensionsForCategories(['image'])).toEqual([
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'svg'
    ])
    expect(mediaExtensionsForCategories(['audio'])).toEqual([
      'mp3',
      'flac',
      'wav',
      'ogg',
      'mp4',
      'webm'
    ])
    expect(mediaExtensionsForCategories(['video'])).toEqual(['ogg', 'mp4', 'webm'])
    expect(mediaExtensionsForCategories(['audio', 'video'])).toEqual([
      'mp3',
      'flac',
      'wav',
      'ogg',
      'mp4',
      'webm'
    ])
    await expect(identifyMediaFormat(Buffer.from('不是音频', 'utf8'))).resolves.toEqual({
      supported: false,
      reason: 'unsupported'
    })
  })
})
