import { describe, expect, it } from 'vitest'
import {
  GUIDE_ARRANGE_BEAT_ID,
  GUIDE_ARRANGE_BEATS,
  GUIDE_ARRANGE_CARD_KIND,
  GUIDE_ARRANGE_CARD_ROLE,
  GUIDE_FINISH_LABEL,
  GUIDE_FIRST_STEP_ID,
  GUIDE_LAST_STEP_ID,
  GUIDE_STEP_ID,
  GUIDE_STEP_IDS,
  GUIDE_STEPS,
  guideArrangeBeatById,
  guideArrangeBeatTotal,
  guideNextStep,
  guideStepById,
  guideStepByNumber,
  guideStepIndex,
  guideStepTotal,
  type GuideStepId
} from '@presentation/features/beginner-guide/guideSteps'

const EXPECTED_STEP_IDS: readonly GuideStepId[] = [
  'configure-model',
  'create-project',
  'import-script',
  'arrange-scene',
  'save-and-generate',
  'playtest-candidate',
  'polish-dialogue',
  'export-build'
]

describe('新手指引步骤表', () => {
  it('八个步骤使用稳定 id 且按设计顺序编号', () => {
    expect(GUIDE_STEPS).toHaveLength(8)
    expect(guideStepTotal()).toBe(8)
    expect(GUIDE_STEP_IDS).toEqual(EXPECTED_STEP_IDS)
    expect(GUIDE_STEPS.map((step) => step.id)).toEqual(EXPECTED_STEP_IDS)
    expect(GUIDE_STEPS.map((step) => step.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(GUIDE_STEP_ID).toMatchObject({
      configureModel: 'configure-model',
      createProject: 'create-project',
      importScript: 'import-script',
      arrangeScene: 'arrange-scene',
      saveAndGenerate: 'save-and-generate',
      playtestCandidate: 'playtest-candidate',
      polishDialogue: 'polish-dialogue',
      exportBuild: 'export-build'
    })
    expect(GUIDE_FIRST_STEP_ID).toBe('configure-model')
    expect(GUIDE_LAST_STEP_ID).toBe('export-build')
  })

  it('目录八行使用八步脚本的短步骤名', () => {
    expect(GUIDE_STEPS.map((step) => step.catalogLabel)).toEqual([
      '选好生成模型',
      '建立工程',
      '放入剧本',
      '排出这一场戏',
      '检查输入并生成',
      '试玩这一版',
      '改一句，再核对',
      '导出成品'
    ])
    for (const step of GUIDE_STEPS) {
      expect(step.catalogLabel.trim()).not.toBe('')
    }
  })

  it('每一步的标题、动作、下一站和示例都是非空的具体文案', () => {
    for (const step of GUIDE_STEPS) {
      expect(step.title.trim()).not.toBe('')
      expect(step.actionTitle.trim()).not.toBe('')
      expect(step.catalogLabel.trim()).not.toBe('')
      expect(step.action.trim()).not.toBe('')
      expect(step.next.trim()).not.toBe('')
      expect(step.example.trim()).not.toBe('')

      expect(['继续', '下一步', '继续下一步']).not.toContain(step.action.trim())
      expect(step.action.length).toBeGreaterThan(6)
      expect(step.next.length).toBeGreaterThan(10)

      const milestoneIds = step.milestones.map((milestone) => milestone.id)
      expect(new Set(milestoneIds).size).toBe(milestoneIds.length)
      expect(step.milestones.length).toBeGreaterThan(0)

      for (const milestone of step.milestones) {
        expect(milestone.id.trim()).not.toBe('')
        expect(milestone.prompt.trim()).not.toBe('')
        expect(['继续', '下一步']).not.toContain(milestone.prompt.trim())
        expect(milestone.wait.kind.trim()).not.toBe('')
      }
    }
  })

  it('步骤内容与设计的关键动作对应', () => {
    const configure = guideStepById(GUIDE_STEP_ID.configureModel)
    expect(configure.actionTitle).toBe('先接通一个模型')
    expect(configure.milestones.map((milestone) => milestone.wait.kind)).toEqual([
      'configSaved',
      'configTested'
    ])
    expect(configure.milestones[0].title).toBe('测试一下这份配置')
    expect(configure.milestones[0].wait.bind).toBe('saved-config')
    expect(configure.connectionFailure).toEqual({
      title: '连接还没测通',
      prompt: '按右上角提示修正后再试。'
    })

    const createProject = guideStepById(GUIDE_STEP_ID.createProject)
    expect(createProject.actionTitle).toBe('给这场戏留一个位置')
    expect(createProject.milestones[1].wait.bind).toBe('created-project')

    const importScript = guideStepById(GUIDE_STEP_ID.importScript)
    expect(importScript.actionTitle).toBe('选一段能从头读到尾的戏')
    expect(importScript.milestones[0].wait.sourceKind).toBe('document')
    expect(importScript.milestones[1].wait.cardKinds).toEqual(['document'])
    expect(importScript.milestones.map((milestone) => milestone.title)).toEqual([
      '把文档拖入画布',
      '打开文档编辑器',
      '去配画面和声音'
    ])
    expect(importScript.milestones[0].prompt).toBe('从文件区把这份文档拖到画布。')
    expect(importScript.milestones[1].prompt).toBe(
      '点击卡片上的「阅读文档」，可以查看和编辑正文。'
    )
    expect(importScript.milestones[2].wait.kind).toBe('documentClosed')
    expect(importScript.next).toBe(
      '文档卡建好后点「阅读文档」查看正文；返回画布后再配画面和声音。'
    )

    const arrange = guideStepById(GUIDE_STEP_ID.arrangeScene)
    expect(arrange.actionTitle).toBe('添加场景背景图')
    expect(arrange.arrangeBeats).toBe(GUIDE_ARRANGE_BEATS)
    expect(arrange.arrangeBeats?.[0]).toMatchObject({
      title: '添加场景背景图',
      action: '从文件区把场景背景图拖到画布。'
    })
    expect(arrange.arrangeBeats?.map((beat) => beat.id)).toEqual([
      GUIDE_ARRANGE_BEAT_ID.opening,
      GUIDE_ARRANGE_BEAT_ID.cue,
      GUIDE_ARRANGE_BEAT_ID.sceneChange,
      GUIDE_ARRANGE_BEAT_ID.character,
      GUIDE_ARRANGE_BEAT_ID.music,
      GUIDE_ARRANGE_BEAT_ID.ending
    ])
    expect(arrange.arrangeBeats?.map((beat) => beat.number)).toEqual([1, 2, 3, 4, 5, 6])
    expect(guideArrangeBeatTotal()).toBe(6)
    expect(guideArrangeBeatById(GUIDE_ARRANGE_BEAT_ID.character).title).toBe('让人物换个表情')
    expect(GUIDE_ARRANGE_CARD_KIND).toEqual({
      script: 'document',
      opening: 'image',
      cue: 'audio',
      'next-background': 'image',
      'character-before': 'image',
      'character-after': 'image',
      music: 'audio',
      prompt: 'prompt'
    })
    expect(GUIDE_ARRANGE_CARD_ROLE.prompt).toBe('prompt')
    expect(arrange.milestones).toHaveLength(26)
    expect(arrange.milestones[0]).toMatchObject({
      id: 'opening-placed',
      title: '写清背景图用途',
      wait: { kind: 'cardCreated', cardKinds: ['image'], cardRole: 'opening' },
      arrange: { beatId: 'opening', beatNumber: 1, beatTotal: 6, stage: 'place' }
    })
    expect(arrange.milestones[1].title).toBe('连起剧本和背景图')
    expect(arrange.milestones[2]).toMatchObject({
      wait: {
        kind: 'relationCreated',
        relationRoles: ['script', 'opening']
      },
      arrange: { stage: 'connect' }
    })
    expect(arrange.milestones.at(-1)).toMatchObject({
      id: 'prompt-named',
      wait: { kind: 'relationNamed', relationRoles: ['prompt', 'script'] },
      arrange: { beatId: 'ending', beatNumber: 6, beatTotal: 6, stage: 'name' },
      prompt: expect.stringContaining('对照剧本走一遍')
    })

    const saveAndGenerate = guideStepById(GUIDE_STEP_ID.saveAndGenerate)
    expect(saveAndGenerate.actionTitle).toBe('把这版画布存下来')
    expect(saveAndGenerate.milestones[0].wait.saveReason).toBe('manual')
    expect(saveAndGenerate.milestones.map((milestone) => milestone.title)).toEqual([
      '核对送去生成的材料',
      '材料齐了，再开始生成',
      '等候这一版候选'
    ])
    expect(saveAndGenerate.generationFailure).toEqual({
      title: '这一版没生成出来',
      prompt: '看当前生成的错误；修正后从这张画布重试。'
    })

    const playtest = guideStepById(GUIDE_STEP_ID.playtestCandidate)
    expect(playtest.actionTitle).toBe('从头玩一遍')
    expect(playtest.candidateFlow).toBeDefined()
    expect(playtest.candidateFlow?.readyTitle).toBe('从头玩一遍')
    expect(playtest.candidateFlow?.replayTitle).toBe('再玩一次刚才不对的地方')
    expect(playtest.candidateFlow?.returnedTitle).toBe('和你想的一样吗？')
    expect(playtest.candidateFlow?.revisedTitle).toBe('正在改这一版')
    expect(playtest.candidateFlow?.discardedTitle).toBe('这版不用了')
    expect(playtest.candidateFlow?.returnedPrompt).toContain('接受并提交')
    expect(playtest.candidateFlow?.revisedPrompt).toContain('新候选')
    expect(playtest.candidateFlow?.regeneratingPrompt).toContain('重新开始生成')
    expect(playtest.candidateFlow?.discardedPrompt).toContain('重新生成')

    const polish = guideStepById(GUIDE_STEP_ID.polishDialogue)
    expect(polish.actionTitle).toBe('在试玩预览里改一句')
    expect(polish.milestones[0].title).toBe('保存成功，核对新句子')
    expect(polish.skipLabel).toBe('跳过改词')
    expect(polish.confirmActionLabel).toBe('核对过了')
    expect(polish.dialogueSaveFailure).toEqual({
      title: '这句还不能算存好',
      prompt: '先处理预览里的保存结果。'
    })

    const exportBuild = guideStepById(GUIDE_STEP_ID.exportBuild)
    expect(exportBuild.actionTitle).toBe('导出刚才试玩的场景')
    expect(exportBuild.milestones[0].title).toBe('去成品里看最后一遍')
    expect(exportBuild.milestones[0].prompt).toContain('打开所在文件夹')
    expect(exportBuild.exportFailure).toEqual({
      title: '这次没有导出成功',
      prompt: '按导出页的提示处理。'
    })
  })

  it('目录和入口共用步骤标题，只有第 4、7 步需要用户确认后再继续', () => {
    expect(new Set(GUIDE_STEPS.map((step) => step.title)).size).toBe(GUIDE_STEPS.length)
    expect(GUIDE_STEPS.filter((step) => step.confirmLabel).map((step) => step.id)).toEqual([
      'arrange-scene',
      'polish-dialogue'
    ])
    expect(guideStepById(GUIDE_STEP_ID.arrangeScene).confirmLabel).toBe('编排好了')
  })

  it('第 6 步有候选分支，第 7 步可跳过，第 8 步使用结束阅读', () => {
    const playtest = guideStepById(GUIDE_STEP_ID.playtestCandidate)
    expect(playtest.skippable).toBe(false)
    expect(playtest.candidateFlow?.returnedPrompt.length).toBeGreaterThan(20)
    expect(playtest.candidateFlow?.revisedPrompt.length).toBeGreaterThan(20)
    expect(playtest.candidateFlow?.discardedPrompt.length).toBeGreaterThan(20)

    for (const step of GUIDE_STEPS) {
      if (step.id === GUIDE_STEP_ID.polishDialogue) {
        expect(step.skippable).toBe(true)
      } else {
        expect(step.skippable).toBe(false)
      }
    }

    const exportBuild = guideStepById(GUIDE_STEP_ID.exportBuild)
    expect(GUIDE_FINISH_LABEL).toBe('结束阅读')
    expect(exportBuild.finishLabel).toBe(GUIDE_FINISH_LABEL)
    expect(exportBuild.skippable).toBe(false)
    expect(exportBuild.milestones[0].prompt).toContain('打开所在文件夹')
  })

  it('查找、编号、前后步骤和未知 id 行为稳定', () => {
    expect(guideStepIndex('configure-model')).toBe(0)
    expect(guideStepIndex('export-build')).toBe(7)
    expect(guideNextStep('configure-model')?.id).toBe('create-project')
    expect(guideNextStep('playtest-candidate')?.id).toBe('polish-dialogue')
    expect(guideNextStep('export-build')).toBeNull()
    expect(guideStepByNumber(1)?.id).toBe('configure-model')
    expect(guideStepByNumber(8)?.id).toBe('export-build')
    expect(guideStepByNumber(0)).toBeNull()
    expect(guideStepByNumber(9)).toBeNull()
    expect(() => guideStepById('removed-step' as GuideStepId)).toThrow(
      '未知的新手指引步骤：removed-step'
    )
  })
})
