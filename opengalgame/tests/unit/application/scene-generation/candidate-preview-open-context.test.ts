import { describe, expect, it } from 'vitest'

import { candidatePreviewOpenContext } from '@application/scene-generation/ports/SceneCandidatePreviewGateway'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const source = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  projectRoot: 'D:/works/story'
}

describe('candidatePreviewOpenContext', () => {
  it('用场景目录和入口文件名组成相对入口，不重复前置目录', () => {
    expect(
      candidatePreviewOpenContext({
        ...source,
        sceneDirectory: 'game/scene',
        entryFile: 'start.txt'
      })
    ).toEqual({ entryFile: 'game/scene/start.txt', sceneName: 'start' })

    expect(
      candidatePreviewOpenContext({
        ...source,
        sceneDirectory: 'game/scene',
        entryFile: 'game/scene/start.txt'
      }).entryFile
    ).toBe('game/scene/start.txt')
  })

  it('入口无法形成场景名时拒绝', () => {
    expect(() =>
      candidatePreviewOpenContext({
        ...source,
        sceneDirectory: '',
        entryFile: '   '
      })
    ).toThrow(expect.objectContaining({ code: ErrorCodes.invalidRequest }))
  })
})
