export type PreviewSessionRef = {
  readonly previewSessionId: string
}

export type PreviewSubscriptionRequest = PreviewSessionRef & {
  readonly projectId: string
  readonly sceneId: string
}

export type PreviewDialoguePlaybackDTO = {
  readonly previewSessionId: string
  readonly expectedRuntimeGeneration: number
  readonly dialogueId: string
}
