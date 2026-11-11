import type { SceneSourceFile } from '@application/scenes/models/SceneSourceSnapshot'

export type SceneCommand = string
export type SceneArgumentValue = string | number | boolean

export type ParsedSceneArgument = {
  readonly key: string
  readonly value: SceneArgumentValue
  readonly originalValue?: string
  readonly runtimeValue?: SceneArgumentValue
}

export type SceneSourceRange = {
  readonly startOffset: number
  readonly endOffset: number
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

export type ParsedSceneAssetReference = {
  readonly rawReference: string
  readonly runtimeReference: string
  readonly kind: string
  readonly line: number
  readonly isCleared?: boolean
}

export type ParsedSceneSentence = {
  readonly sequence: number
  readonly command: SceneCommand
  readonly commandRaw: string
  readonly content: string
  readonly rawContent: string
  readonly arguments: readonly ParsedSceneArgument[]
  readonly inlineComment: string
  readonly sourceRange: SceneSourceRange
  /**
   * 原文中可唯一替换的正文范围。
   * 多行续写、结构不唯一或正文被转义改写时省略，不能用整句范围代替。
   */
  readonly contentRange?: SceneSourceRange
  readonly continuationRange?: SceneSourceRange
  readonly engineSentenceIndex: number
  readonly isLineBreakHolder: boolean
  readonly assets: readonly ParsedSceneAssetReference[]
  readonly subScenes: readonly string[]
}

export type SceneParseDiagnosticKind =
  'unknown-command' | 'unsupported-command' | 'invalid-argument' | 'unsupported-dialogue'

/**
 * 生成候选的封闭语法来源。
 * 只由生成读取链设置，不能从脚本正文或模型声明推断。
 */
export type SceneSyntaxContract = 'generated-candidate'

export type SceneScriptParseOptions = {
  readonly commandDeclarations?: readonly SceneCommandDeclaration[]
  readonly syntaxContract?: SceneSyntaxContract
}

export type SceneParseDiagnostic = {
  readonly kind: SceneParseDiagnosticKind
  readonly message: string
  readonly range?: SceneSourceRange
  readonly rawText?: string
}

export type ParsedScene = {
  readonly sourceFile: SceneSourceFile
  readonly contentDigest: string
  readonly sentences: readonly ParsedSceneSentence[]
  readonly assets: readonly ParsedSceneAssetReference[]
  readonly subScenes: readonly string[]
  readonly diagnostics: readonly SceneParseDiagnostic[]
}

export type SceneCommandDeclaration = {
  readonly line: number
  readonly command: string
}
