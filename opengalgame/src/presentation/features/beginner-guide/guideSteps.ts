import type {
  GuideCardKind,
  GuideFactKind,
  GuideSaveReason,
  GuideSourceKind
} from './guideObservation'

/** 步骤 id 一旦发布就不得修改；偏好、目录和 e2e 都依赖这些字符串。 */
export const GUIDE_STEP_ID = {
  configureModel: 'configure-model',
  createProject: 'create-project',
  importScript: 'import-script',
  arrangeScene: 'arrange-scene',
  saveAndGenerate: 'save-and-generate',
  playtestCandidate: 'playtest-candidate',
  polishDialogue: 'polish-dialogue',
  exportBuild: 'export-build'
} as const

export type GuideStepId = (typeof GUIDE_STEP_ID)[keyof typeof GUIDE_STEP_ID]

export const GUIDE_FINISH_LABEL = '结束阅读' as const

/** 文档编辑器打开期间仍留在第 3 步，只说明这里能做什么。 */
export const GUIDE_DOCUMENT_EDITOR_PROMPT = {
  title: '查看或编辑正文',
  prompt: '文档编辑器已打开；需要修改就写在这里，完成后点「返回画布」继续。'
} as const

/** 第 4 步开场背景的两种真实起点；由步骤签按文件区状态选择。 */
export const GUIDE_ARRANGE_BACKGROUND_ACTION = {
  import: '点击「导入图片」，再从文件区把背景图拖到画布。',
  drag: '从文件区把场景背景图拖到画布。'
} as const

/** 第 4 步六拍的稳定标识；目录跳步只依赖步骤 id，拍 id 供步骤签和测试使用。 */
export const GUIDE_ARRANGE_BEAT_ID = {
  opening: 'opening',
  cue: 'cue',
  sceneChange: 'scene-change',
  character: 'character',
  music: 'music',
  ending: 'ending'
} as const

export type GuideArrangeBeatId = (typeof GUIDE_ARRANGE_BEAT_ID)[keyof typeof GUIDE_ARRANGE_BEAT_ID]

/** 第 4 步绑定的卡片角色；同一张卡不能同时占用两个角色。 */
export const GUIDE_ARRANGE_CARD_ROLE = {
  script: 'script',
  opening: 'opening',
  cue: 'cue',
  nextBackground: 'next-background',
  characterBefore: 'character-before',
  characterAfter: 'character-after',
  music: 'music',
  prompt: 'prompt'
} as const

export type GuideArrangeCardRole =
  (typeof GUIDE_ARRANGE_CARD_ROLE)[keyof typeof GUIDE_ARRANGE_CARD_ROLE]

export type GuideArrangeStage = 'place' | 'usage' | 'connect' | 'name'

/** 角色到卡片类别：脚本卡、背景图、短音效、音乐和提示词卡。 */
export const GUIDE_ARRANGE_CARD_KIND: Readonly<Record<GuideArrangeCardRole, GuideCardKind>> = {
  script: 'document',
  opening: 'image',
  cue: 'audio',
  'next-background': 'image',
  'character-before': 'image',
  'character-after': 'image',
  music: 'audio',
  prompt: 'prompt'
}

export function guideArrangeCardKindLabel(kind: GuideCardKind): string {
  switch (kind) {
    case 'document':
      return '剧本卡'
    case 'image':
      return '图片'
    case 'audio':
      return '音频'
    case 'video':
      return '视频'
    case 'prompt':
      return '提示词卡'
    case 'animation':
      return '动画卡'
    case 'effect':
      return '特效卡'
  }
}

/** 一拍内按顺序完成的一个动作；提示文字只引用产品里能点到的操作。 */
export type GuideArrangeStep = {
  id: string
  stage: GuideArrangeStage
  /** place/usage 必须绑定或验证的角色；connect/name 用整拍的 relation。 */
  cardRole?: GuideArrangeCardRole
  /** 完成本动作后显示的下一步标题；未填时沿用当前拍的标题。 */
  title?: string
  /** 完成本动作后显示的下一步文案。 */
  prompt: string
  completion?: string
}

