import { installedPackageVersion } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { webgalBoolean } from '@infrastructure/webgal/compatibility/WebgalCommandArguments'
import type { SceneArtifactGateway } from '@application/scene-generation/ports/SceneArtifactGateway'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  EditSceneGenerationCandidateDTO,
  SceneGenerationInputsDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneSourceReaderGateway } from '@application/scenes/ports/SceneSourceReaderGateway'
import type { SceneScriptParserGateway } from '@application/scenes/ports/SceneScriptParserGateway'
import type {
  ParsedSceneSentence,
  SceneArgumentValue,
  SceneParseDiagnostic
} from '@application/scenes/models/ParsedScene'
import type {
  SceneGenerationStatement,
  SceneSyntaxContractIssue
} from '@domain/scene-generation/models/SceneGenerationArtifact'
import type { SceneAssetReferenceGateway } from '@application/scenes/ports/SceneAssetReferenceGateway'
import type { SceneAssetCategory } from '@domain/scenes/models/SceneAssetReference'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import { toDomainRequest } from '@application/scene-generation/policies/SceneGenerationCandidatePolicy'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { readCommitFiles } from '@infrastructure/git/objects/gitTree'
import { projectAssetRelativePaths } from '@infrastructure/webgal/assetPath'
import { assetCategoriesAllowedByCommand } from '@domain/scene-generation/services/validateSceneArtifact'
import { enrichMissingAssetDiagnostics } from '@infrastructure/scene-generation/artifacts/missingAssetDiagnostics'

/**
 * 在同一路径的多张卡片中选择命令可以使用的那一张。
 * 只按素材类别匹配；同类别有多张时取第一张，不再按角色用途精确区分。
 * @returns 类别相符的卡片；类别不符时为 undefined。
 */
export function selectAuthorizedAsset(
  assets: SceneGenerationInputsDTO['assets'],
  reference: { kind: string; rawReference: string; relativePath?: string },
  command: string
): SceneGenerationInputsDTO['assets'][number] | undefined {
  const located = assets.filter(
    (asset) =>
      projectAssetRelativePaths(reference.kind, reference.rawReference).includes(
        asset.relativePath
      ) && asset.relativePath === reference.relativePath
  )
  const allowed = assetCategoriesAllowedByCommand(command)
  if (!allowed) return located[0]
  return located.find((asset) => allowed.includes(asset.category))
}

export class WebGalSceneArtifactGatewayImpl implements SceneArtifactGateway {
  constructor(
    private readonly files: AiProjectFileSystemImpl,
    private readonly reader: SceneSourceReaderGateway,
    private readonly parser: SceneScriptParserGateway,
    private readonly references: SceneAssetReferenceGateway
  ) {}

