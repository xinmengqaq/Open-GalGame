import { useCallback, useState } from 'react'

import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'

import { effectiveDraft, emptyDraft, type GenerationDraft } from './generationPresentation'

export type MutableRef<T> = { current: T }

interface UseGenerationDraftOptions {
  readonly statusRef: MutableRef<SceneGenerationRenderStatusVO | null>
}

export interface UseGenerationDraftResult {
  readonly draftState: GenerationDraft
  readonly reset: () => void
  readonly selectOption: (optionId: string | null) => void
  readonly selectAnswer: (questionId: string, optionId: string | null) => void
  readonly setAnswerBody: (questionId: string, body: string) => void
  readonly setBody: (body: string) => void
}

export function useGenerationDraft({
  statusRef
}: UseGenerationDraftOptions): UseGenerationDraftResult {
  const [draftState, setDraftState] = useState<GenerationDraft>(emptyDraft)

  const reset = useCallback(() => {
    setDraftState(emptyDraft)
  }, [])

  const selectOption = useCallback(
    (optionId: string | null): void => {
      const interaction = statusRef.current?.interaction
      if (!interaction) return
      setDraftState((previous) => ({ ...effectiveDraft(interaction, previous), optionId }))
    },
    []
  )

  const setBody = useCallback(
    (body: string): void => {
      const interaction = statusRef.current?.interaction
      if (!interaction) return
      setDraftState((previous) => ({ ...effectiveDraft(interaction, previous), body }))
    },
    []
  )

  const selectAnswer = useCallback(
    (questionId: string, optionId: string | null): void => {
      const interaction = statusRef.current?.interaction
      const question = interaction?.questions?.find((item) => item.questionId === questionId)
      if (!interaction || !question) return
      if (optionId !== null && !question.options.some((option) => option.id === optionId)) return
      setDraftState((previous) => {
        const current = effectiveDraft(interaction, previous)
        const answer = current.answers[questionId] ?? { optionId: null, body: '' }
        return {
          ...current,
          answers: { ...current.answers, [questionId]: { ...answer, optionId } }
        }
      })
    },
    []
  )

  const setAnswerBody = useCallback(
    (questionId: string, body: string): void => {
      const interaction = statusRef.current?.interaction
      if (!interaction?.questions?.some((question) => question.questionId === questionId)) return
      setDraftState((previous) => {
        const current = effectiveDraft(interaction, previous)
        const answer = current.answers[questionId] ?? { optionId: null, body: '' }
        return {
          ...current,
          answers: { ...current.answers, [questionId]: { ...answer, body } }
        }
      })
    },
    []
  )

  return {
    draftState,
    reset,
    selectOption,
    selectAnswer,
    setAnswerBody,
    setBody
  }
}