export type GuideArrangeBeat = {
  id: GuideArrangeBeatId
  number: number
  title: string
  /** 本拍开始时的选材提示。 */
  action: string
  /** 本拍要连起来的两个角色；无向，顺序不表示方向。 */
  relation: readonly [GuideArrangeCardRole, GuideArrangeCardRole]
  steps: readonly GuideArrangeStep[]
}

/**
 * 第 4 步六拍：开场、短音效、换景、两人物状态、音乐、提示词收尾。
 * 文案与[实施计划](../../../../../docs/新手指引/逐项编排与玻璃界面实施计划.md)
 * 的「每一拍放什么」对应；卡片由用户选择，教程不指定具体素材。
 */
export const GUIDE_ARRANGE_BEATS: readonly GuideArrangeBeat[] = [
  {
    id: GUIDE_ARRANGE_BEAT_ID.opening,
    number: 1,
    title: '添加场景背景图',
    action: GUIDE_ARRANGE_BACKGROUND_ACTION.drag,
    relation: ['script', 'opening'],
    steps: [
      {
        id: 'opening-placed',
        stage: 'place',
        cardRole: 'opening',
        title: '写清背景图用途',
        prompt: '在「用途说明」里写清从第一句开始显示，到哪句撤下。'
      },
      {
        id: 'opening-usage',
        stage: 'usage',
        cardRole: 'opening',
        title: '连起剧本和背景图',
        prompt: '从剧本端口连到背景图。'
      },
      {
        id: 'opening-connected',
        stage: 'connect',
        title: '给这段关系起名',
        prompt: '点线上的标签，给关系起名，比如『开场看见这里』。'
      },
      {
        id: 'opening-named',
        stage: 'name',
        prompt: '选一段短声音。比如有人敲门，你想在哪句话听见那一声？',
        completion: '开场背景安排好了。'
      }
    ]
  },
  {
    id: GUIDE_ARRANGE_BEAT_ID.cue,
    number: 2,
    title: '先让玩家听见',
    action: '选一段短声音。比如有人敲门，你想在哪句话听见那一声？',
    relation: ['cue', 'opening'],
    steps: [
      {
        id: 'cue-placed',
        stage: 'place',
        cardRole: 'cue',
        prompt: '在『用途说明』里写：念到哪句时响，只响一次。'
      },
      {
        id: 'cue-usage',
        stage: 'usage',
        cardRole: 'cue',
        prompt: '把声音卡连到当时的背景卡。'
      },
      {
        id: 'cue-connected',
        stage: 'connect',
        prompt: '点线上的标签，写清先听见什么。'
      },
      {
        id: 'cue-named',
        stage: 'name',
        prompt: '选另一张图。声音响过，再让玩家看到下一个地方。',
        completion: '短声音安排好了。'
      }
    ]
  },
  {
    id: GUIDE_ARRANGE_BEAT_ID.sceneChange,
    number: 3,
    title: '再换画面',
    action: '选另一张图。声音响过，再让玩家看到下一个地方。',
    relation: ['opening', 'next-background'],
    steps: [
      {
        id: 'next-background-placed',
        stage: 'place',
        cardRole: 'next-background',
        prompt: '写明从哪句开始替换背景图。'
      },
      {
        id: 'next-background-usage',
        stage: 'usage',
        cardRole: 'next-background',
        prompt: '连起两张背景卡。'
      },
      {
        id: 'next-background-connected',
        stage: 'connect',
        prompt: '把换景时机写在线上。'
      },
      {
        id: 'next-background-named',
        stage: 'name',
        prompt: '选同一人物的第一张图，安排他在哪句出场。',
        completion: '换景安排好了。'
      }
    ]
  },
  {
    id: GUIDE_ARRANGE_BEAT_ID.character,
    number: 4,
    title: '让人物换个表情',
    action: '选同一人物的第一张图，安排他在哪句出场。',
    relation: ['character-before', 'character-after'],
    steps: [
      {
        id: 'character-before-placed',
        stage: 'place',
        cardRole: 'character-before',
        prompt: '写下人物出场的那一句。'
      },
      {
        id: 'character-before-usage',
        stage: 'usage',
        cardRole: 'character-before',
        prompt: '再选这个人物的另一张状态图。'
      },
      {
        id: 'character-after-placed',
        stage: 'place',
        cardRole: 'character-after',
        prompt: '写清是开口前换，还是说完才换。'
      },
      {
        id: 'character-after-usage',
        stage: 'usage',
        cardRole: 'character-after',
        prompt: '连起两张人物卡。'
      },
      {
        id: 'character-connected',
        stage: 'connect',
        prompt: '注明这是同一人的状态变化。'
      },
      {
        id: 'character-named',
        stage: 'name',
        prompt: '选一段音乐，让它从换景开始，一直放到最后一句。',
        completion: '人物出场和表情变化安排好了。'
      }
    ]
  },
  {
    id: GUIDE_ARRANGE_BEAT_ID.music,
    number: 5,
    title: '放一段背景音乐',
    action: '选一段音乐，让它从换景开始，一直放到最后一句。',
    relation: ['music', 'next-background'],
    steps: [
      {
        id: 'music-placed',
        stage: 'place',
        cardRole: 'music',
        prompt: '把从哪句开始、到哪句停写进『用途说明』。'
      },
      {
        id: 'music-usage',
        stage: 'usage',
        cardRole: 'music',
        prompt: '把音乐卡连到换景后的背景卡。'
      },
      {
        id: 'music-connected',
        stage: 'connect',
        prompt: '在线上写『进来后开始放音乐』。'
      },
      {
        id: 'music-named',
        stage: 'name',
        prompt: '这次不用选文件。在画布上新建一张提示词卡。',
        completion: '背景音乐安排好了。'
      }
    ]
  },
  {
    id: GUIDE_ARRANGE_BEAT_ID.ending,
    number: 6,
    title: '约定收尾',
    action: '这次不用选文件。在画布上新建一张提示词卡。',
    relation: ['prompt', 'script'],
    steps: [
      {
        id: 'prompt-placed',
        stage: 'place',
        cardRole: 'prompt',
        prompt: '写下：保留台词顺序，到最后一句停下，不追加选项。'
      },
      {
        id: 'prompt-body-saved',
        stage: 'usage',
        cardRole: 'prompt',
        prompt: '把提示词卡连到剧本。'
      },
      {
        id: 'prompt-connected',
        stage: 'connect',
        prompt: '注明这条要求适用于全场。'
      },
      {
        id: 'prompt-named',
        stage: 'name',
        prompt: '对照剧本走一遍。开头看见什么？声音在哪句响？结尾在哪里停？都安排好再保存。',
        completion: '六拍都已安排。'
      }
    ]
  }
]

