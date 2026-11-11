import SceneParser, { ADD_NEXT_ARG_LIST, SCRIPT_CONFIG, sceneTextPreProcess } from 'webgal-parser'

import type {
  ParsedScene,
  ParsedSceneAssetReference,
  ParsedSceneSentence,
  SceneCommandDeclaration,
  SceneScriptParseOptions
} from '@application/scenes/models/ParsedScene'
import type { SceneSourceSnapshot } from '@application/scenes/models/SceneSourceSnapshot'
import type { SceneScriptParserGateway } from '@application/scenes/ports/SceneScriptParserGateway'
import { runtimeAssetReference } from '@infrastructure/webgal/assetPath'
import { webgalBoolean } from '@infrastructure/webgal/compatibility/WebgalCommandArguments'
import {
  dialogueContentRange,
  rawSentenceContent,
  sourceLines,
  sourceRange
} from '@infrastructure/webgal/parser/sourceRanges'
import { sceneParseDiagnostics } from '@infrastructure/webgal/parser/sceneParseDiagnostics'
import { WebgalInfrastructureError } from '@infrastructure/webgal/WebgalInfrastructureError'
import { sceneReadException } from './sceneReadErrors'

type SdkSentence = ReturnType<SceneParser['parse']>['sentenceList'][number]

/** CJS 互操作可能把默认导出包进命名空间；本身已是构造器时保持原样。 */
export function resolveSceneParserConstructor(
  imported: typeof SceneParser | { default: typeof SceneParser }
): typeof SceneParser {
  return typeof imported === 'function' ? imported : imported.default
}

const SceneParserCtor = resolveSceneParserConstructor(SceneParser)

const resourceKindByCommand: Readonly<Record<string, string>> = {
  changeBg: 'background',
  unlockCg: 'background',
  changeFigure: 'figure',
  changeFigureDiff: 'figure',
  miniAvatar: 'figure',
  bgm: 'bgm',
  unlockBgm: 'bgm',
  playEffect: 'vocal',
  playVideo: 'video',
  callScene: 'scene',
  changeScene: 'scene'
}
const commandsByType = new Map(SCRIPT_CONFIG.map((item) => [item.scriptType, item.scriptString]))

/** 使用真实官方解析器，技术类型不越过应用端口。 */
export class SceneScriptParserGatewayImpl implements SceneScriptParserGateway {
  /**
   * 同时保留官方运行时结果和未改写资源路径的解析事实。
   * @throws {AppException} 快照内脚本不可用或解析器失败。
   */
  parseSceneScript(
    snapshot: SceneSourceSnapshot,
    relativePath = snapshot.entryFile.relativePath,
    options: readonly SceneCommandDeclaration[] | SceneScriptParseOptions = []
  ): ParsedScene {
    try {
      const sourceFile = snapshot.files.find(
        (file) => file.relativePath === relativePath && file.kind !== 'metadata'
      )
      if (!sourceFile || sourceFile.text === undefined) {
        throw new WebgalInfrastructureError(
          'missing-file',
          '本次快照不包含可解析的场景源文件',
          relativePath
        )
      }
      const parser = new SceneParserCtor(
        () => undefined,
        (name, type) => runtimeAssetReference(type, name),
        ADD_NEXT_ARG_LIST,
        SCRIPT_CONFIG
      )
      const rawParser = new SceneParserCtor(
        () => undefined,
        (name) => name,
        ADD_NEXT_ARG_LIST,
        SCRIPT_CONFIG
      )
      const runtime = parser.parse(sourceFile.text, relativePath, relativePath)
      const original = rawParser.parse(sourceFile.text, relativePath, relativePath)
      const lines = sourceLines(sourceFile.text)
      const processedLines = sceneTextPreProcess(sourceFile.text).split('\n')
      const sentences: ParsedSceneSentence[] = runtime.sentenceList.map((sentence, index) => {
        const rawSentence = original.sentenceList[index]!
        const range = sourceRange(lines, sentence.startLine, sentence.endLine)
        const rawContent = rawSentenceContent(
          sourceFile.text!.slice(range.startOffset, range.endOffset)
        )
        const command = commandsByType.get(sentence.command) ?? 'comment'
        return {
          sequence: index,
          engineSentenceIndex: index,
          command,
          commandRaw: sentence.commandRaw,
          content: sentence.content,
          rawContent,
          arguments: sentence.args.map((argument, argumentIndex) => ({
            key: argument.key,
            value: rawSentence.args[argumentIndex]!.value,
            originalValue: originalArgument(
              processedLines[index]!,
              argument.key,
              argumentIndex,
              sentence.args.length
            ),
            runtimeValue: argument.value
          })),
          inlineComment: sentence.inlineComment,
          sourceRange: range,
          contentRange:
            command === 'say' && !sentence.isLineBreakHolder
              ? dialogueContentRange(
                  sourceFile.text!.slice(range.startOffset, range.endOffset),
                  rawContent,
                  range
                )
              : undefined,
          continuationRange:
            sentence.endLine > sentence.startLine
              ? sourceRange(lines, sentence.startLine + 1, sentence.endLine)
              : undefined,
          isLineBreakHolder: sentence.isLineBreakHolder,
          assets: sentenceReferences(command, rawSentence, sentence, rawContent),
          subScenes: rawSentence.subScene
        }
      })
      return {
        sourceFile,
        contentDigest: snapshot.digest,
        sentences,
        assets: sentences.flatMap((sentence) => sentence.assets),
        subScenes: original.subSceneList,
        diagnostics: sceneParseDiagnostics(
          sourceFile.text,
          sentences,
          sceneParseOptions(options).commandDeclarations ?? [],
          sceneParseOptions(options).syntaxContract
        )
      }
    } catch (error) {
      if (error instanceof WebgalInfrastructureError) throw sceneReadException(error)
      throw sceneReadException(
        new WebgalInfrastructureError('parse-failed', '场景脚本解析失败', relativePath, {
          cause: error
        })
      )
    }
  }
}

