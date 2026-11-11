import type {
  ParsedSceneSentence,
  SceneCommandDeclaration,
  SceneParseDiagnostic,
  SceneSyntaxContract
} from '@application/scenes/models/ParsedScene'
import { parserRecognizedCommands } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import {
  WEBGAL_COMMAND_ARGUMENTS,
  WEBGAL_COMMON_ARGUMENTS,
  WEBGAL_UNSUPPORTED_COMMANDS,
  isWebgalArgumentValueSupported
} from '@infrastructure/webgal/compatibility/WebgalCommandArguments'

/**
 * 依据命令声明和已核对参数诊断；callScene 的任意局部参数不受名单限制。
 * 生成契约只在调用方明确传入时生效，不根据前缀猜测外来作品。
 * @param declarations - 调用方可靠的命令声明。
 * @param syntaxContract - 仅生成候选读取设置的封闭语法来源。
 * @returns 保留原文范围的诊断。
 */
export function sceneParseDiagnostics(
  text: string,
  sentences: readonly ParsedSceneSentence[],
  declarations: readonly SceneCommandDeclaration[],
  syntaxContract?: SceneSyntaxContract
): readonly SceneParseDiagnostic[] {
  const diagnostics: SceneParseDiagnostic[] = []
  const recognized = parserRecognizedCommands()
  for (const sentence of sentences) {
    if (sentence.isLineBreakHolder || sentence.command === 'comment') continue
    const range = sentence.sourceRange
    const rawText = text.slice(range.startOffset, range.endOffset)
    const declared = declarations.find(
      (item) => item.line === range.startLine && item.command === sentence.commandRaw
    )
    if (declared && !recognized.includes(declared.command))
      diagnostics.push({
        kind: 'unknown-command',
        message: '声明的 WebGAL 命令不受当前解析器支持',
        range,
        rawText
      })
    if (syntaxContract === 'generated-candidate') {
      diagnostics.push(...generationContractDiagnostics(sentence, range, rawText, recognized))
    }
    if ((WEBGAL_UNSUPPORTED_COMMANDS as readonly string[]).includes(sentence.command)) {
      diagnostics.push({
        kind: 'unsupported-command',
        message: '解析器保留此命令，但当前固定引擎未注册其执行实现',
        range,
        rawText
      })
    }
    const supported = WEBGAL_COMMAND_ARGUMENTS[sentence.command]
    if (!supported) continue
    for (const argument of sentence.arguments) {
      const kind = Object.hasOwn(supported, argument.key)
        ? supported[argument.key]
        : Object.hasOwn(WEBGAL_COMMON_ARGUMENTS, argument.key)
          ? WEBGAL_COMMON_ARGUMENTS[argument.key]
          : undefined
      if (kind && isWebgalArgumentValueSupported(argument.value, kind)) continue
      diagnostics.push({
        kind: 'invalid-argument',
        message: kind
          ? `参数 ${argument.key} 的值不受当前引擎支持`
          : `当前命令不支持参数 ${argument.key}`,
        range,
        rawText
      })
    }
  }
  return diagnostics
}

/**
 * 新生成候选必须使用固定解析器命令和显式对白。
 * 解析器把未知前缀回退成 say 时，这里仍按原文前缀报告未知命令，不改写语句。
 */
function generationContractDiagnostics(
  sentence: ParsedSceneSentence,
  range: ParsedSceneSentence['sourceRange'],
  rawText: string,
  recognized: readonly string[]
): SceneParseDiagnostic[] {
  if (sentence.isLineBreakHolder || sentence.command === 'comment') return []
  const prefix = sentence.commandRaw.trim()
  if (sentence.command === 'say' && looksLikeUnknownCommand(prefix, recognized)) {
    return [
      {
        kind: 'unknown-command',
        message: `命令 ${prefix} 不受当前解析器支持，请改用已支持命令`,
        range,
        rawText
      }
    ]
  }
  if (sentence.command !== 'say' || !unsafeGeneratedDialogue(sentence)) return []
  return [
    {
      kind: 'unsupported-dialogue',
      message: '生成旁白必须写 say 并使用 -clear；不要使用空说话人、单独 say 或没有冒号的裸行',
      range,
      rawText
    }
  ]
}

/** 空说话人、单独 say 和裸行才进入新语法问题；角色简写保持既有兼容。 */
function unsafeGeneratedDialogue(sentence: ParsedSceneSentence): boolean {
  if (explicitGeneratedDialogue(sentence)) return false
  return sentence.commandRaw === 'say' || sentence.commandRaw.trim() === ''
}

/** 显式姓名和显式旁白都算生成契约对白；两者同时出现时以清除为准。 */
function explicitGeneratedDialogue(sentence: ParsedSceneSentence): boolean {
  const speaker = sentence.arguments.find((argument) => argument.key === 'speaker')
  const cleared = sentence.arguments.some(
    (argument) => argument.key === 'clear' && argument.value === true
  )
  if (cleared) return true
  return (
    sentence.commandRaw === 'say' &&
    speaker !== undefined &&
    speaker.originalValue !== '' &&
    String(speaker.value).trim() !== ''
  )
}

/**
 * 只有像命令标识符的未知前缀才进入命令诊断。
 * 中文角色名和普通台词保持对白语义，避免把合法说话人误判成命令。
 */
function looksLikeUnknownCommand(prefix: string, recognized: readonly string[]): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) && !recognized.includes(prefix)
}