export function isGuideArrangeBeatId(value: unknown): value is GuideArrangeBeatId {
  return typeof value === 'string' && GUIDE_ARRANGE_BEATS.some((beat) => beat.id === value)
}

export function guideArrangeBeatById(beatId: GuideArrangeBeatId): GuideArrangeBeat {
  const beat = GUIDE_ARRANGE_BEATS.find((item) => item.id === beatId)
  if (!beat) {
    throw new Error(`未知的新手指引编排拍：${beatId}`)
  }
  return beat
}

export function guideArrangeBeatTotal(): number {
  return GUIDE_ARRANGE_BEATS.length
}

function arrangeMilestonesOf(beats: readonly GuideArrangeBeat[]): readonly GuideMilestone[] {
  return beats.flatMap((beat) =>
    beat.steps.map((step) => {
      const cardKind = step.cardRole ? GUIDE_ARRANGE_CARD_KIND[step.cardRole] : null
      const waitKind: GuideFactKind =
        step.stage === 'place'
          ? 'cardCreated'
          : step.stage === 'usage'
            ? step.cardRole === 'prompt'
              ? 'promptBodySaved'
              : 'cardEdited'
            : step.stage === 'connect'
              ? 'relationCreated'
              : 'relationNamed'
      return {
        id: step.id,
        wait: {
          kind: waitKind,
          ...(cardKind ? { cardKinds: [cardKind] } : {}),
          ...(step.cardRole ? { cardRole: step.cardRole } : {}),
          ...(step.stage === 'connect' || step.stage === 'name'
            ? { relationRoles: beat.relation }
            : {})
        },
        ...(step.title ? { title: step.title } : {}),
        prompt: step.prompt,
        ...(step.completion ? { completion: step.completion } : {}),
        arrange: {
          beatId: beat.id,
          beatNumber: beat.number,
          beatTotal: beats.length,
          stage: step.stage
        }
      } satisfies GuideMilestone
    })
  )
}

