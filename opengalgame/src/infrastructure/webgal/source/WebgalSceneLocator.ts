import {
  installedPackageVersion,
  WEBGAL_COMPATIBILITY_PROFILE
} from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import type { ParsedScene, ParsedSceneSentence } from '@application/scenes/models/ParsedScene'
import type { SceneSourceSnapshot } from '@application/scenes/models/SceneSourceSnapshot'
import type { SceneSentenceLocation } from '@application/scenes/models/SceneSentenceLocation'

/**
 * @throws 语句不属于当前解析结果时抛出错误。
 */
export function createWebgalSceneLocation(
  scene: ParsedScene,
  sentenceSequence: number
): SceneSentenceLocation {
  const sentence = scene.sentences.find((item) => item.sequence === sentenceSequence)
  if (!sentence) throw new Error(`找不到 WebGAL 语句：${sentenceSequence}`)
  return createLocation(scene, sentence)
}

/**
 * 检查定位是否仍对应当前源文件和已安装的解析器、引擎版本。
 * @returns 定位仍然有效时为 true。
 */
export function isWebgalSceneLocationCurrent(
  location: SceneSentenceLocation,
  snapshot: SceneSourceSnapshot
): boolean {
  if (
    !snapshot.files.some((file) => file.relativePath === location.sourceFile) ||
    location.contentDigest !== snapshot.digest
  )
    return false
  if (
    location.parserVersion !== installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.parserPackage)
  )
    return false
  return (
    location.engineVersion === installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.enginePackage)
  )
}

/** 把源文件与解析语句绑定成定位，并记录当时的解析器与引擎版本，供日后判断失效。 */
function createLocation(scene: ParsedScene, sentence: ParsedSceneSentence): SceneSentenceLocation {
  const location = {
    sourceFile: scene.sourceFile.relativePath,
    contentDigest: scene.contentDigest,
    parserVersion: installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.parserPackage),
    engineVersion: installedPackageVersion(WEBGAL_COMPATIBILITY_PROFILE.enginePackage),
    sentenceSequence: sentence.sequence,
    engineSentenceIndex: sentence.engineSentenceIndex,
    sourceRange: sentence.sourceRange
  }
  return location
}