  /** 人工编辑仅能改当前入口，真实写入后先保存修订再返回。 */
  async writeCandidateFiles(
    execution: SceneGenerationExecution,
    request: EditSceneGenerationCandidateDTO
  ): Promise<{ candidateSnapshotId: string }> {
    if (request.candidateSnapshotId !== execution.candidateSnapshotId)
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '候选内容已变化' })
    const allowed = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    if (!request.files.length || request.files.some((file) => file.relativePath !== allowed))
      throw new AppException({ code: ErrorCodes.forbidden, msg: '文件不在本次候选脚本写入范围' })
    await this.verifyRevision(execution, request.candidateSnapshotId)
    const workspace = this.files.locateWorkspace(execution)
    const original = await this.files.readFile(workspace, allowed)
    try {
      for (const file of request.files)
        await this.files.writeFile(workspace, file.relativePath, Buffer.from(file.content, 'utf8'))
      return await this.saveCandidateRevision(execution)
    } catch (error) {
      try {
        await this.files.writeFile(workspace, allowed, original.bytes)
      } catch (rollbackError) {
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '候选编辑失败且原内容未能恢复，已保留修订依据',
          cause: new AggregateError([error, rollbackError])
        })
      }
      throw error
    }
  }

  /** 保存候选 Git 修订，发布失败不返回快照引用。 */
  async saveCandidateRevision(
    execution: SceneGenerationExecution
  ): Promise<{ candidateSnapshotId: string }> {
    const result = await this.files.saveRevision(this.files.locateWorkspace(execution))
    return { candidateSnapshotId: result.revisionId }
  }

  async readCandidate(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string
  ): Promise<SceneGenerationCandidate> {
    await this.verifyRevision(execution, candidateSnapshotId)
    const workspace = this.files.locateWorkspace(execution)
    const entryFile = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    const snapshot = await this.reader.readSceneSource({
      projectRoot: workspace.rootDirectory,
      entryFile
    })
    const parsed = this.parser.parseSceneScript(snapshot, undefined, {
      syntaxContract: 'generated-candidate'
    })
    const references = await this.references.checkSceneAssetReferences(snapshot, parsed)
    const sentences = parsed.sentences.filter((sentence) => !sentence.isLineBreakHolder)
    const uses = sentences.map((sentence) =>
      references
        .filter((reference) =>
          sentence.assets.some(
            (asset) =>
              asset.line === reference.sourceLine && asset.rawReference === reference.rawReference
          )
        )
        .map((reference) => {
          const asset = selectAuthorizedAsset(
            execution.inputSnapshot.assets,
            reference,
            sentence.command
          )
          return {
            category: asset?.category ?? categoryOfReferenceKind(reference.kind),
            outcome:
              reference.status === 'present'
                ? asset
                  ? ('matched' as const)
                  : ('unauthorized' as const)
                : reference.status,
            assetId: asset?.assetId,
            reference: reference.rawReference,
            line: reference.sourceLine + 1
          }
        })
    )
    const statements = sentences.map((sentence, index) => {
      const contract = generationContractFact(parsed.diagnostics, sentence)
      return {
        sequence: index,
        command: sentence.command,
        commandRecognition:
          contract?.issue === 'unknown-command' ||
          parsed.diagnostics.some(
            (item) =>
              item.kind === 'unknown-command' &&
              item.range?.startLine === sentence.sourceRange.startLine
          )
            ? ('unknown' as const)
            : ('recognized' as const),
        argumentRecognition: parsed.diagnostics.some(
          (item) =>
            item.kind === 'invalid-argument' &&
            item.range?.startLine === sentence.sourceRange.startLine
        )
          ? ('invalid' as const)
          : ('recognized' as const),
        content: sentence.rawContent,
        assetUses: uses[index],
        syntaxContract: 'generated-candidate' as const,
        ...(contract ? { contractIssue: contract.issue, contractMessage: contract.message } : {}),
        ...statementSemantics(sentence, sentences)
      }
    })
    const artifact = {
      scene: { projectId: execution.projectId, sceneId: execution.sceneId },
      hasEntry: true,
      statements
    }
    const report = enrichMissingAssetDiagnostics(
      new SceneGenerationDomainServiceImpl().validateArtifact(
        artifact,
        toDomainRequest(execution, {
          baselineState: 'unchanged',
          lockState: execution.baseline.lockState
        })
      ),
      execution.inputSnapshot.assets
    )
    return {
      candidateSnapshotId,
      artifact,
      assetChanges: [],
      preview: {
        entryFile,
        files: snapshot.files
          .filter((file) => file.kind !== 'metadata')
          .map((file) => file.relativePath),
        parserVersion: installedPackageVersion('webgal-parser'),
        commandLocations: sentences.map((sentence, sequence) => ({
          sequence,
          filePath: entryFile,
          line: sentence.sourceRange.startLine + 1,
          engineSentenceIndex: sentence.engineSentenceIndex
        })),
        assetLocations: uses.flatMap((items, sequence) =>
          items
            .filter((item) => item.assetId)
            .map((item) => ({
              assetId: item.assetId!,
              relativePath: execution.inputSnapshot.assets.find(
                (asset) => asset.assetId === item.assetId
              )!.relativePath,
              sequence
            }))
        ),
        validationReport: report
      }
    }
  }

  /** 比较候选所有真实字节与不可变修订，禁止用旧校验提交新内容。 */
  async verifyRevision(
    execution: SceneGenerationExecution,
    candidateSnapshotId: string
  ): Promise<void> {
    const workspace = this.files.locateWorkspace(execution)
    const revisionFiles = await readCommitFiles(
      { gitdir: workspace.revisionGitDir },
      candidateSnapshotId
    )
    const paths = await this.files.listFiles(workspace)
    if (paths.length !== revisionFiles.length)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选文件与已保存修订不一致'
      })
    for (const file of revisionFiles) {
      const actual = await this.files.readFile(workspace, file.relativePath)
      if (!Buffer.from(actual.bytes).equals(Buffer.from(file.bytes)))
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '候选内容在校验后发生变化'
        })
    }
  }
}