const ARRANGE_MILESTONES = arrangeMilestonesOf(GUIDE_ARRANGE_BEATS)

/**
 * 里程碑的等待条件。reducer 只认 outcome === 'confirmed' 的事实；
 * 这里不写回调、查询函数或 UI 状态。
 */
export type GuideMilestoneWait = {
  kind: GuideFactKind
  sourceKind?: GuideSourceKind
  cardKinds?: readonly GuideCardKind[]
  saveReason?: GuideSaveReason
  /** 需要沿用本步骤内已记录的对象，避免迟到或无关通知冒充完成。 */
  bind?:
    | 'saved-config'
    | 'created-project'
    | 'imported-source'
    | 'created-document'
    | 'generation-operation'
    | 'active-candidate'
  /** 第 4 步：place/usage 必须绑定或验证的卡片角色。 */
  cardRole?: GuideArrangeCardRole
  /** 第 4 步：普通连线必须匹配的两个端点角色；顺序不表示方向。 */
  relationRoles?: readonly [GuideArrangeCardRole, GuideArrangeCardRole]
}

export type GuideMilestone = {
  id: string
  wait: GuideMilestoneWait
  /** 该里程碑完成后的当前动作标题；未填时沿用步骤标题。 */
  title?: string
  /** 该里程碑完成后的原位提示；最后里程碑会被下一步主文案替代。 */
  prompt: string
  /** 可选的短确认，供读屏或非阻塞动效使用。 */
  completion?: string
  /** 第 4 步的六拍位置；步骤签据此显示「编排 i / 6」和当前所需类型。 */
  arrange?: {
    beatId: GuideArrangeBeatId
    beatNumber: number
    beatTotal: number
    stage: GuideArrangeStage
  }
}

export type GuideCandidateFlow = {
  /** 候选就绪时的当前动作标题。 */
  readyTitle: string
  /** 修改或丢弃后新候选就绪时的标题。 */
  replayTitle: string
  /** 从候选返回后显示的决定标题与提示。 */
  returnedTitle: string
  returnedPrompt: string
  /** 提出修改后、等待新候选时的标题与提示。 */
  revisedTitle: string
  revisedPrompt: string
  /** 修改或丢弃后重新开始生成时的提示。 */
  regeneratingPrompt: string
  /** 丢弃候选后、留在本步等待新候选时的标题与提示。 */
  discardedTitle: string
  discardedPrompt: string
}

