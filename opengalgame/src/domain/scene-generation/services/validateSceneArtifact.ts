import type {
  SceneAssetCategory,
  SceneAssetReference
} from '../../scenes/models/SceneAssetReference'
import type {
  SceneAssetUse,
  SceneGenerationArtifact,
  SceneGenerationStatement
} from '../models/SceneGenerationArtifact'
import {
  requireSceneGenerationRequest,
  type ConfirmedSceneControl,
  type SceneControlKind,
  type SceneGenerationRequest
} from '../models/SceneGenerationRequest'
import type {
  SceneValidationIssue,
  SceneValidationIssueCode,
  SceneValidationReport
} from '../models/SceneValidationReport'

const commandCategories: Partial<Record<string, readonly SceneAssetCategory[]>> = {
  changeBg: ['image'],
  changeFigure: ['image'],
  changeFigureDiff: ['image'],
  miniAvatar: ['image'],
  bgm: ['audio'],
  playEffect: ['audio'],
  say: ['audio'],
  playVideo: ['video']
}

/**
 * 命令可以引用的素材类别。未列出的命令不按类别收窄。
 * @returns 允许的类别；命令不引用素材时为 undefined。
 */
export function assetCategoriesAllowedByCommand(
  command: string
): readonly SceneAssetCategory[] | undefined {
  return commandCategories[command]
}

/**
 * 判断素材类别是否与命令的引用方式一致。
 * 未列出的命令不收窄，任何类别都相符。
 */
export function assetCategoryMatchesCommand(
  category: SceneAssetCategory,
  command: string
): boolean {
  return commandCategories[command]?.includes(category) ?? true
}

/**
 * 校验候选是否构成单个场景成品。
 * 跨场景命令、选项和条件依据 webgal-parser 4.6.5：`changeScene` 与 `callScene` 指向其他场景文件，
 * `choose` 与 `chooseLabel` 是选项，`if` 是条件装配。同文件的 `label`、`jumpLabel` 和推进参数不在此列。
 * 素材是否存在、是否越界由调用方先判定，这里只解释素材类别和授权。
 * 文档和提示词保留剧情要求与用户限制；领域不从正文猜测台词是否写对。
 * 已确认的限制要同时写明类别、语句内容和对应输入，只有内容一致的那一条不能自动删除。
 * @returns 可定位的业务问题。没有问题时列表为空。
 * @throws {AppException} 请求身份或素材登记不完整。
 */
export function validateSceneArtifact(
  artifact: SceneGenerationArtifact,
  request: SceneGenerationRequest
): SceneValidationReport {
  requireSceneGenerationRequest(request)
  const assets = new Map(request.assets.map((asset) => [asset.assetId, asset]))
  const issues: SceneValidationIssue[] = []
  if (!artifact.hasEntry) {
    issues.push(
      validationIssue('missing-entry', '场景入口不存在，不能作为单场景成品', { correctable: true })
    )
  }
  if (
    artifact.scene.projectId !== request.scene.projectId ||
    artifact.scene.sceneId !== request.scene.sceneId
  ) {
    issues.push(
      validationIssue('identity-mismatch', '候选场景与生成目标不是同一个场景', {
        correctable: false
      })
    )
  }
  for (const statement of artifact.statements) {
    issues.push(...statementIssues(statement, request.confirmedControls, assets))
  }
  issues.push(...stageSchedulingIssues(artifact.statements))
  issues.push(...dialogueContextIssues(artifact))
  return { issues }
}

/**
 * @param confirmedControls - 已确认、不能自动删除的控制。
 * @returns 该语句的问题，没有问题时为空数组。
 */
