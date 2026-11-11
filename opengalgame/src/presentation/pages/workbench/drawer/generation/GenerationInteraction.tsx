import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  Gamepad2,
  LoaderCircle,
  PencilLine,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { ReactElement } from 'react'

import type {
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  Question,
  QuestionActions,
  QuestionDescription,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  QuestionSubmit
} from '@presentation/components/ai-elements/question'
import { Button } from '@presentation/components/ui/button'
import { useCandidatePreviewTab } from '../candidate/candidatePreviewContext'
import { candidateEntryHintOf, candidatePreviewTargetOf } from '../candidate/candidatePreviewState'
import {
  acceptBlockedReasonOf,
  canAccept,
  canDiscard,
  canRevise,
  canSelectOption,
  canSendBody,
  interactionIsLive,
  primaryReplyLabel,
  replyBodyLimit,
  reviewNoticeOf,
  type GenerationDraft
} from './generationPresentation'
import { GenerationQuestionGroup } from './GenerationQuestionGroup'

interface GenerationInteractionProps {
  status: SceneGenerationRenderStatusVO
  interaction: SceneGenerationRenderInteractionVO
  draft: GenerationDraft
  pending: boolean
  error: string | null
  reviseOpen: boolean
  onOpenRevise: () => void
  onSelectOption: (optionId: string | null) => void
  onSelectAnswer: (questionId: string, optionId: string | null) => void
  onAnswerBodyChange: (questionId: string, body: string) => void
  onBodyChange: (body: string) => void
  onSubmitPrimary: () => void
  onAccept: () => void
  onDiscard: () => void
}

/**
 * 一次生成里的当前交互。单题、选项数量以后端为准；决策和补充用同一份 `Question`
 * 表单，审阅动作只按能力布尔显示。审阅候选通过抽屉的“游戏候选”标签查看，
 * 那里不承载编辑、提交或导出。
 */