export type GuideStep = {
  id: GuideStepId
  number: number
  /** 步骤标题；示例弹窗和独立入口使用。 */
  title: string
  /** 目录中的八行短步骤名；与八步脚本的「步骤名」一致。 */
  catalogLabel: string
  /** 进入本步骤时的当前动作标题。 */
  actionTitle: string
  /** 进入本步骤时的当前动作主文案。 */
  action: string
  /** 下一站提示，用于最后里程碑完成后的过渡说明。 */
  next: string
  /** 看个例子中的固定说明，全部为原创通用示例。 */
  example: string
  milestones: readonly GuideMilestone[]
  /** 只对第 4 步提供：六拍内容；milestones 可由这些拍生成。 */
  arrangeBeats?: readonly GuideArrangeBeat[]
  /** 只对第 7 步为 true。 */
  skippable: boolean
  /** 本步操作完成后仍需用户确认才进入下一步时的按钮文案。 */
  confirmLabel?: string
  /** 确认按钮在步骤签里的最终短文案；不改变 prompt 的确认语义。 */
  confirmActionLabel?: string
  /** 可跳过步骤在步骤签里的按钮文案。 */
  skipLabel?: string
  /** 只对第 8 步提供。 */
  finishLabel?: typeof GUIDE_FINISH_LABEL
  /** 只对第 6 步提供。 */
  candidateFlow?: GuideCandidateFlow
  /** 只对第 5 步提供：生成终止失败时的原位文案。 */
  generationFailure?: { title: string; prompt: string }
  /** 只对第 1 步提供：连接测试失败时的原位文案。 */
  connectionFailure?: { title: string; prompt: string }
  /** 只对第 7 步提供：台词保存失败或待核对时的原位文案。 */
  dialogueSaveFailure?: { title: string; prompt: string }
  /** 只对第 7 步提供：预览里有真实未保存改词时的原位文案；不含对白。 */
  dialogueDraftPrompt?: { title: string; prompt: string }
  /** 只对第 8 步提供：导出未成功时的原位文案。 */
  exportFailure?: { title: string; prompt: string }
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: GUIDE_STEP_ID.configureModel,
    number: 1,
    title: '配置一个模型',
    catalogLabel: '选好生成模型',
    actionTitle: '先接通一个模型',
    action: '打开设置中心的「模型连接」，选好用于生成场景的服务和模型，先保存，再测试连接。',
    next: '保存并测试通过后，在首页新建一个空白工程，并进入它的「当前场景」。',
    example:
      '示例：先把这份配置保存到本机，再测试连接。测试只说明能接通，不会替你保存；两项都完成后工作台才能使用它。',
    milestones: [
      {
        id: 'connection-saved',
        wait: { kind: 'configSaved', bind: 'saved-config' },
        title: '测试一下这份配置',
        prompt: '配置已保存。回到设置中心的「模型连接」，点「测试连接」确认它能用。',
        completion: '配置已保存。'
      },
      {
        id: 'connection-tested',
        wait: { kind: 'configTested', bind: 'saved-config' },
        title: '去新建一个工程',
        prompt: '连接测试通过。下一步在首页点「新建空白画布」，给这场戏留一个位置。',
        completion: '连接测试通过。'
      }
    ],
    connectionFailure: {
      title: '连接还没测通',
      prompt: '按右上角提示修正后再试。'
    },
    skippable: false
  },
  {
    id: GUIDE_STEP_ID.createProject,
    number: 2,
    title: '创建工程项目',
    catalogLabel: '建立工程',
    actionTitle: '给这场戏留一个位置',
    action: '点「新建空白画布」，填写项目名称，选择保存位置，再创建工程。',
    next: '创建成功并进入这个新工程的「当前场景」后，再准备剧本。',
    example:
      '示例：名字可以先用「雨夜小站」，位置选一个空文件夹；建好后从项目页进入它，看到「当前场景」再继续。',
    milestones: [
      {
        id: 'project-created',
        wait: { kind: 'projectCreated' },
        title: '进入这个新工程',
        prompt: '工程已创建。进入这个新工程的工作台，看到「当前场景」后继续。',
        completion: '工程已创建。'
      },
      {
        id: 'project-entered',
        wait: { kind: 'projectEntered', bind: 'created-project' },
        title: '从左侧放入剧本',
        prompt: '已进入新工程的「当前场景」。下一步从左侧导入自己的剧本。',
        completion: '已进入新建工程。'
      }
    ],
    skippable: false
  },
  {
    id: GUIDE_STEP_ID.importScript,
    number: 3,
    title: '导入剧本',
    catalogLabel: '放入剧本',
    actionTitle: '选一段能从头读到尾的戏',
    action: '从文件区选自己的剧本文档。还没有就点「导入文件」。',
    next: '文档卡建好后点「阅读文档」查看正文；返回画布后再配画面和声音。',
    example:
      '示例：一场三分钟的短戏就够——一个人在一个地方做一件事，最后有一句收束。只导入自己写的或已获授权的内容。',
    milestones: [
      {
        id: 'document-imported',
        wait: { kind: 'sourceImported', sourceKind: 'document' },
        title: '把文档拖入画布',
        prompt: '从文件区把这份文档拖到画布。',
        completion: '剧本已导入项目。'
      },
      {
        id: 'document-card-created',
        wait: { kind: 'cardCreated', cardKinds: ['document'] },
        title: '打开文档编辑器',
        prompt: '点击卡片上的「阅读文档」，可以查看和编辑正文。',
        completion: '已打开文档编辑器。'
      },
      {
        id: 'document-read',
        // 打开编辑器不算读完；用户实际点「返回画布」关闭编辑器后才进入下一步。
        wait: { kind: 'documentClosed', bind: 'created-document' },
        title: '去配画面和声音',
        prompt: '已返回画布。下一步给这段戏配画面和声音。',
        completion: '已阅读并选用这份剧本。'
      }
    ],
    skippable: false
  },
  {
    id: GUIDE_STEP_ID.arrangeScene,
    number: 4,
    title: '编排画面与声音',
    catalogLabel: '排出这一场戏',
    actionTitle: '添加场景背景图',
    action: GUIDE_ARRANGE_BACKGROUND_ACTION.drag,
    next: '六拍都安排好并核对后，点「编排好了」进入保存并生成。',
    example:
      '示例：背景用途写「第一句旁白出现时亮出背景，保留到本场结束」；短音效写「角色推门时响一次」。人物表情在开口前或说完后切换，写清楚即可。',
    milestones: ARRANGE_MILESTONES,
    arrangeBeats: GUIDE_ARRANGE_BEATS,
    skippable: false,
    confirmLabel: '编排好了'
  },
  {
    id: GUIDE_STEP_ID.saveAndGenerate,
    number: 5,
    title: '保存并生成',
    catalogLabel: '检查输入并生成',
    actionTitle: '把这版画布存下来',
    action: '点顶栏「保存」。',
    next: '核对后点「开始生成」，等候选就绪再试玩。',
    example: '示例：摘要里应有剧本、背景和你要用的声音；少了哪一项，就回画布补上再保存一次。',
    milestones: [
      {
        id: 'canvas-saved-manually',
        wait: { kind: 'canvasSaved', saveReason: 'manual' },
        title: '核对送去生成的材料',
        prompt: '打开「生成」里的「当前生成」，查看输入摘要。少了素材就回画布补。',
        completion: '画布已保存。'
      },
      {
        id: 'input-summary-opened',
        wait: { kind: 'inputSummaryOpened' },
        title: '材料齐了，再开始生成',
        prompt: '确认摘要是这一场的内容，再点「开始生成」。',
        completion: '输入摘要已打开。'
      },
      {
        id: 'generation-started',
        wait: { kind: 'generationStarted' },
        title: '等候这一版候选',
        prompt: '如果生成页问到演出时机，按剧本回答。',
        completion: '已开始生成。'
      }
    ],
    generationFailure: {
      title: '这一版没生成出来',
      prompt: '看当前生成的错误；修正后从这张画布重试。'
    },
    skippable: false
  },
  {
    id: GUIDE_STEP_ID.playtestCandidate,
    number: 6,
    title: '试玩并决定',
    catalogLabel: '试玩这一版',
    actionTitle: '从头玩一遍',
    action:
      '生成完成后，候选就绪时点「打开游戏候选」，从头玩到结尾，核对台词、素材出现的时机和结尾。',
    next: '接受并提交成功后，可以微调台词，也可以直接导出。',
    example:
      '示例：修改意见可以直接写「第三句旁白的停顿太长，希望说完「走吧」再停半拍，结尾保留雨声」。',
    milestones: [
      {
        id: 'candidate-ready',
        wait: { kind: 'candidateReady', bind: 'generation-operation' },
        title: '从头玩一遍',
        prompt: '收起教程，在生成页点「打开游戏候选」。',
        completion: '候选已就绪。'
      },
      {
        id: 'candidate-accepted',
        wait: { kind: 'candidateAccepted', bind: 'active-candidate' },
        title: '和你想的一样吗？',
        prompt: '满意就点「接受并提交」；不满意就点「提出修改」，告诉它改哪一句。',
        completion: '候选已接受并提交。'
      }
    ],
    skippable: false,
    candidateFlow: {
      readyTitle: '从头玩一遍',
      replayTitle: '再玩一次刚才不对的地方',
      returnedTitle: '和你想的一样吗？',
      returnedPrompt:
        '看看人物是不是在那句对白前换了表情，听听声音有没有早响。满意就点「接受并提交」；不满意就点「提出修改」，告诉它改哪一句。',
      revisedTitle: '正在改这一版',
      revisedPrompt: '已提出修改。等新候选就绪后，再打开从头试玩，确认修改已经体现。',
      regeneratingPrompt: '已重新开始生成。等新候选就绪后，再打开从头试玩。',
      discardedTitle: '这版不用了',
      discardedPrompt: '可以先改画布，也可以重新生成。新候选就绪时再试玩。'
    }
  },
  {
    id: GUIDE_STEP_ID.polishDialogue,
    number: 7,
    title: '微调台词（可跳过）',
    catalogLabel: '改一句，再核对',
    actionTitle: '在试玩预览里改一句',
    action: '点「试玩预览」，在左侧选中一句对白，按铅笔或回车修改。',
    next: '改完点顶部「保存」，这句会写回当前场景；确认后返回工作台导出。',
    example: '示例：把「我等你很久了」改成「我一直在等你」；保存后左侧应显示新句子。',
    milestones: [
      {
        id: 'dialogue-saved',
        wait: { kind: 'dialogueSaved' },
        title: '保存成功，核对新句子',
        prompt: '左侧这句已经是新文字。点「核对过了」，再返回工作台导出。',
        completion: '台词修改已保存。'
      }
    ],
    skippable: true,
    confirmLabel: '已确认改动',
    confirmActionLabel: '核对过了',
    skipLabel: '跳过改词',
    dialogueDraftPrompt: {
      title: '保存这句改动',
      prompt: '改好后点顶部「保存」，把这句写回当前场景。'
    },
    dialogueSaveFailure: {
      title: '这句还不能算存好',
      prompt: '先处理预览里的保存结果。'
    }
  },
  {
    id: GUIDE_STEP_ID.exportBuild,
    number: 8,
    title: '导出并打开成品',
    catalogLabel: '导出成品',
    actionTitle: '导出刚才试玩的场景',
    action: '回到工作台，打开「导出」并开始。',
    next: '导出成功后，从结果通知打开所在文件夹，运行成品读到末句。',
    example: '示例：成品里第二句应是修改后的新句子；如果还是旧句，回到工作台重新保存并导出。',
    milestones: [
      {
        id: 'build-exported',
        wait: { kind: 'exported' },
        title: '去成品里看最后一遍',
        prompt: '从结果通知打开所在文件夹，运行成品，读到末句。若改过对白，也核对那一句。',
        completion: '导出成功。'
      }
    ],
    exportFailure: {
      title: '这次没有导出成功',
      prompt: '按导出页的提示处理。'
    },
    skippable: false,
    finishLabel: GUIDE_FINISH_LABEL
  }
]

