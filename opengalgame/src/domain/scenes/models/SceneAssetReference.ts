export type SceneAssetPurpose =
  'background' | 'cg' | 'characterImage' | 'avatar' | 'music' | 'soundEffect' | 'voice' | 'video'

export type SceneAssetCategory = 'image' | 'audio' | 'video'

export function assetCategoryOfPurpose(purpose: SceneAssetPurpose): SceneAssetCategory {
  if (purpose === 'video') return 'video'
  if (purpose === 'music' || purpose === 'soundEffect' || purpose === 'voice') return 'audio'
  return 'image'
}

export interface SceneAssetReference {
  readonly assetId: string
  readonly category: SceneAssetCategory
}