export function GenerationInteraction({
  status,
  interaction,
  draft,
  pending,
  error,
  reviseOpen,
  onOpenRevise,
  onSelectOption,
  onSelectAnswer,
  onAnswerBodyChange,
  onBodyChange,
  onSubmitPrimary,
  onAccept,
  onDiscard
}: GenerationInteractionProps): ReactElement {
  const live = interactionIsLive(status, interaction.interactionId)
  const locked = !live || pending
  const hasOptions = canSelectOption(interaction)
  const bodyAllowed = canSendBody(interaction)
  const isQuestion = interaction.kind === 'decision' || interaction.kind === 'clarification'
  const hasQuestionGroup = Boolean(interaction.questions?.length)
  const bodyLength = draft.body.length
  const candidateTab = useCandidatePreviewTab()
  const candidateTarget = candidatePreviewTargetOf(status)
  const candidateAvailable = candidateTarget !== null && candidateTab !== null
  // 控制器可能还停留在上一候选；只有身份与当前目标完全一致时才消费读取事实和入口说明。
  const candidateControllerMatches =
    candidateTarget !== null &&
    candidateTab !== null &&
    candidateTab.state.projectId === candidateTarget.projectId &&
    candidateTab.state.sceneId === candidateTarget.sceneId &&
    candidateTab.state.candidateSnapshotId === candidateTarget.candidateSnapshotId
  const review = interaction.kind === 'review' ? reviewNoticeOf(status, interaction) : null
  // 降级候选或还有未解决可修正问题的候选不能直接提交，先给出可执行的下一步。
  const acceptBlockedReason =
    interaction.kind === 'review' ? acceptBlockedReasonOf(status, interaction) : null
  const knownIssues = status.knownIssues ?? []
  // 校验问题已经出现在交互说明里时不再重复；读取问题另取候选会话的真实结果。
  const knownIssueMessages = knownIssues.map((issue) => issue.message)
  const reviewNotes = (review?.issues ?? []).filter((line) => !knownIssueMessages.includes(line))
  const candidateRead =
    candidateControllerMatches && candidateTab ? candidateTab.state.read : 'idle'
  // 读取结果只在控制器仍对应当前候选时展示，避免候选切换的同一帧带出上一候选的问题。
  const readIssues =
    candidateControllerMatches && candidateTab && candidateRead === 'ready'
      ? candidateTab.state.issues
      : []
  const candidateEntryHint =
    candidateControllerMatches && candidateTab
      ? candidateEntryHintOf(candidateTab.phase, candidateTab.state.openingStalled)
      : '打开只读游戏候选'

  return (
    <div className={isQuestion ? 'wb-gen-interaction' : 'wb-gen-interaction is-actions'}>
      {hasQuestionGroup ? (
        <GenerationQuestionGroup
          draft={draft}
          interaction={interaction}
          key={interaction.interactionId}
          locked={locked}
          onAnswerBodyChange={onAnswerBodyChange}
          onSelectAnswer={onSelectAnswer}
          onSubmitPrimary={onSubmitPrimary}
          pending={pending}
        />
      ) : isQuestion ? (
        <Question
          aria-label={interaction.question ?? interaction.message}
          className="wb-gen-question"
          disabled={locked}
          onValueChange={(value) => {
            onSelectOption(value.selectedValues[0] ?? null)
            onBodyChange(value.text)
          }}
          selectionMode="single"
          value={{ selectedValues: draft.optionId ? [draft.optionId] : [], text: draft.body }}
        >
          <div className="wb-gen-question__head">
            {interaction.question ? (
              <QuestionPrompt className="wb-gen-question__prompt">
                {interaction.question}
              </QuestionPrompt>
            ) : null}
            <p className="wb-gen-question__lead">{interaction.message}</p>
            {interaction.detail ? (
              <QuestionDescription className="wb-gen-question__detail">
                {interaction.detail}
              </QuestionDescription>
            ) : null}
          </div>

          {hasOptions ? (
            <QuestionOptions aria-label="可选回复" className="wb-gen-question__options">
              {interaction.options.map((option) => {
                const selected = draft.optionId === option.id
                return (
                  <QuestionOption
                    className={selected ? 'wb-gen-option is-selected' : 'wb-gen-option'}
                    key={option.id}
                    value={option.id}
                    variant="ghost"
                  >
                    <span aria-hidden="true" className="wb-gen-option__radio">
                      <i />
                    </span>
                    <span className="wb-gen-option__copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </QuestionOption>
                )
              })}
            </QuestionOptions>
          ) : null}

          <div className="wb-gen-question__footer">
            {bodyAllowed ? (
              <QuestionInput
                className="wb-gen-question__input"
                maxLength={replyBodyLimit}
                placeholder={
                  interaction.kind === 'decision' ? '补充你的判断（可选）' : '写下你的补充（可选）'
                }
              />
            ) : null}
            <QuestionActions className="wb-gen-question__actions">
              <span className="wb-gen-question__hint">
                {hasOptions ? '选择一项或写下判断' : '写下判断后提交'}
                {bodyLength > replyBodyLimit - 200 ? ` · ${bodyLength}/${replyBodyLimit}` : ''}
              </span>
              <QuestionSubmit
                className="wb-gen-primary"
                disabled={locked || (interaction.kind === 'decision' && !draft.optionId)}
                onClick={(event) => {
                  event.preventDefault()
                  onSubmitPrimary()
                }}
              >
                {pending ? '正在提交…' : primaryReplyLabel(interaction)}
                {pending ? null : <ArrowRight />}
              </QuestionSubmit>
            </QuestionActions>
          </div>
        </Question>
      ) : null}

      {interaction.kind === 'review' ? (
        <div className="wb-gen-review">
          <p className="wb-gen-review__lead">{review?.lead ?? interaction.message}</p>
          {review?.notice ? <p className="wb-gen-review__notice">{review.notice}</p> : null}
          {reviewNotes.map((note) => (
            <p className="wb-gen-review__detail" key={note}>
              {note}
            </p>
          ))}
          {interaction.detail ? (
            <p className="wb-gen-review__detail">{interaction.detail}</p>
          ) : null}

          {candidateTab ? (
            <ul aria-label="候选状态" className="wb-gen-review__facts">
              <li className="wb-gen-pill" data-tone={candidateAvailable ? 'done' : 'muted'}>
                {candidateAvailable ? (
                  <Check aria-hidden="true" />
                ) : (
                  <CircleAlert aria-hidden="true" />
                )}
                {candidateAvailable ? '候选可只读查看' : '候选暂时不能只读查看'}
              </li>
              {knownIssues.length > 0 ? (
                <li className="wb-gen-pill" data-tone="wait">
                  <TriangleAlert aria-hidden="true" />
                  {`校验发现 ${knownIssues.length} 条问题`}
                </li>
              ) : status.previewAvailable ? (
                <li className="wb-gen-pill" data-tone="done">
                  <Check aria-hidden="true" />
                  校验通过
                </li>
              ) : null}
              {candidateAvailable && candidateRead === 'loading' ? (
                <li className="wb-gen-pill" data-tone="live">
                  <LoaderCircle aria-hidden="true" />
                  正在读取候选
                </li>
              ) : null}
              {candidateAvailable && candidateRead === 'ready' ? (
                readIssues.length > 0 ? (
                  <li className="wb-gen-pill" data-tone="wait">
                    <TriangleAlert aria-hidden="true" />
                    {`读取发现 ${readIssues.length} 个问题`}
                  </li>
                ) : (
                  <li className="wb-gen-pill" data-tone="done">
                    <Check aria-hidden="true" />
                    读取完成，没有发现问题
                  </li>
                )
              ) : null}
              {candidateAvailable && candidateRead === 'failed' ? (
                <li className="wb-gen-pill" data-tone="danger">
                  <CircleAlert aria-hidden="true" />
                  候选读取失败
                </li>
              ) : null}
            </ul>
          ) : null}

          {knownIssues.length > 0 ? (
            <>
              <p className="wb-gen-review__subhead">校验问题</p>
              <ul aria-label="候选校验问题" className="wb-gen-issues">
                {knownIssues.map((issue) => (
                  <li
                    key={
                      issue.sequence === undefined ? issue.code : `${issue.code}:${issue.sequence}`
                    }
                  >
                    {issue.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {readIssues.length > 0 ? (
            <>
              <p className="wb-gen-review__subhead">读取问题</p>
              <ul aria-label="候选读取问题" className="wb-gen-issues">
                {readIssues.map((issue, index) => (
                  <li key={`${issue.message}:${index}`}>
                    {issue.message}
                    {issue.assetName ? ` · 素材 ${issue.assetName}` : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {candidateAvailable && candidateTab ? (
            <button
              className="wb-gen-candidate-entry"
              onClick={() => candidateTab.activate()}
              type="button"
            >
              <span aria-hidden="true" className="wb-gen-candidate-entry__icon">
                <Gamepad2 />
              </span>
              <span className="wb-gen-candidate-entry__copy">
                <strong>打开游戏候选</strong>
                <small>{candidateEntryHint}</small>
              </span>
              <ArrowUpRight aria-hidden="true" className="wb-gen-candidate-entry__arrow" />
            </button>
          ) : null}
          {acceptBlockedReason ? (
            <p className="wb-gen-review__hint">{acceptBlockedReason}</p>
          ) : null}
          <div className="wb-gen-review__actions">
            {canAccept(status, interaction) ? (
              <Button className="wb-gen-primary" disabled={locked} onClick={onAccept} type="button">
                <Check />
                {pending ? '正在提交…' : '接受并提交'}
              </Button>
            ) : null}
            {canRevise(interaction) ? (
              <Button
                className="wb-gen-secondary"
                disabled={locked}
                onClick={onOpenRevise}
                type="button"
              >
                <PencilLine />
                提出修改
              </Button>
            ) : null}
            {canDiscard(interaction) ? (
              <Button
                className="wb-gen-quiet wb-gen-review__discard"
                disabled={locked}
                onClick={onDiscard}
                type="button"
              >
                <Trash2 />
                丢弃候选
              </Button>
            ) : null}
          </div>
          {reviseOpen && canRevise(interaction) ? (
            <p className="wb-gen-review__hint">
              在下方输入修改要求，提交后会重新生成并再次等待你接受。
            </p>
          ) : null}
        </div>
      ) : null}

      {interaction.kind === 'correction' ? (
        <div className="wb-gen-review">
          <p className="wb-gen-review__lead">{interaction.message}</p>
          {interaction.detail ? (
            <p className="wb-gen-review__detail">{interaction.detail}</p>
          ) : null}
          <p className="wb-gen-review__hint">
            在下方输入修改要求并提交，AI 会按这次修改重新生成候选。
          </p>
          {canDiscard(interaction) ? (
            <div className="wb-gen-review__actions">
              <Button
                className="wb-gen-quiet wb-gen-review__discard"
                disabled={locked}
                onClick={onDiscard}
                type="button"
              >
                <Trash2 />
                丢弃这次候选
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="wb-gen-interaction__error" role="alert">
          <CircleAlert />
          {error}
        </p>
      ) : null}
    </div>
  )
}
