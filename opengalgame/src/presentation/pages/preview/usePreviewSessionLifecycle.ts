import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  SceneContentBasisVO,
  ScenePreviewLockState,
  ScenePreviewSessionVO
} from '@application/scene-preview/vo/ScenePreviewSessionVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

import type { PreviewFailureView } from './previewPresentation'
import type { MutableRef } from './usePreviewDraftEditing'

export type PreviewSessionUiState = 'opening' | 'open' | 'failed'

interface UsePreviewSessionLifecycleOptions {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
  readonly availabilityStatus: 'checking' | 'available' | 'blocked' | 'failed'
  readonly initializeDraft: (session: ScenePreviewSessionVO) => void
  readonly resetDraft: () => void
  readonly closeDraft: () => void
  readonly resetStage: () => void
  readonly onSessionOpened: () => void
  readonly onSessionClosed: () => void
  readonly onSessionReset: () => void
}

export interface UsePreviewSessionLifecycleResult {
  readonly sessionState: PreviewSessionUiState
  readonly openFailure: PreviewFailureView | null
  readonly retryOpen: () => void
  readonly reopen: () => Promise<boolean>
  readonly session: ScenePreviewSessionVO | null
  readonly contentBasis: SceneContentBasisVO | null
  readonly lockState: ScenePreviewLockState
  readonly closing: boolean
  readonly closeError: PreviewFailureView | null
  readonly closeSession: () => Promise<boolean>
  readonly sessionRef: MutableRef<ScenePreviewSessionVO | null>
  readonly basisRef: MutableRef<SceneContentBasisVO | null>
  readonly lockRef: MutableRef<ScenePreviewLockState>
  readonly closingRef: MutableRef<boolean>
  readonly replaceBasis: (basis: SceneContentBasisVO) => void
  readonly markLocked: () => void
  readonly syncSessionRef: () => void
  readonly syncLockBasisRefs: () => void
}

