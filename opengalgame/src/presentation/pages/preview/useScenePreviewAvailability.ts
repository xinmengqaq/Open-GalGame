import { useCallback, useEffect, useRef, useState } from 'react'

import type { ScenePreviewAvailabilityVO } from '@application/scene-preview/vo/ScenePreviewAvailabilityVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

export type ScenePreviewAvailabilityState =
  | { readonly status: 'checking' }
  | { readonly status: 'available' }
  | {
      readonly status: 'blocked'
      readonly reason: Extract<ScenePreviewAvailabilityVO, { status: 'blocked' }>['reason']
      readonly message: string
    }
  | { readonly status: 'failed'; readonly message: string }

interface UseScenePreviewAvailabilityOptions {
  readonly client: ScenePreviewClient
  readonly projectId: string
  readonly sceneId: string
}

/**
 * 页面自己的产物可用性复核。入口可以预先放行，但页面不把入口结论当成读取结果；
 * 读取失败与产物缺失分开表达，读取不会启动会话或舞台。
 */
export function useScenePreviewAvailability({
  client,
  projectId,
  sceneId
}: UseScenePreviewAvailabilityOptions): {
  readonly state: ScenePreviewAvailabilityState
  readonly refresh: () => void
} {
  const [state, setState] = useState<ScenePreviewAvailabilityState>({ status: 'checking' })
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)
  const invalidIdentity = projectId.trim() === '' || sceneId.trim() === ''

  useEffect(() => {
    if (invalidIdentity) return
    const current = ++generation.current
    let cancelled = false
    void client
      .readPreviewAvailability({ projectId, sceneId })
      .then((result) => {
        if (cancelled || current !== generation.current) return
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setState({ status: 'failed', message: '暂时读不到预览内容，请重试。' })
          return
        }
        if (result.data.status === 'available') {
          setState({ status: 'available' })
          return
        }
        setState({
          status: 'blocked',
          reason: result.data.reason,
          message: result.data.message
        })
      })
      .catch(() => {
        if (cancelled || current !== generation.current) return
        setState({ status: 'failed', message: '预览内容读取失败，请重试。' })
      })
    return () => {
      cancelled = true
    }
  }, [client, invalidIdentity, projectId, sceneId, nonce])

  const refresh = useCallback(() => {
    setState({ status: 'checking' })
    setNonce((value) => value + 1)
  }, [])

  return {
    state: invalidIdentity
      ? { status: 'blocked', reason: 'sceneUnavailable', message: '当前场景不可用' }
      : state,
    refresh
  }
}