function statementIssues(
  statement: SceneGenerationStatement,
  confirmedControls: readonly ConfirmedSceneControl[],
  assets: ReadonlyMap<string, SceneAssetReference>
): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = []
  if (statement.dialogueSpeaker === 'implicit' || statement.dialogueSpeaker === 'numeric-zero') {
    issues.push(
      validationIssue(
        'implicit-speaker',
        statement.dialogueSpeaker === 'numeric-zero'
          ? '空 speaker 赋值会显示姓名“0”，请用 -clear 或空说话人清空姓名'
          : 'say 未明确设置姓名，会继承舞台上一位姓名；旁白请用 -clear 或空说话人',
        { sequence: statement.sequence, correctable: true }
      )
    )
  }
  if (statement.commandRecognition === 'unknown') {
    issues.push(
      validationIssue('unknown-command', generationCommandMessage(statement), {
        sequence: statement.sequence,
        correctable: true
      })
    )
  }
  if (
    statement.syntaxContract === 'generated-candidate' &&
    statement.contractIssue === 'unsupported-dialogue'
  ) {
    issues.push(
      validationIssue(
        'unsupported-dialogue',
        '生成旁白必须写 say 并使用 -clear；不要使用空说话人、单独 say 或没有冒号的裸行',
        { sequence: statement.sequence, correctable: true }
      )
    )
  }
  if (statement.argumentRecognition === 'invalid') {
    issues.push(
      validationIssue(
        'invalid-argument',
        `命令 ${statement.command} 含有当前解析器不能识别的参数`,
        {
          sequence: statement.sequence,
          correctable: true
        }
      )
    )
  }
  if (statement.commandRecognition === 'recognized') {
    const control = sceneControlKind(statement.command)
    if (control) issues.push(controlIssue(statement, control, confirmedControls))
  }
  for (const use of statement.assetUses) {
    const referenceIssue = assetIssue(statement, use, assets)
    if (referenceIssue) issues.push(referenceIssue)
  }
  return issues
}

/** 生成契约的未知命令给出安全表述；其他未知命令不暴露脚本正文。 */
function generationCommandMessage(statement: SceneGenerationStatement): string {
  if (statement.contractIssue === 'unknown-command' && statement.contractMessage) {
    return '候选含有当前解析器不能识别的命令，请改用已支持命令'
  }
  return `命令 ${statement.command} 不能被当前解析器识别`
}

/**
 * 按引擎实际会执行到的语句检查音效会不会在启动前被结束场景清除。
 * 静态跳过的语句不产生演出或结束效果。同文件静态跳转改从目标语句继续。
 * @returns 调度问题。没有问题时为空数组。
 */
function stageSchedulingIssues(
  statements: readonly SceneGenerationStatement[]
): SceneValidationIssue[] {
  const issues: SceneValidationIssue[] = []
  const followedJumps = new Set<number>()
  let effects: SceneGenerationStatement[] = []
  let cursor = 0
  while (cursor < statements.length) {
    const statement = statements[cursor]!
    if (statement.skipped) {
      cursor += 1
      continue
    }
    const jumped = jumpCursor(statements, statement, cursor, followedJumps)
    if (jumped !== undefined) {
      cursor = jumped
      continue
    }
    if (statement.command === 'end') {
      for (const effect of effects) {
        issues.push(
          validationIssue(
            'automatic-effect-before-end',
            '音效与 end 之间全是自动推进语句，音效启动前会被清除；请保留一条等待玩家的语句',
            { sequence: effect.sequence, correctable: true }
          )
        )
      }
      effects = []
    } else if (statementPauses(statement)) {
      effects = []
    } else if (
      statement.command === 'playEffect' &&
      statement.assetUses.every((use) => use.outcome !== 'cleared')
    ) {
      effects.push(statement)
    }
    cursor += 1
  }
  return issues
}

/**
 * 连续对白进入预览前必须已证明背景和角色。
 * 只认引擎实际会执行到的对白：静态跳过的语句不建立舞台，也不算对白；
 * 同文件静态跳转改从目标继续，跳过的分支不能补上后面的对白。
 * 单句、旁白和没有对白的候选保持原规则。背景和角色只认仍在舞台上的匹配引用。
 * 重复跳进同一条跳转时停止，避免环路。
 */