export function usePreviewSessionLifecycle({
  client,
  projectId,
  sceneId,
  availabilityStatus,
  initializeDraft,
  resetDraft,
  closeDraft,
  resetStage,
  onSessionOpened,
  onSessionClosed,
  onSessionReset
}: UsePreviewSessionLifecycleOptions): UsePreviewSessionLifecycleResult {
  const [openNonce, setOpenNonce] = useState(0)
  const [sessionState, setSessionState] = useState<PreviewSessionUiState>('opening')
  const [openFailure, setOpenFailure] = useState<PreviewFailureView | null>(null)
  const [session, setSession] = useState<ScenePreviewSessionVO | null>(null)
  const [contentBasis, setContentBasis] = useState<SceneContentBasisVO | null>(null)
  const [lockOverride, setLockOverride] = useState<ScenePreviewLockState | null>(null)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<PreviewFailureView | null>(null)

  const sessionRef = useRef<ScenePreviewSessionVO | null>(null)
  const lockRef = useRef<ScenePreviewLockState>('unknown')
  const basisRef = useRef<SceneContentBasisVO | null>(null)
  const openAttempt = useRef(0)
  const closingRef = useRef(false)
  const collaboratorsRef = useRef({
    initializeDraft,
    resetDraft,
    closeDraft,
    resetStage,
    onSessionOpened,
    onSessionClosed,
    onSessionReset
  })

  useEffect(() => {
    collaboratorsRef.current = {
      initializeDraft,
      resetDraft,
      closeDraft,
      resetStage,
      onSessionOpened,
      onSessionClosed,
      onSessionReset
    }
  })

  const effectiveLock: ScenePreviewLockState = lockOverride ?? session?.lockState ?? 'unknown'

  const replaceBasis = useCallback((basis: SceneContentBasisVO) => {
    basisRef.current = basis
    setContentBasis(basis)
  }, [])

  const markLocked = useCallback(() => {
    lockRef.current = 'locked'
    setLockOverride('locked')
  }, [])

  const syncSessionRef = useCallback(() => {
    sessionRef.current = session
  }, [session])

  const syncLockBasisRefs = useCallback(() => {
    lockRef.current = effectiveLock
    basisRef.current = contentBasis
  }, [contentBasis, effectiveLock])

  const resetLocalSession = useCallback(() => {
    collaboratorsRef.current.onSessionReset()
    sessionRef.current = null
    lockRef.current = 'unknown'
    basisRef.current = null
    collaboratorsRef.current.resetStage()
    collaboratorsRef.current.resetDraft()
    setSession(null)
    setContentBasis(null)
    setLockOverride(null)
    setCloseError(null)
    setOpenFailure(null)
  }, [])

  useEffect(() => {
    if (availabilityStatus !== 'available') return
    if (sessionRef.current !== null) return
    const attempt = ++openAttempt.current
    let cancelled = false
    setSessionState('opening')
    setOpenFailure(null)
    void client
      .openPreview({ projectId, sceneId })
      .then((result) => {
        if (cancelled || attempt !== openAttempt.current) {
          if (result.code === ErrorCodes.success && result.data !== undefined) {
            void client.closePreview({ previewSessionId: result.data.previewSessionId })
          }
          return
        }
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setSessionState('failed')
          setOpenFailure({
            code: null,
            message:
              result.code === ErrorCodes.communicationFailed
                ? '没有联系上本地预览服务，请重试。'
                : '预览没有打开，请重试。',
            recovery: 'retry'
          })
          return
        }
        const opened = result.data
        sessionRef.current = opened
        basisRef.current = opened.contentBasis
        lockRef.current = opened.lockState
        setSession(opened)
        setContentBasis(opened.contentBasis)
        collaboratorsRef.current.initializeDraft(opened)
        collaboratorsRef.current.onSessionOpened()
        setLockOverride(null)
        setCloseError(null)
        setSessionState('open')
      })
      .catch(() => {
        if (cancelled || attempt !== openAttempt.current) return
        setSessionState('failed')
        setOpenFailure({ code: null, message: '预览没有打开，请重试。', recovery: 'retry' })
      })
    return () => {
      cancelled = true
    }
  }, [availabilityStatus, client, openNonce, projectId, sceneId])

  useEffect(() => {
    return () => {
      const opened = sessionRef.current
      sessionRef.current = null
      if (opened !== null) {
        void client.closePreview({ previewSessionId: opened.previewSessionId })
      }
    }
  }, [client])

  const closeSession = useCallback(async (): Promise<boolean> => {
    const opened = sessionRef.current
    if (opened === null) return true
    if (closingRef.current) return false
    closingRef.current = true
    setClosing(true)
    setCloseError(null)
    try {
      const result = await client.closePreview({ previewSessionId: opened.previewSessionId })
      if (result.code !== ErrorCodes.success) {
        setCloseError({ code: null, message: '关闭预览失败，请重试。', recovery: 'retry' })
        return false
      }
      sessionRef.current = null
      collaboratorsRef.current.resetStage()
      setSession(null)
      setContentBasis(null)
      collaboratorsRef.current.closeDraft()
      collaboratorsRef.current.onSessionClosed()
      return true
    } catch {
      setCloseError({ code: null, message: '关闭预览失败，请重试。', recovery: 'retry' })
      return false
    } finally {
      closingRef.current = false
      setClosing(false)
    }
  }, [client])

  const reopen = useCallback(async (): Promise<boolean> => {
    const opened = sessionRef.current
    if (opened !== null) {
      const closed = await closeSession()
      if (!closed) return false
    }
    resetLocalSession()
    setSessionState('opening')
    setOpenNonce((value) => value + 1)
    return true
  }, [closeSession, resetLocalSession])

  const retryOpen = useCallback(() => {
    setSessionState('opening')
    setOpenFailure(null)
    setOpenNonce((value) => value + 1)
  }, [])

  return {
    sessionState,
    openFailure,
    retryOpen,
    reopen,
    session,
    contentBasis,
    lockState: effectiveLock,
    closing,
    closeError,
    closeSession,
    sessionRef,
    basisRef,
    lockRef,
    closingRef,
    replaceBasis,
    markLocked,
    syncSessionRef,
    syncLockBasisRefs
  }
}