/** 未授权时的引用事实仍需要类别：由引用目录给出媒体类别，不猜用途。 */
function categoryOfReferenceKind(kind: string): SceneAssetCategory {
  if (kind === 'video') return 'video'
  if (kind === 'bgm' || kind === 'vocal') return 'audio'
  return 'image'
}

/** 一条语句只取生成契约的首个语法问题，避免同一行重复进入修正。 */
function generationContractFact(
  diagnostics: readonly SceneParseDiagnostic[],
  sentence: ParsedSceneSentence
): { issue: SceneSyntaxContractIssue; message: string } | undefined {
  const diagnostic = diagnostics.find(
    (item) =>
      (item.kind === 'unknown-command' || item.kind === 'unsupported-dialogue') &&
      item.range?.startLine === sentence.sourceRange.startLine
  )
  if (
    !diagnostic ||
    (diagnostic.kind !== 'unknown-command' && diagnostic.kind !== 'unsupported-dialogue')
  )
    return undefined
  return { issue: diagnostic.kind, message: diagnostic.message }
}

/**
 * 从解析事实提取姓名、自动推进、静态跳过和同文件跳转。
 * 连续对白保留明确的继承语义。next 不是完整的调度模型。
 * @returns 姓名、next、是否等待、跳过和跳转目标。
 */
function statementSemantics(
  sentence: ParsedSceneSentence,
  sentences: readonly ParsedSceneSentence[]
): Pick<
  SceneGenerationStatement,
  'dialogueSpeaker' | 'automaticAdvance' | 'waitsForPlayer' | 'skipped' | 'jumpTarget'
> {
  const automaticAdvance = webgalBoolean(argumentValue(sentence, 'next')) === true
  const skipped = constantFalseWhen(sentence)
  const jumpTarget = skipped ? undefined : staticJumpTarget(sentence, sentences)
  const scheduling = {
    automaticAdvance,
    waitsForPlayer: !automaticAdvance && !skipped && jumpTarget === undefined,
    ...(skipped ? { skipped: true as const } : {}),
    ...(jumpTarget === undefined ? {} : { jumpTarget })
  }
  if (sentence.command !== 'say') return scheduling
  const speaker = sentence.arguments.find((arg) => arg.key === 'speaker')
  const cleared = webgalBoolean(argumentValue(sentence, 'clear')) === true
  return {
    ...scheduling,
    dialogueSpeaker: cleared
      ? 'cleared'
      : speaker
        ? speaker.value === 0 && speaker.originalValue === ''
          ? 'numeric-zero'
          : String(speaker.value).trim() === ''
            ? 'cleared'
            : 'explicit'
        : sentence.commandRaw === 'say'
          ? 'implicit'
          : 'inherited'
  }
}

/**
 * @returns 参数值；没有该参数时为 undefined。
 */
function argumentValue(sentence: ParsedSceneSentence, key: string): SceneArgumentValue | undefined {
  return sentence.arguments.find((argument) => argument.key === key)?.value
}

/**
 * 判断 when 是否为引擎会直接跳过的恒 false。
 * 条件字面值区分大小写；动态变量不能提前当成 false。
 * @returns 语句会被跳过并继续推进时为 true。
 */
function constantFalseWhen(sentence: ParsedSceneSentence): boolean {
  const value = argumentValue(sentence, 'when')
  if (value === false) return true
  return typeof value === 'string' && value.trim() === 'false'
}

/**
 * 解析指向同一脚本已有标签的静态跳转。
 * 缺失标签和动态目标不在这里展开。
 * @returns 目标语句序号；不是这种跳转时为 undefined。
 */
function staticJumpTarget(
  sentence: ParsedSceneSentence,
  sentences: readonly ParsedSceneSentence[]
): number | undefined {
  if (sentence.command !== 'jumpLabel') return undefined
  const name = sentence.content.trim()
  if (name === '') return undefined
  const index = sentences.findIndex(
    (item) => item.command === 'label' && item.content.trim() === name
  )
  return index < 0 ? undefined : index
}
