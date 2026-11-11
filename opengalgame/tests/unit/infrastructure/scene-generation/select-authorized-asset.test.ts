import { expect, it } from 'vitest'

import type { SceneGenerationInputsDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import { selectAuthorizedAsset } from '@infrastructure/scene-generation/artifacts/WebGalSceneArtifactGatewayImpl'

const path = 'assets/figure/hero.png'
const reference = { kind: 'figure', rawReference: 'hero.png', relativePath: path }

it('同一文件的图片和音频按类别匹配，立绘命令取图片、音乐命令取音频', () => {
  const assets = [asset('figure-card', 'image'), asset('music-card', 'audio')]
  expect(selectAuthorizedAsset(assets, reference, 'changeFigure')?.assetId).toBe('figure-card')
  expect(selectAuthorizedAsset(assets, reference, 'bgm')?.assetId).toBe('music-card')
})

it('同类别有多张时取第一张，不再按角色用途精确区分', () => {
  const assets = [asset('figure-card', 'image'), asset('avatar-card', 'image')]
  expect(selectAuthorizedAsset(assets, reference, 'miniAvatar')?.assetId).toBe('figure-card')
  expect(selectAuthorizedAsset(assets, reference, 'changeFigure')?.assetId).toBe('figure-card')
})

it('同文件只有图片卡时，立绘命令仍取该卡', () => {
  const assets = [asset('background-card', 'image', 'game/figure/hero.png')]
  expect(
    selectAuthorizedAsset(
      assets,
      { kind: 'figure', rawReference: 'hero.png', relativePath: 'game/figure/hero.png' },
      'changeFigure'
    )?.assetId
  ).toBe('background-card')
})

it('音频卡不会被图片命令选中', () => {
  const assets = [asset('voice-card', 'audio'), asset('music-card', 'audio')]
  expect(selectAuthorizedAsset(assets, reference, 'changeFigure')).toBeUndefined()
})

function asset(
  assetId: string,
  category: SceneGenerationInputsDTO['assets'][number]['category'],
  relativePath = path
): SceneGenerationInputsDTO['assets'][number] {
  return {
    assetId,
    sourceId: 'hero',
    name: '立绘',
    relativePath,
    category,
    description: '',
    usage: { targetIds: [] }
  }
}
