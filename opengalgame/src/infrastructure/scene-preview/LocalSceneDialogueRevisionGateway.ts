import { createHash } from 'node:crypto'

import type { DialogueEditPlan } from '@domain/scene-preview/models/DialogueEditPlan'
import type {
  PreparedDialogueRevision,
  SceneDialogueRevisionGateway
} from '@application/scene-preview/ports/SceneDialogueRevisionGateway'
import type { ScenePreviewSourceFact } from '@application/scene-preview/models/ScenePreviewSourceFact'
import type { ParsedSceneSentence, SceneSourceRange } from '@application/scenes/models/ParsedScene'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { assertRelativePath } from '@infrastructure/git/containedPath'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * 只替换解析器证明过的台词正文。
 * 不重打印文件，不改说话人、参数、配音、注释、换行或 BOM。
 */
export class LocalSceneDialogueRevisionGateway implements SceneDialogueRevisionGateway {
  async prepareDialogueRevision(
    source: ScenePreviewSourceFact,
    plan: DialogueEditPlan
  ): Promise<PreparedDialogueRevision> {
    if (
      plan.scene.projectId !== source.location.projectId ||
      plan.scene.sceneId !== source.location.sceneId
    ) {
      throw revisionRejected()
    }
    const relativePath = assertRelativePath(
      `${source.location.sceneDirectory}/${source.location.entryFile}`
    )
    const file = source.snapshot.files.find(
      (item) => item.relativePath === relativePath && item.kind !== 'metadata'
    )
    if (
      !file ||
      file.text === undefined ||
      file.relativePath !== source.parsed.sourceFile.relativePath
    ) {
      throw revisionRejected()
    }
    const replacements = plan.changedEdits.map((edit) =>
      replacementFor(source, file.text!, edit.dialogueId, edit.text)
    )
    replacements.sort((left, right) => right.range.startOffset - left.range.startOffset)
    let text = file.text
    for (const replacement of replacements) {
      text =
        text.slice(0, replacement.range.startOffset) +
        replacement.text +
        text.slice(replacement.range.endOffset)
    }
    const bytes = encoder.encode(text)
    if (decoder.decode(bytes) !== text) throw revisionRejected()
    verifyRevision(source, relativePath, bytes, replacements)
    return {
      relativePath,
      bytes,
      digest: createHash('sha256').update(bytes).digest('hex')
    }
  }
}

function replacementFor(
  source: ScenePreviewSourceFact,
  text: string,
  dialogueId: string,
  nextText: string
): { range: SceneSourceRange; text: string } {
  if (breaksWebgalStructure(nextText)) throw revisionRejected()
  const sentence = source.parsed.sentences.find((item) => String(item.sequence) === dialogueId)
  if (
    !sentence ||
    sentence.command !== 'say' ||
    sentence.isLineBreakHolder ||
    !sentence.contentRange
  ) {
    throw revisionRejected()
  }
  const current = text.slice(sentence.contentRange.startOffset, sentence.contentRange.endOffset)
  if (current !== sentence.rawContent || current === nextText) throw revisionRejected()
  return { range: sentence.contentRange, text: nextText }
}

function verifyRevision(
  source: ScenePreviewSourceFact,
  relativePath: string,
  bytes: Uint8Array,
  replacements: readonly { range: SceneSourceRange; text: string }[]
): void {
  const revised = new SceneScriptParserGatewayImpl().parseSceneScript(
    {
      ...source.snapshot,
      files: source.snapshot.files.map((file) =>
        file.relativePath === relativePath
          ? { ...file, bytes, text: decoder.decode(bytes), size: bytes.byteLength }
          : file
      ),
      entryFile:
        source.snapshot.entryFile.relativePath === relativePath
          ? {
              ...source.snapshot.entryFile,
              bytes,
              text: decoder.decode(bytes),
              size: bytes.byteLength
            }
          : source.snapshot.entryFile
    },
    relativePath
  )
  if (revised.sentences.length !== source.parsed.sentences.length) throw revisionRejected()
  for (const [index, before] of source.parsed.sentences.entries()) {
    const after = revised.sentences[index]
    const replacement = replacements.find(
      (item) => item.range.startOffset === before.contentRange?.startOffset
    )
    if (!after || !sameStructure(before, after, replacement?.text)) throw revisionRejected()
  }
}

function sameStructure(
  before: ParsedSceneSentence,
  after: ParsedSceneSentence,
  nextText: string | undefined
): boolean {
  const expected = nextText ?? before.rawContent
  return (
    after.command === before.command &&
    after.commandRaw === before.commandRaw &&
    after.rawContent === expected &&
    after.inlineComment === before.inlineComment &&
    after.isLineBreakHolder === before.isLineBreakHolder &&
    after.arguments.length === before.arguments.length &&
    after.arguments.every((argument, index) => {
      const previous = before.arguments[index]
      return (
        previous !== undefined && argument.key === previous.key && argument.value === previous.value
      )
    }) &&
    after.assets.length === before.assets.length &&
    after.assets.every((asset, index) => {
      const previous = before.assets[index]
      return (
        previous !== undefined &&
        asset.kind === previous.kind &&
        asset.rawReference === previous.rawReference
      )
    })
  )
}

function breaksWebgalStructure(text: string): boolean {
  return /[\r\n;:]/u.test(text) || /(?:^| )-/u.test(text) || text.includes('\\')
}

function revisionRejected(): AppException {
  return new AppException({ code: ErrorCodes.invalidRequest, msg: '台词正文不能安全写回' })
}
