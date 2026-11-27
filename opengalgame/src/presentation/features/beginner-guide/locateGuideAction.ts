import type { GuideArrangeView, GuideSessionState } from './advanceGuide'
import { GUIDE_STEP_ID } from './guideSteps'

/** Resolve only rendered, actionable controls. This projection never dispatches facts. */
export function locateGuideAction(
  state: GuideSessionState,
  beat: GuideArrangeView | null
): HTMLElement[] {
  if (state.status !== 'following') return []
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][data-state="open"]')
  )
  const root = dialogs.at(-1) ?? document
  const all = (selector: string) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
      (node) =>
        !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
        !node.matches(':disabled') &&
        node.getClientRects().length > 0
    )
  const first = (...selectors: string[]) => {
    for (const selector of selectors) {
      const node = all(selector)[0]
      if (node) return [node]
    }
    return []
  }
  const target = (key: string) => '[data-guide-target="' + key + '"]'
  const field = (selector: string) => first(selector)[0] as HTMLInputElement | undefined
  const empty = (selector: string) => {
    const el = field(selector)
    return el !== undefined && !el.value?.trim()
  }
  const index = state.milestoneIndex
  const card = (id: string) => '.react-flow__node[data-id="' + CSS.escape(id) + '"]'
  const port = (id: string, side: string) => '[data-port-key="' + CSS.escape(id + ':' + side) + '"]'
  const place = (kind: string) => {
    const source =
      '[data-content-kind="' +
      kind +
      '"][draggable="true"]' +
      (kind === 'text' ? '[data-text-kind="document"]' : '')
    const rows = all(source)
    // 只标要拖的来源行。整块画布不参与高亮：画布边框会被误读成横线或分隔线。
    return rows.length ? rows : first(target('file-import'))
  }
  const current = '[data-tab="current"] [role="tab"]'
  const generate = '[data-action="generate"]'
  const more = '[aria-label="更多全局动作"]'
  if (state.prompt.confirmLabel) return first(target('guide-confirm'))
  switch (state.stepId) {
    case GUIDE_STEP_ID.configureModel:
      if (index) return first(target('model-test'), target('model-reload'), target('model-open'))
      if (empty('#base-url')) return first('#base-url')
      if (empty('#model-id')) return first('#model-id')
      if (empty('#api-key') && field('#api-key')?.dataset.saved !== 'true') return first('#api-key')
      return [
        ...first(target('model-save'), target('model-open')),
        ...first(target('guide-skip-model'))
      ]
    case GUIDE_STEP_ID.createProject:
      if (index) {
        return state.createdProjectId
          ? first(
              '[data-testid="project-card"][data-project-id="' +
                CSS.escape(state.createdProjectId) +
                '"]'
            )
          : []
      }
      if (empty('#project-name')) return first('#project-name')
      if (empty('#project-save-location')) return first(target('project-folder'))
      return first(
        target('project-submit'),
        target('project-retry'),
        target('project-rebuild'),
        '[data-testid="new-project-card"]',
        target('project-create'),
        target('projects-open')
      )
    case GUIDE_STEP_ID.importScript: {
      // 编辑器打开时只标可见的「返回画布」，不圈被盖住的画布卡片。
      if (state.documentEditorCardId) return first(target('document-back'))
      if (state.documentCardId) {
        return first(
          card(state.documentCardId) + ' [data-card-surface="frame"]',
          card(state.documentCardId)
        )
      }
      const documentRows = all(
        '[data-content-kind="text"][draggable="true"][data-text-kind="document"]'
      )
      // 只标文件区里的文档行；拖放目标是整块画布，圈画布会被误读成一条边线。
      return documentRows.length > 0 ? documentRows : first(target('file-import'))
    }
    case GUIDE_STEP_ID.arrangeScene: {
      if (!beat || beat.complete) return []
      const id = beat.cardRole && state.arrangeCards[beat.cardRole]
      if (beat.stage === 'place') {
        if (!beat.cardKind) return []
        const existing = all(
          '.react-flow__node:has([data-card-kind="' + beat.cardKind + '"])'
        ).filter(
          (n) =>
            n.dataset.id !== undefined && !Object.values(state.arrangeCards).includes(n.dataset.id)
        )
        return [
          ...existing,
          ...(beat.cardKind === 'prompt'
            ? first('[aria-label="添加提示词卡"]')
            : place(beat.cardKind))
        ]
      }
      if (beat.stage === 'usage' && id) {
        if (field('#edit-card-summary')?.dataset.cardId === id)
          return empty('#edit-card-summary')
            ? first('#edit-card-summary')
            : first(target('usage-apply'))
        // 标整张卡，不标文件名或用途文字内层；内层描边会像一条悬空下划线。
        return first(card(id) + ' [data-card-surface="frame"]', card(id))
      }
      if (beat.stage === 'connect' && beat.relationRoles) {
        const [a, b] = beat.relationRoles.map((role) => state.arrangeCards[role])
        if (!a || !b) return []
        const ends = [...first(port(a, 'right')), ...first(port(b, 'left'))]
        return ends.length === 2 ? ends : []
      }
      if (beat.stage === 'name' && beat.relationId) {
        if (field('#relation-name')?.dataset.relationId === beat.relationId)
          return empty('#relation-name')
            ? first('#relation-name')
            : first('[form="relation-name-form"]')
        return first('[data-anchor-id="' + CSS.escape(beat.relationId) + '"]')
      }
      return []
    }
    case GUIDE_STEP_ID.saveAndGenerate:
      if (state.generationRunState === 'running') return []
      return index === 0
        ? first(target('canvas-save'))
        : index === 1
          ? first(
              target('generation-summary'),
              '[data-tab="summary"] [role="tab"]',
              current,
              generate,
              more
            )
          : first(target('generation-start'), current, generate, more)
    case GUIDE_STEP_ID.playtestCandidate:
      if (state.candidatePhase === 'ready')
        return first(
          target('candidate-open'),
          '[data-tab="candidate"] [role="tab"]',
          current,
          generate,
          more
        )
      if (state.candidatePhase === 'discarded')
        return first(target('generation-start'), current, generate, more)
      if (state.candidatePhase !== 'returned') return []
      if (field('[aria-label="修改要求"]'))
        return empty('[aria-label="修改要求"]')
          ? first('[aria-label="修改要求"]')
          : first('[aria-label="提交修改"]')
      return all(target('candidate-accept') + ',' + target('candidate-revise')).length
        ? all(target('candidate-accept') + ',' + target('candidate-revise'))
        : first(current, generate)
    case GUIDE_STEP_ID.polishDialogue:
      if (document.querySelector('[data-testid="preview-page"]')) {
        if (state.dialogueSaveUnresolved)
          return first(
            '[data-testid="preview-dialogue-list"] [role="alert"] button',
            '[data-testid="preview-dialogue-list"] [role="status"] button'
          )
        if (state.dialogueDraftDirty) return first(target('dialogue-save'))
        return first(
          '[data-guide-target="dialogue-editor"]',
          '[data-dialogue-id][data-selected="true"] [data-guide-target="dialogue-row"]',
          '[data-guide-target="dialogue-row"]',
          '[data-dialogue-id][data-selected="true"] [data-guide-target="dialogue-edit"]',
          '[data-guide-target="dialogue-edit"]',
          target('preview-return')
        )
      }
      return [...first('[data-action="preview"]', more), ...first(target('guide-skip'))]
    case GUIDE_STEP_ID.exportBuild:
      // 预览里的返回按钮由 useGuideReturnPulse 单独做一次性脉冲与静态光环，
      // 这里不再叠加通用标记，避免两套内联样式互相还原。
      if (document.querySelector('[data-testid="preview-page"]')) return []
      return first(
        target('export-confirm'),
        '[data-testid="scene-export-choose"]',
        target('export-open'),
        '[data-action="export"]',
        more
      )
  }
}
