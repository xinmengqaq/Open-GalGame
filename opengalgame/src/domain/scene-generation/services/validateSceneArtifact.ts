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

export function assetCategoriesAllowedByCommand(
  command: string
): readonly SceneAssetCategory[] | undefined {
  return commandCategories[command]
}

export function assetCategoryMatchesCommand(
  category: SceneAssetCategory,
  command: string
): boolean {
  return commandCategories[command]?.includes(category) ?? true
}

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

function generationCommandMessage(statement: SceneGenerationStatement): string {
  if (statement.contractIssue === 'unknown-command' && statement.contractMessage) {
    return '候选含有当前解析器不能识别的命令，请改用已支持命令'
  }
  return `命令 ${statement.command} 不能被当前解析器识别`
}

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

function namedDialogueStatement(statement: SceneGenerationStatement): boolean {
  return (
    statement.command === 'say' &&
    (statement.dialogueSpeaker === 'explicit' || statement.dialogueSpeaker === 'inherited')
  )
}

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

function statementPauses(statement: SceneGenerationStatement): boolean {
  if (statement.waitsForPlayer !== undefined) return statement.waitsForPlayer
  return !statement.automaticAdvance
}

function sceneControlKind(command: string): SceneControlKind | undefined {
  if (command === 'changeScene' || command === 'callScene') return 'sceneJump'
  if (command === 'choose' || command === 'chooseLabel') return 'option'
  if (command === 'if') return 'condition'
  return undefined
}

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

function referenceCode(
  outcome: Exclude<SceneAssetUse['outcome'], 'cleared' | 'matched'>
): SceneValidationIssueCode {
  if (outcome === 'missing') return 'missing-asset'
  if (outcome === 'external') return 'external-asset'
  if (outcome === 'invalid-path') return 'invalid-path'
  return 'unauthorized-asset'
}

function referenceMessage(
  outcome: Exclude<SceneAssetUse['outcome'], 'cleared' | 'matched'>
): string {
  if (outcome === 'missing') return '素材引用在工程中不存在'
  if (outcome === 'external') return '素材引用指向工程外的地址'
  if (outcome === 'invalid-path') return '素材引用越出工程根'
  return '引用了本次未提供的素材'
}

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
