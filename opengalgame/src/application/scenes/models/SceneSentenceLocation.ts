import type { SceneSourceRange } from './ParsedScene'

export type SceneSentenceLocation = {
  readonly sourceFile: string
  readonly contentDigest: string
  readonly parserVersion: string
  readonly engineVersion: string
  readonly sentenceSequence: number
  readonly engineSentenceIndex: number
  readonly sourceRange: SceneSourceRange
}