/** 旧调用传命令声明数组；生成读取链传带来源的对象。 */
function sceneParseOptions(
  options: readonly SceneCommandDeclaration[] | SceneScriptParseOptions
): SceneScriptParseOptions {
  if (isCommandDeclarationList(options)) return { commandDeclarations: [...options] }
  return options
}

function isCommandDeclarationList(
  options: readonly SceneCommandDeclaration[] | SceneScriptParseOptions
): options is readonly SceneCommandDeclaration[] {
  return Array.isArray(options)
}

/** 记录资源内容和配音参数，包括官方资源列表遗漏的音效与清除状态。 */
function sentenceReferences(
  command: string,
  raw: SdkSentence,
  runtime: SdkSentence,
  rawContent: string
): readonly ParsedSceneAssetReference[] {
  const references: ParsedSceneAssetReference[] = []
  const kind = resourceKindByCommand[command]
  if (kind)
    references.push({
      kind,
      rawReference: raw.content || (rawContent.trim() === 'none' ? 'none' : ''),
      runtimeReference: runtime.content,
      line: raw.startLine,
      ...(raw.content === '' ||
      (command === 'changeFigure' &&
        isClearValue(raw.args.find((argument) => argument.key === 'clear')?.value))
        ? { isCleared: true }
        : {})
    })
  if (command === 'say') {
    raw.args.forEach((argument, index) => {
      if (argument.key === 'vocal' && typeof argument.value === 'string')
        references.push({
          kind: 'vocal',
          rawReference: argument.value,
          runtimeReference: String(runtime.args[index]!.value),
          line: raw.startLine
        })
    })
  }
  if (command === 'intro') {
    const value = raw.args.find((argument) => argument.key === 'backgroundImage')?.value
    if (value !== undefined && String(value) !== '') {
      const rawReference = String(value)
      references.push({
        kind: 'background',
        rawReference,
        runtimeReference: `game/background/${rawReference}`,
        line: raw.startLine
      })
    }
  }
  if (command === 'choose') {
    raw.subScene.forEach((reference, index) =>
      references.push({
        kind: 'scene',
        rawReference: reference,
        runtimeReference: runtime.subScene[index]!,
        line: raw.startLine
      })
    )
  }
  return references
}

/**
 * 按引擎布尔转换识别显式清除参数。
 * @returns 引擎会执行清除时为 true。
 */
function isClearValue(value: string | number | boolean | undefined): boolean {
  return webgalBoolean(value) === true
}

/**
 * 从官方预处理行标注参数的词面值，语义仍由官方解析器决定。
 * @returns 原文参数值；自动补充参数没有词面值。
 */
function originalArgument(
  processedLine: string,
  key: string,
  argumentIndex: number,
  argumentCount: number
): string | undefined {
  const beforeComment = processedLine.split(/(?<!\\);/u)[0]!
  const tokens = beforeComment
    .split(' -')
    .slice(1)
    .filter((token) => token !== '')
  const token = tokens[argumentIndex - (argumentCount - tokens.length)]
  if (token === undefined) return undefined
  const equal = token.indexOf('=')
  const name = (equal < 0 ? token : token.slice(0, equal)).trim()
  if (key === 'vocal' && name !== key) return token.trim()
  return equal < 0 ? undefined : token.slice(equal + 1).trim()
}
