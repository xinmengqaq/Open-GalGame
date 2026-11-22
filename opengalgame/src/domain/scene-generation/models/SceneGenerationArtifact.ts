import type { SceneAssetCategory } from '../../scenes/models/SceneAssetReference'
import type { SceneIdentity } from '../../scenes/models/SceneIdentity'

export type SceneReferenceOutcome =
  'matched' | 'missing' | 'external' | 'invalid-path' | 'cleared' | 'unauthorized'

export type SceneCommandRecognition = 'recognized' | 'unknown'

export type SceneArgumentRecognition = 'recognized' | 'invalid'

export type SceneSyntaxContract = 'generated-candidate'

export type SceneSyntaxContractIssue = 'unknown-command' | 'unsupported-dialogue'

export type SceneDialogueSpeaker =
  'implicit' | 'inherited' | 'cleared' | 'explicit' | 'numeric-zero'

export interface SceneAssetUse {
  readonly category: SceneAssetCategory
  readonly outcome: SceneReferenceOutcome
  readonly assetId?: string
  readonly reference?: string
  readonly line?: number
}

export interface SceneGenerationStatement {
  readonly sequence: number
  readonly command: string
  readonly commandRecognition: SceneCommandRecognition
  readonly argumentRecognition: SceneArgumentRecognition
  readonly content: string
  readonly assetUses: readonly SceneAssetUse[]
  readonly dialogueSpeaker?: SceneDialogueSpeaker
  readonly syntaxContract?: SceneSyntaxContract
  readonly contractIssue?: SceneSyntaxContractIssue
  readonly contractMessage?: string
  readonly automaticAdvance?: boolean
  readonly waitsForPlayer?: boolean
  readonly skipped?: boolean
  readonly jumpTarget?: number
}

export interface SceneGenerationArtifact {
  readonly scene: SceneIdentity
  readonly hasEntry: boolean
  readonly statements: readonly SceneGenerationStatement[]
}
