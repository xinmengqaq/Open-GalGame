import { useCallback, useEffect, useRef, useState } from 'react'

import type { UpdateFailureVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { AppUpdateClient } from '@interfaces/app-update/client/AppUpdateClient'

const BACKGROUND_CHECK_DELAY_MS = 8000

export interface AppUpdateErrorNotice {
  title: string
  message: string
  showManualDownload: boolean
  retryable: boolean
}

export interface AppUpdateFlow {
  status: UpdateStatusVO | null
  checked: boolean
  initializing: boolean
  settingsOpen: boolean
  error: AppUpdateErrorNotice | null
  openSettings(): void
  closeSettings(): void
  check(): Promise<void>
  download(): Promise<void>
  install(): Promise<void>
  retry(): Promise<void>
  dismissError(): void
}

function failureNoticeForCode(code: number, message: string, title: string): AppUpdateErrorNotice {
  const unsupported = code === ErrorCodes.invalidConfig
  return {
    title: code === ErrorCodes.operationConflict ? '更新正在进行' : title,
    message: message.trim() === '' ? '更新操作没有完成，请稍后重试' : message,
    showManualDownload: !unsupported && code !== ErrorCodes.operationConflict,
    retryable: !unsupported
  }
}

function failureMessageForKind(kind: UpdateFailureVO['kind']): string {
  switch (kind) {
    case 'download-failed':
      return '下载没有完成，请重试或手动下载安装包。'
    case 'install-failed':
      return '安装没有完成，请重试或手动下载安装包。'
    case 'source-unavailable':
      return '暂时无法连接更新源，请检查网络后重试。'
    case 'unsupported':
      return '当前运行方式不支持应用内更新，可以手动下载安装版。'
    case 'invalid-state':
      return '更新状态已经变化，请重新检查更新。'
  }
}

function failureNoticeFromPush(
  phase: 'downloading' | 'installing',
  failure: UpdateFailureVO
): AppUpdateErrorNotice {
  const retryableKind = failure.kind !== 'unsupported' && failure.kind !== 'invalid-state'
  return {
    title: phase === 'downloading' ? '更新下载失败' : '更新安装失败',
    message: failureMessageForKind(failure.kind),
    showManualDownload: retryableKind,
    retryable: failure.kind !== 'unsupported'
  }
}

async function settleRequest<T>(request: Promise<AjaxResult<T>>): Promise<AjaxResult<T>> {
  try {
    return await request
  } catch {
    return { code: ErrorCodes.communicationFailed, msg: '无法连接更新服务，操作结果待确认' }
  }
}

export function useAppUpdate(client: AppUpdateClient): AppUpdateFlow {
  const [status, setStatus] = useState<UpdateStatusVO | null>(null)
  const [checked, setChecked] = useState(false)
  const [initializing, setInitializing] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [error, setError] = useState<AppUpdateErrorNotice | null>(null)
  const [awaitingInitialAcknowledgement, setAwaitingInitialAcknowledgement] = useState(false)

  const statusRef = useRef<UpdateStatusVO | null>(null)
  const pushSeqRef = useRef(0)
  const presentedFailureSeqRef = useRef(0)
  const backgroundStartedRef = useRef(false)
  const backgroundFailureShownRef = useRef(false)
  const checkAttemptedRef = useRef(false)
  const initialFailurePendingRef = useRef(false)
  const downloadInFlightRef = useRef(false)
  const installInFlightRef = useRef(false)

  const markChecked = useCallback((): void => {
    setChecked(true)
  }, [])

  const presentFailure = useCallback((notice: AppUpdateErrorNotice): void => {
    presentedFailureSeqRef.current += 1
    setError(notice)
  }, [])

  const acknowledgeInitialFailure = useCallback((): void => {
    if (!initialFailurePendingRef.current) return
    initialFailurePendingRef.current = false
    setAwaitingInitialAcknowledgement(false)
  }, [])

  const applyStatus = useCallback((next: UpdateStatusVO): void => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const checkInternal = useCallback(
    async (reason: 'manual' | 'background'): Promise<boolean> => {
      checkAttemptedRef.current = true
      const presentedBefore = presentedFailureSeqRef.current
      const pushSeqBefore = pushSeqRef.current
      const result = await settleRequest(client.checkForUpdate({ reason }))

      if (result.code === ErrorCodes.success && result.data !== undefined) {
        if (pushSeqRef.current === pushSeqBefore) {
          const current = statusRef.current
          applyStatus({
            phase: result.data.phase,
            currentVersion: result.data.currentVersion,
            supported: current?.supported ?? true,
            ...(result.data.release === undefined ? {} : { release: result.data.release })
          })
        }
        markChecked()
        acknowledgeInitialFailure()
        return true
      }

      const mayPresent = reason === 'manual' || !backgroundFailureShownRef.current
      if (mayPresent && presentedFailureSeqRef.current === presentedBefore) {
        if (reason === 'background') backgroundFailureShownRef.current = true
        presentFailure(failureNoticeForCode(result.code, result.msg, '检查更新失败'))
      }
      return false
    },
    [acknowledgeInitialFailure, applyStatus, client, markChecked, presentFailure]
  )

  const downloadInternal = useCallback(async (): Promise<void> => {
    if (downloadInFlightRef.current) return
    if (statusRef.current?.phase !== 'available') return
    downloadInFlightRef.current = true
    try {
      const presentedBefore = presentedFailureSeqRef.current
      const pushSeqBefore = pushSeqRef.current
      const result = await settleRequest(client.downloadUpdate({}))

      if (result.code === ErrorCodes.success && result.data !== undefined) {
        if (pushSeqRef.current === pushSeqBefore) applyStatus(result.data)
        return
      }
      if (presentedFailureSeqRef.current === presentedBefore) {
        presentFailure(failureNoticeForCode(result.code, result.msg, '更新下载失败'))
      }
    } finally {
      downloadInFlightRef.current = false
    }
  }, [applyStatus, client, presentFailure])

  const installInternal = useCallback(async (): Promise<void> => {
    if (installInFlightRef.current) return
    if (statusRef.current?.phase !== 'downloaded') return
    installInFlightRef.current = true
    try {
      const presentedBefore = presentedFailureSeqRef.current
      const result = await settleRequest(client.installUpdate({}))

      if (result.code === ErrorCodes.success) return
      if (presentedFailureSeqRef.current === presentedBefore) {
        presentFailure(failureNoticeForCode(result.code, result.msg, '更新安装失败'))
      }
    } finally {
      installInFlightRef.current = false
    }
  }, [client, presentFailure])

  const check = useCallback(async (): Promise<void> => {
    acknowledgeInitialFailure()
    setError(null)
    await checkInternal('manual')
  }, [acknowledgeInitialFailure, checkInternal])

  const download = useCallback(async (): Promise<void> => {
    acknowledgeInitialFailure()
    setError(null)
    await downloadInternal()
  }, [acknowledgeInitialFailure, downloadInternal])

  const install = useCallback(async (): Promise<void> => {
    acknowledgeInitialFailure()
    setError(null)
    await installInternal()
  }, [acknowledgeInitialFailure, installInternal])

  const retry = useCallback(async (): Promise<void> => {
    const failureKind = statusRef.current?.failure?.kind
    acknowledgeInitialFailure()
    setError(null)
    const checkedNow = await checkInternal('manual')
    if (!checkedNow || (failureKind !== 'download-failed' && failureKind !== 'install-failed')) {
      return
    }
    if (statusRef.current?.phase !== 'available') return
    await downloadInternal()
  }, [acknowledgeInitialFailure, checkInternal, downloadInternal])

  const dismissError = useCallback((): void => {
    setError(null)
    acknowledgeInitialFailure()
  }, [acknowledgeInitialFailure])

  const openSettings = useCallback((): void => {
    setSettingsOpen(true)
  }, [])

  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribe = client.onStatus((next) => {
      if (!active) return
      pushSeqRef.current += 1
      const previous = statusRef.current
      statusRef.current = next
      setStatus(next)
      if (previous?.phase === 'checking' && (next.phase === 'idle' || next.phase === 'available')) {
        markChecked()
      }
      if (
        next.phase === 'failed' &&
        next.failure !== undefined &&
        (previous?.phase === 'downloading' || previous?.phase === 'installing')
      ) {
        presentFailure(failureNoticeFromPush(previous.phase, next.failure))
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [client, markChecked, presentFailure])

  useEffect(() => {
    let active = true
    const pushSeqBefore = pushSeqRef.current
    void settleRequest(client.readUpdateStatus({})).then((result) => {
      if (!active) return
      setInitializing(false)
      if (result.code !== ErrorCodes.success || result.data === undefined) {
        presentFailure(failureNoticeForCode(result.code, result.msg, '无法读取更新状态'))
        return
      }
      if (pushSeqRef.current !== pushSeqBefore) return
      const snapshot = result.data
      applyStatus(snapshot)
      if (snapshot.phase === 'failed' && snapshot.failure !== undefined) {
        initialFailurePendingRef.current = true
        setAwaitingInitialAcknowledgement(true)
        presentFailure({
          title: '更新安装失败',
          message: failureMessageForKind(snapshot.failure.kind),
          showManualDownload: snapshot.failure.kind !== 'unsupported',
          retryable: snapshot.failure.kind !== 'unsupported'
        })
      }
    })
    return () => {
      active = false
    }
  }, [applyStatus, client, presentFailure])

  useEffect(() => {
    if (initializing || awaitingInitialAcknowledgement || backgroundStartedRef.current) return
    if (statusRef.current?.supported !== true) return
    const timer = window.setTimeout(() => {
      if (backgroundStartedRef.current) return
      backgroundStartedRef.current = true
      if (checkAttemptedRef.current) return
      const current = statusRef.current
      if (current === null || (current.phase !== 'idle' && current.phase !== 'failed')) return
      void checkInternal('background')
    }, BACKGROUND_CHECK_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [awaitingInitialAcknowledgement, checkInternal, initializing])

  return {
    status,
    checked,
    initializing,
    settingsOpen,
    error,
    openSettings,
    closeSettings,
    check,
    download,
    install,
    retry,
    dismissError
  }
}