function dialogueContextIssues(artifact: SceneGenerationArtifact): SceneValidationIssue[] {
  const statements = artifact.statements
  const followedJumps = new Set<number>()
  let background = false
  let character = false
  let backgroundReady = true
  let characterReady = true
  let namedDialogue = 0
  let cursor = 0
  while (cursor < statements.length) {
    const statement = statements[cursor]!
    if (statement.skipped) {
      cursor += 1
      continue
    }
    const jumped = jumpCursor(statements, statement, cursor, followedJumps)
    if (jumped !== undefined) {
      cursor = jumped
      continue
    }
    // 素材匹配已按类别校验；舞台上下文只看命令，不按用途细分。
    if (statement.command === 'changeBg')
      background = statement.assetUses.some((use) => use.outcome === 'matched')
    if (statement.command === 'changeFigure' || statement.command === 'changeFigureDiff') {
      character = statement.assetUses.some((use) => use.outcome === 'matched')
    }
    if (namedDialogueStatement(statement)) {
      namedDialogue += 1
      if (!background) backgroundReady = false
      if (!character) characterReady = false
    }
    cursor += 1
  }
  if (namedDialogue < 2) return []
  const issues: SceneValidationIssue[] = []
  if (!backgroundReady) {
    issues.push(
      validationIssue('missing-background', '连续对白缺少已建立的背景，不能进入候选预览', {
        correctable: true
      })
    )
  }
  if (!characterReady) {
    issues.push(
      validationIssue('missing-character', '连续对白缺少已建立的角色，不能进入候选预览', {
        correctable: true
      })
    )
  }
  return issues
}

/** 有姓名的对白才要求舞台上下文。旁白和姓名不明确的语句不在此列。 */
function namedDialogueStatement(statement: SceneGenerationStatement): boolean {
  return (
    statement.command === 'say' &&
    (statement.dialogueSpeaker === 'explicit' || statement.dialogueSpeaker === 'inherited')
  )
}

/**
 * 解析同文件静态跳转的下一检查位置。
 * 重复跳进同一条跳转时停止，避免环路。
 * @returns 目标下标；不是静态跳转时为 undefined；环路时为语句数量，表示结束。
 */
function jumpCursor(
  statements: readonly SceneGenerationStatement[],
  statement: SceneGenerationStatement,
  cursor: number,
  followedJumps: Set<number>
): number | undefined {
  if (statement.jumpTarget === undefined) return undefined
  if (followedJumps.has(cursor)) return statements.length
  followedJumps.add(cursor)
  const target = statements.findIndex((item) => item.sequence === statement.jumpTarget)
  return target >= 0 ? target : cursor + 1
}

/**
 * 判断语句会不会让引擎停住等待玩家。
 * 已给出等待事实时以它为准；只有自动推进时，没有 next 才停住。
 */
function statementPauses(statement: SceneGenerationStatement): boolean {
  if (statement.waitsForPlayer !== undefined) return statement.waitsForPlayer
  return !statement.automaticAdvance
}

/**
 * 把已识别命令分成场景跳转、选项或条件。
 * @returns 单场景不允许的控制；台词、演出和同文件标签返回 undefined。
 */
function sceneControlKind(command: string): SceneControlKind | undefined {
  if (command === 'changeScene' || command === 'callScene') return 'sceneJump'
  if (command === 'choose' || command === 'chooseLabel') return 'option'
  if (command === 'if') return 'condition'
  return undefined
}

/** 生成一条控制问题。只有与已确认内容一致的语句不能自动删除，同类的其他语句仍可修正。 */
function controlIssue(
  statement: SceneGenerationStatement,
  control: SceneControlKind,
  confirmedControls: readonly ConfirmedSceneControl[]
): SceneValidationIssue {
  const requiresHumanDecision = confirmedControls.some(
    (confirmed) => confirmed.kind === control && confirmed.content === statement.content
  )
  const message = controlMessage(statement.command, control)
  return validationIssue(
    controlCode(control),
    requiresHumanDecision ? `${message}。该写法已被确认，不能自动删除` : message,
    {
      sequence: statement.sequence,
      correctable: true,
      requiresHumanDecision
    }
  )
}

