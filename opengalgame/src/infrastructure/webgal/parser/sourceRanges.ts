import type { SceneSourceRange } from '@application/scenes/models/ParsedScene'

type SourceLine = { readonly start: number; readonly end: number }

/** 从未经预处理的字符串取得实际行边界，偏移为 UTF-16 字符位置。 */
export function sourceLines(text: string): readonly SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue
    lines.push({ start, end: text[index - 1] === '\r' ? index - 1 : index })
    start = index + 1
  }
  lines.push({ start, end: text.length })
  return lines
}

/**
 * 将官方首尾行换成能从原文准确切片的半开范围，不包含末行换行符。
 * @param lines - 未经预处理的源行。
 */
export function sourceRange(
  lines: readonly SourceLine[],
  startLine: number,
  endLine: number
): SceneSourceRange {
  return {
    startOffset: lines[startLine]!.start,
    endOffset: lines[endLine]!.end,
    startLine,
    startColumn: 0,
    endLine,
    endColumn: lines[endLine]!.end - lines[endLine]!.start
  }
}

/** 保留语句的内容原文，不反向使用已改写的运行时资源地址。 */
export function rawSentenceContent(rawText: string): string {
  const beforeComment = rawText.split(/(?<!\\);/u)[0]!
  const colon = beforeComment.indexOf(':')
  const content = colon < 0 ? beforeComment : beforeComment.slice(colon + 1)
  const argument = /(?: -|\r?\n +-)/u.exec(content)
  return argument ? content.slice(0, argument.index) : content
}

/**
 * 只在原文能唯一证明正文切片时返回范围。
 * 多行续写、重复正文或转义改写都没有安全替换点，返回 undefined。
 */
export function dialogueContentRange(
  rawText: string,
  content: string,
  range: SceneSourceRange
): SceneSourceRange | undefined {
  if (range.startLine !== range.endLine || content.length === 0) return undefined
  const body = rawSentenceContent(rawText)
  const bodyStart = rawText.indexOf(body)
  if (bodyStart < 0 || bodyStart !== rawText.lastIndexOf(body)) return undefined
  const startInBody = body.indexOf(content)
  if (startInBody < 0 || startInBody !== body.lastIndexOf(content)) return undefined
  const startOffset = range.startOffset + bodyStart + startInBody
  const endOffset = startOffset + content.length
  if (
    rawText.slice(bodyStart + startInBody, bodyStart + startInBody + content.length) !== content
  ) {
    return undefined
  }
  return {
    startOffset,
    endOffset,
    startLine: range.startLine,
    startColumn: startOffset - range.startOffset,
    endLine: range.endLine,
    endColumn: endOffset - range.startOffset
  }
}
