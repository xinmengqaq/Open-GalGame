import { describe, expect, it } from 'vitest'

import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import {
  inputCatalogMediaAvailabilityOf,
  inputCatalogMediaKindOf,
  UNKNOWN_INPUT_CATALOG_MEDIA_AVAILABILITY
} from '@presentation/features/input-catalog/inputCatalogMediaAvailability'

function source(
  sourceId: string,
  contentKind: ProjectInputSourceSummaryVO['contentKind'],
  name: string,
  readable = true
): ProjectInputSourceSummaryVO {
  if (contentKind === 'text') {
    return {
      sourceId,
      name,
      readable,
      parentFolderId: null,
      contentKind: 'text',
      textKind: 'document'
    }
  }
  return { sourceId, name, readable, parentFolderId: null, contentKind }
}

describe('文件区选材可用性', () => {
  it('目录未读定时三类都是未知，读定后按真实来源计数', () => {
    expect(inputCatalogMediaAvailabilityOf(null, [])).toEqual(
      UNKNOWN_INPUT_CATALOG_MEDIA_AVAILABILITY
    )
    expect(inputCatalogMediaAvailabilityOf('idle', [source('img', 'image', '屋顶.png')])).toEqual({
      image: null,
      audio: null,
      video: null
    })
    expect(inputCatalogMediaAvailabilityOf('loading', [])).toEqual({
      image: null,
      audio: null,
      video: null
    })
    expect(inputCatalogMediaAvailabilityOf('failed', [])).toEqual({
      image: null,
      audio: null,
      video: null
    })
    expect(inputCatalogMediaAvailabilityOf('empty', [])).toEqual({
      image: false,
      audio: false,
      video: false
    })
  })

  it('必须同时可读取、末位后缀是候选、内容识别确认类别一致', () => {
    const availability = inputCatalogMediaAvailabilityOf('ready', [
      source('img', 'image', '屋顶.PNG'),
      source('audio', 'audio', '脚步声.WaV'),
      source('text', 'text', '剧本.md')
    ])
    expect(availability).toEqual({ image: true, audio: true, video: false })

    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('img', 'image', '屋顶.png', false)])
    ).toEqual({ image: false, audio: false, video: false })

    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('img', 'image', '屋顶.xyz')])
    ).toEqual({ image: false, audio: false, video: false })

    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('img', 'image', '无后缀')])
    ).toEqual({ image: false, audio: false, video: false })
  })

  it('末位后缀与确认类别不一致时不算已有', () => {
    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('mismatch', 'audio', '封面.png')])
    ).toEqual({ image: false, audio: false, video: false })
    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('mismatch', 'image', '声音.mp3')])
    ).toEqual({ image: false, audio: false, video: false })
  })

  it('共用容器按内容识别的真实类别归类，不按后缀猜轨道', () => {
    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('ogg-audio', 'audio', '效果.OGG')])
    ).toEqual({ image: false, audio: true, video: false })

    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('mp4-video', 'video', '片段.Mp4')])
    ).toEqual({ image: false, audio: false, video: true })

    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('webm-audio', 'audio', '环境.webm')])
    ).toEqual({ image: false, audio: true, video: false })
  })

  it('只看最后一个后缀，更早的扩展名不参与判断', () => {
    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('multi', 'image', '镜头.final.PNG')])
    ).toEqual({ image: true, audio: false, video: false })
    expect(
      inputCatalogMediaAvailabilityOf('ready', [source('archive', 'image', '画面.tar.gz')])
    ).toEqual({ image: false, audio: false, video: false })
  })

  it('目录可用性与导入回执共用同一个候选类别判定', () => {
    expect(inputCatalogMediaKindOf(source('ok', 'image', '屋顶.PNG'))).toBe('image')
    expect(inputCatalogMediaKindOf(source('xyz', 'image', '画面.xyz'))).toBeNull()
    expect(inputCatalogMediaKindOf(source('container', 'video', '片段.webm'))).toBe('video')
    expect(inputCatalogMediaKindOf(source('image-container', 'image', '画面.ogg'))).toBeNull()
    expect(inputCatalogMediaKindOf(source('hidden', 'audio', '声音.wav', false))).toBeNull()
  })
})