export const GUIDE_STEP_IDS: readonly GuideStepId[] = GUIDE_STEPS.map((step) => step.id)

export const GUIDE_FIRST_STEP_ID: GuideStepId = GUIDE_STEPS[0].id
export const GUIDE_LAST_STEP_ID: GuideStepId = GUIDE_STEPS[GUIDE_STEPS.length - 1].id

const guideStepByIdMap: ReadonlyMap<GuideStepId, GuideStep> = new Map(
  GUIDE_STEPS.map((step) => [step.id, step])
)

const guideStepIdSet: ReadonlySet<string> = new Set(GUIDE_STEP_IDS)

export function isGuideStepId(value: unknown): value is GuideStepId {
  return typeof value === 'string' && guideStepIdSet.has(value)
}

export function guideStepById(stepId: GuideStepId): GuideStep {
  const step = guideStepByIdMap.get(stepId)
  if (!step) {
    throw new Error(`未知的新手指引步骤：${stepId}`)
  }
  return step
}

export function guideStepByNumber(stepNumber: number): GuideStep | null {
  return GUIDE_STEPS.find((step) => step.number === stepNumber) ?? null
}

export function guideStepIndex(stepId: GuideStepId): number {
  return GUIDE_STEP_IDS.indexOf(stepId)
}

export function guideNextStep(stepId: GuideStepId): GuideStep | null {
  const index = guideStepIndex(stepId)
  if (index < 0 || index >= GUIDE_STEPS.length - 1) return null
  return GUIDE_STEPS[index + 1]
}

export function guideStepTotal(): number {
  return GUIDE_STEPS.length
}
