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
  /** 解析出的原始素材引用；只由生成读取链填充，旧构造可缺省。 */
  readonly reference?: string
  /** 原始引用所在入口文件行号（1 起）；只由生成读取链填充，旧构造可缺省。 */
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
  /** 仅生成读取链标记。缺省表示外来或历史兼容语句。 */
  readonly syntaxContract?: SceneSyntaxContract
  /** 生成契约下已确认的语法问题；不由命令名猜测。 */
  readonly contractIssue?: SceneSyntaxContractIssue
  /** 生成契约给出的安全修正说明。页面只消费固定码，不转发原文。 */
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