function controlCode(control: SceneControlKind): SceneValidationIssueCode {
  if (control === 'sceneJump') return 'scene-jump'
  if (control === 'option') return 'option-edge'
  return 'condition'
}

function controlMessage(command: string, control: SceneControlKind): string {
  if (control === 'sceneJump') return `不能使用 ${command} 切换或调用其他场景`
  if (control === 'option') return `不能使用 ${command} 写入选项`
  return `不能使用 ${command} 写入条件`
}

/**
 * 解释一条素材引用。清除不构成问题；匹配时核对授权和类别。
 * @param use - 调用方已经归类的引用事实。
 * @returns 引用问题；没有问题时为 undefined。
 */
function assetIssue(
  statement: SceneGenerationStatement,
  use: SceneAssetUse,
  assets: ReadonlyMap<string, SceneAssetReference>
): SceneValidationIssue | undefined {
  if (use.outcome === 'cleared') return undefined
  if (use.outcome === 'matched') return matchedAssetIssue(statement, use, assets)
  return validationIssue(referenceCode(use.outcome), referenceMessage(use.outcome), {
    sequence: statement.sequence,
    correctable: true,
    ...(use.reference === undefined ? {} : { reference: use.reference }),
    ...(use.line === undefined ? {} : { line: use.line })
  })
}

/**
 * @returns 未提供或类别不符的问题；通过时为 undefined。
 */
function matchedAssetIssue(
  statement: SceneGenerationStatement,
  use: SceneAssetUse,
  assets: ReadonlyMap<string, SceneAssetReference>
): SceneValidationIssue | undefined {
  const asset = use.assetId === undefined ? undefined : assets.get(use.assetId)
  if (!asset) {
    return validationIssue('unauthorized-asset', '引用了本次未提供的素材', {
      sequence: statement.sequence,
      correctable: true
    })
  }
  if (!assetCategoryMatchesCommand(asset.category, statement.command)) {
    return validationIssue('purpose-mismatch', '素材类别与引用方式不一致', {
      sequence: statement.sequence,
      correctable: true
    })
  }
  return undefined
}

/**
 * @param outcome - 缺失、外部、越界或未授权。
 */
function referenceCode(
  outcome: Exclude<SceneAssetUse['outcome'], 'cleared' | 'matched'>
): SceneValidationIssueCode {
  if (outcome === 'missing') return 'missing-asset'
  if (outcome === 'external') return 'external-asset'
  if (outcome === 'invalid-path') return 'invalid-path'
  return 'unauthorized-asset'
}

/**
 * @param outcome - 缺失、外部、越界或未授权。
 */
function referenceMessage(
  outcome: Exclude<SceneAssetUse['outcome'], 'cleared' | 'matched'>
): string {
  if (outcome === 'missing') return '素材引用在工程中不存在'
  if (outcome === 'external') return '素材引用指向工程外的地址'
  if (outcome === 'invalid-path') return '素材引用越出工程根'
  return '引用了本次未提供的素材'
}

/**
 * @param options - 语句序号、能否修正，以及是否不能自动删除。
 */
function validationIssue(
  code: SceneValidationIssueCode,
  message: string,
  options: {
    sequence?: number
    correctable: boolean
    requiresHumanDecision?: boolean
    reference?: string
    line?: number
  }
): SceneValidationIssue {
  return {
    code,
    message,
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
    correctable: options.correctable,
    requiresHumanDecision: options.requiresHumanDecision ?? false,
    ...(options.reference === undefined ? {} : { reference: options.reference }),
    ...(options.line === undefined ? {} : { line: options.line })
  }
}
