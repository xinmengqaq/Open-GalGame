import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { ParsedScene } from '@application/scenes/models/ParsedScene'
import type {
  SceneSourceFile,
  SceneSourceSnapshot
} from '@application/scenes/models/SceneSourceSnapshot'
import {
  createWebgalSceneLocation,
  isWebgalSceneLocationCurrent
} from '@infrastructure/webgal/source/WebgalSceneLocator'

function sourceFile(text: string): SceneSourceFile {
  return {
    relativePath: 'game/start.txt',
    kind: 'entry',
    bytes: new TextEncoder().encode(text),
    text,
    size: text.length,
    modifiedAtMs: 0,
    digest: createHash('sha256').update(text).digest('hex')
  }
}

function scene(file: SceneSourceFile): ParsedScene {
  return {
    sourceFile: file,
    contentDigest: file.digest,
    assets: [],
    subScenes: [],
    diagnostics: [],
    sentences: [
      {
        sequence: 0,
        command: 'say',
        commandRaw: '旁白',
        content: '第一句',
        rawContent: '第一句',
        arguments: [],
        inlineComment: '',
        sourceRange: {
          startOffset: 0,
          endOffset: 7,
          startLine: 0,
          startColumn: 0,
          endLine: 0,
          endColumn: 7
        },
        engineSentenceIndex: 0,
        isLineBreakHolder: false,
        assets: [],
        subScenes: []
      }
    ]
  }
}

function snapshot(file: SceneSourceFile): SceneSourceSnapshot {
  return {
    projectRoot: 'test',
    entryFile: file,
    files: [file],
    missingMetadataFiles: [],
    digest: file.digest
  }
}

describe('WebGAL 源定位绑定', () => {
  it('把内容摘要、解析器版本和引擎语句位置绑定，内容变化后失效', () => {
    const original = sourceFile('旁白:第一句;')
    const location = createWebgalSceneLocation(scene(original), 0)

    expect(location.engineSentenceIndex).toBe(0)
    expect(isWebgalSceneLocationCurrent(location, snapshot(original))).toBe(true)
    expect(isWebgalSceneLocationCurrent(location, snapshot(sourceFile('旁白:第二句;')))).toBe(false)
  })

  it('引擎版本变化后使旧定位失效', () => {
    const original = sourceFile('旁白:第一句;')
    const location = createWebgalSceneLocation(scene(original), 0)
    const incompatibleLocation = {
      ...location,
      engineVersion: 'different-engine-version'
    }

    expect(isWebgalSceneLocationCurrent(incompatibleLocation, snapshot(original))).toBe(false)
  })
})
