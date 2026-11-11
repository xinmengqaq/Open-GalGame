import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { useState, type ReactElement } from 'react'

import type { SceneGenerationRenderInteractionVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
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
import { buildPrimaryReply, replyBodyLimit, type GenerationDraft } from './generationPresentation'

interface GenerationQuestionGroupProps {
  interaction: SceneGenerationRenderInteractionVO
  draft: GenerationDraft
  pending: boolean
  locked: boolean
  onSelectAnswer: (questionId: string, optionId: string | null) => void
  onAnswerBodyChange: (questionId: string, body: string) => void
  onSubmitPrimary: () => void
}

/**
 * 一组 1～4 题只显示当前题。分页留在组件内，各题答案留在页面草稿。
 */
export function GenerationQuestionGroup({
  interaction,
  draft,
  pending,
  locked,
  onSelectAnswer,
  onAnswerBodyChange,
  onSubmitPrimary
}: GenerationQuestionGroupProps): ReactElement | null {
  const questions = interaction.questions ?? []
  const [index, setIndex] = useState(0)
  const currentIndex = Math.min(index, Math.max(questions.length - 1, 0))
  const question = questions[currentIndex]
  if (!question) return null
  const answer = draft.answers[question.questionId] ?? { optionId: null, body: '' }
  const answered = questions.filter((item) => {
    const selected = draft.answers[item.questionId]?.optionId
    return item.options.some((option) => option.id === selected)
  }).length
  const complete = buildPrimaryReply(interaction, draft) !== null
  const bodyLength = answer.body.length

  return (
    <Question
      aria-label={question.prompt}
      className="wb-gen-question"
      disabled={locked}
      onValueChange={(value) => {
        onSelectAnswer(question.questionId, value.selectedValues[0] ?? null)
        onAnswerBodyChange(question.questionId, value.text)
      }}
      selectionMode="single"
      value={{ selectedValues: answer.optionId ? [answer.optionId] : [], text: answer.body }}
    >
      <div className="wb-gen-question__head">
        <div className="wb-gen-question__progress">
          <span>
            第 {currentIndex + 1} / {questions.length} 题
          </span>
          <span>
            已答 {answered} / {questions.length}
          </span>
        </div>
        <QuestionPrompt className="wb-gen-question__prompt">{question.prompt}</QuestionPrompt>
        {question.detail ? (
          <QuestionDescription className="wb-gen-question__detail">
            {question.detail}
          </QuestionDescription>
        ) : null}
      </div>

      <QuestionOptions aria-label="当前题的选项" className="wb-gen-question__options">
        {question.options.map((option) => {
          const selected = answer.optionId === option.id
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

      <div className="wb-gen-question__footer">
        <QuestionInput
          className="wb-gen-question__input"
          maxLength={replyBodyLimit}
          placeholder="补充这一题的判断（可选）"
        />
        <QuestionActions className="wb-gen-question__actions">
          {questions.length > 1 ? (
            <div className="wb-gen-question__pager">
              <Button
                className="wb-gen-quiet"
                disabled={locked || currentIndex === 0}
                onClick={() => setIndex(currentIndex - 1)}
                type="button"
              >
                <ArrowLeft />
                上一题
              </Button>
              <Button
                className="wb-gen-quiet"
                disabled={locked || currentIndex === questions.length - 1}
                onClick={() => setIndex(currentIndex + 1)}
                type="button"
              >
                下一题
                <ArrowRight />
              </Button>
            </div>
          ) : null}
          <span className="wb-gen-question__hint">
            {complete ? '全部题目已选择' : '答完全部题目后才能继续'}
            {bodyLength > replyBodyLimit - 200 ? ` · ${bodyLength}/${replyBodyLimit}` : ''}
          </span>
          <QuestionSubmit
            className="wb-gen-primary"
            disabled={locked || !complete}
            onClick={(event) => {
              event.preventDefault()
              onSubmitPrimary()
            }}
          >
            {pending ? '正在提交…' : '提交全部回答并继续'}
            {pending ? null : <Check />}
          </QuestionSubmit>
        </QuestionActions>
      </div>
    </Question>
  )
}
