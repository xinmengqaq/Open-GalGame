import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type SyntheticEvent
} from 'react'

import type { ProjectFileAssetKind } from '@application/project-files/vo/ProjectInputSourceVO'
import { PauseIcon, PlayIcon } from '../../pages/workbench/WorkbenchIcons'
import { MediaFallback } from '../scene-input-cards/MediaFallback'
import { CardMediaOffIcon } from '../scene-input-cards/InputCardIcons'
import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { audioPlaybackCoordinator } from './audioPlayback'
import { audioWaveformPeaks, formatMediaTime } from './mediaPresentation'
import { useProjectMedia } from './useProjectMedia'
import styles from './MediaPreview.module.css'

type MediaVariant = 'card' | 'thumbnail'

interface MediaPreviewProps {
  sourceId: string
  kind: ProjectFileAssetKind
  title: string
  variant?: MediaVariant
  /** 目录行离开视口前不读取字节。 */
  lazy?: boolean
  enabled?: boolean
  onNaturalSize?: (width: number, height: number) => void
  onDuration?: (seconds: number) => void
}

interface MediaSurfaceProps {
  url: string
  title: string
  variant: MediaVariant
  onRetry: () => void
  onNaturalSize?: (width: number, height: number) => void
}

/**
 * 真实媒体预览。字节只来自受控读取；读取、解码或格式失败时回到安全占位，
 * 不显示路径或内部错误。画布卡与输入目录共用同一比例规则。
 */
export function MediaPreview({
  sourceId,
  kind,
  title,
  variant = 'card',
  lazy = false,
  enabled = true,
  onNaturalSize,
  onDuration
}: MediaPreviewProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(() => !lazy || typeof IntersectionObserver === 'undefined')
  const [attempt, setAttempt] = useState(0)
  const retry = (): void => setAttempt((value) => value + 1)

  useEffect(() => {
    if (!lazy || visible) return
    const node = rootRef.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [lazy, visible])

  const state = useProjectMedia(sourceId, {
    enabled: enabled && visible,
    generation: attempt === 0 ? '' : String(attempt)
  })

  let content: ReactElement
  if (state.status === 'idle' || state.status === 'loading') {
    content = <MediaSkeleton kind={kind} variant={variant} />
  } else if (state.status === 'failed') {
    content =
      kind === 'audio' ? (
        variant === 'thumbnail' ? (
          <MediaUnavailable kind="audio" message="音频不可用" variant={variant} onRetry={retry} />
        ) : (
          <AudioDeckUnavailable title={title} message="音频数据不可用，无法播放" onRetry={retry} />
        )
      ) : (
        <MediaUnavailable kind={kind} message="媒体数据不可用" variant={variant} onRetry={retry} />
      )
  } else if (kind === 'image') {
    content = (
      <ImageSurface
        key={state.url}
        url={state.url}
        title={title}
        variant={variant}
        onRetry={retry}
        onNaturalSize={onNaturalSize}
      />
    )
  } else if (kind === 'video') {
    content = (
      <VideoSurface
        key={state.url}
        url={state.url}
        title={title}
        variant={variant}
        onRetry={retry}
        onNaturalSize={onNaturalSize}
      />
    )
  } else {
    content = (
      <AudioSurface
        key={state.url}
        url={state.url}
        bytes={state.bytes}
        title={title}
        variant={variant}
        onRetry={retry}
        onDuration={onDuration}
      />
    )
  }

  return (
    <div ref={rootRef} className={styles.previewRoot} data-media-kind={kind} data-variant={variant}>
      {content}
    </div>
  )
}

function ImageSurface({
  url,
  title,
  variant,
  onRetry,
  onNaturalSize
}: MediaSurfaceProps): ReactElement {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <MediaUnavailable kind="image" message="图片无法显示" variant={variant} onRetry={onRetry} />
    )
  }
  if (variant === 'thumbnail') {
    return (
      <img
        className={styles.thumbMedia}
        src={url}
        alt=""
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onLoad={(event) =>
          onNaturalSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
        }
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div className={styles.surface}>
      <img
        className={styles.cardMedia}
        src={url}
        alt={title}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onLoad={(event) =>
          onNaturalSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
        }
        onError={() => setFailed(true)}
      />
    </div>
  )
}

function VideoSurface({
  url,
  title,
  variant,
  onRetry,
  onNaturalSize
}: MediaSurfaceProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const element = videoRef.current
    return () => element?.pause()
  }, [])

  if (failed) {
    return (
      <MediaUnavailable kind="video" message="视频无法播放" variant={variant} onRetry={onRetry} />
    )
  }

  const metadata = (event: SyntheticEvent<HTMLVideoElement>): void => {
    const element = event.currentTarget
    setDuration(Number.isFinite(element.duration) ? element.duration : 0)
    onNaturalSize?.(element.videoWidth, element.videoHeight)
  }
  const seek = (event: ChangeEvent<HTMLInputElement>): void => {
    const element = videoRef.current
    const next = Number(event.currentTarget.value)
    if (!element || !Number.isFinite(next)) return
    element.currentTime = next
    setCurrent(next)
  }
  const toggle = (): void => {
    const element = videoRef.current
    if (!element) return
    if (element.paused) void element.play().catch(() => setFailed(true))
    else element.pause()
  }

  if (variant === 'thumbnail') {
    return (
      <span className={styles.thumbVideoWrap}>
        <video
          ref={videoRef}
          className={styles.thumbMedia}
          src={url}
          preload="metadata"
          muted
          playsInline
          onLoadedMetadata={metadata}
          onError={() => setFailed(true)}
        />
        <span className={styles.thumbPlayMark} aria-hidden="true">
          <PlayIcon />
        </span>
      </span>
    )
  }

  return (
    <div className={styles.surface} data-playing={playing}>
      <video
        ref={videoRef}
        className={styles.cardMedia}
        src={url}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={metadata}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      <div className={`${styles.videoControls} nodrag nopan`}>
        <button
          type="button"
          className={styles.videoToggle}
          aria-label={`${playing ? '暂停' : '播放'} ${title}`}
          onClick={toggle}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <input
          type="range"
          className={styles.videoSeek}
          min={0}
          step={0.1}
          max={Math.max(duration, 0.1)}
          value={Math.min(current, Math.max(duration, 0.1))}
          aria-label={`播放进度 ${title}`}
          onChange={seek}
        />
        <span className={styles.videoTime}>
          {formatMediaTime(current)} / {formatMediaTime(duration)}
        </span>
      </div>
    </div>
  )
}

interface AudioSurfaceProps {
  url: string
  bytes: Uint8Array
  title: string
  variant: MediaVariant
  onRetry: () => void
  onDuration?: (seconds: number) => void
}

function AudioSurface({
  url,
  bytes,
  title,
  variant,
  onRetry,
  onDuration
}: AudioSurfaceProps): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)
  const peaks = useMemo(
    () => audioWaveformPeaks(bytes, variant === 'thumbnail' ? 8 : 44),
    [bytes, variant]
  )

  useEffect(() => {
    const element = audioRef.current
    if (!element) return
    return () => {
      element.pause()
      audioPlaybackCoordinator.release(element)
    }
  }, [])

  if (failed) {
    return variant === 'thumbnail' ? (
      <MediaUnavailable kind="audio" message="音频无法播放" variant={variant} onRetry={onRetry} />
    ) : (
      <AudioDeckUnavailable title={title} message="音频无法播放" onRetry={onRetry} />
    )
  }

  const progress = duration > 0 ? Math.min(1, current / duration) : 0
  const metadata = (event: SyntheticEvent<HTMLAudioElement>): void => {
    const element = event.currentTarget
    const next = Number.isFinite(element.duration) ? element.duration : 0
    setDuration(next)
    onDuration?.(next)
  }
  const seek = (event: ChangeEvent<HTMLInputElement>): void => {
    const element = audioRef.current
    const next = Number(event.currentTarget.value)
    if (!element || !Number.isFinite(next)) return
    element.currentTime = next
    setCurrent(next)
  }
  const toggle = (): void => {
    const element = audioRef.current
    if (!element) return
    if (element.paused) {
      audioPlaybackCoordinator.claim(element)
      void element.play().catch(() => {
        audioPlaybackCoordinator.release(element)
        setPlaying(false)
      })
    } else {
      element.pause()
    }
  }
  const audioElement = (
    <audio
      ref={audioRef}
      className={styles.hiddenAudio}
      src={url}
      preload="metadata"
      onLoadedMetadata={metadata}
      onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)}
      onPause={(event) => {
        setPlaying(false)
        audioPlaybackCoordinator.release(event.currentTarget)
      }}
      onEnded={() => setPlaying(false)}
      onError={() => setFailed(true)}
    />
  )

  if (variant === 'thumbnail') {
    return (
      <span className={styles.compactAudio} data-playing={playing}>
        {audioElement}
        <Waveform peaks={peaks} progress={progress} className={styles.compactWave} />
        <button
          type="button"
          className={styles.compactPlay}
          aria-label={`${playing ? '暂停' : '播放'} ${title}`}
          onClick={toggle}
          onDoubleClick={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
      </span>
    )
  }

  return (
    <div className={styles.audioDeck} data-audio-state={playing ? 'playing' : 'ready'}>
      {audioElement}
      <button
        type="button"
        className={`${styles.audioPlay} nodrag nopan`}
        aria-label={`${playing ? '暂停' : '播放'} ${title}`}
        onClick={toggle}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className={styles.audioBody}>
        <Waveform peaks={peaks} progress={progress} className={styles.audioWave} />
        <input
          type="range"
          className={`${styles.audioSeek} nodrag nopan`}
          min={0}
          step={0.1}
          max={Math.max(duration, 0.1)}
          value={Math.min(current, Math.max(duration, 0.1))}
          aria-label={`播放进度 ${title}`}
          onChange={seek}
        />
      </div>
      <span className={styles.audioTime}>
        {formatMediaTime(current)} / {formatMediaTime(duration)}
      </span>
    </div>
  )
}

function Waveform({
  peaks,
  progress,
  className
}: {
  peaks: readonly number[]
  progress: number
  className: string
}): ReactElement {
  const width = Math.max(peaks.length * 4, 4)
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} 32`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {peaks.map((peak, index) => {
        const height = Math.max(2, Math.round(peak * 30))
        const played = peaks.length > 0 && index / peaks.length <= progress
        return (
          <rect
            key={index}
            x={index * 4}
            y={(32 - height) / 2}
            width={2.4}
            height={height}
            rx={1.2}
            data-played={played ? 'true' : undefined}
          />
        )
      })}
    </svg>
  )
}

function MediaUnavailable({
  kind,
  message,
  variant,
  onRetry
}: {
  kind: ProjectFileAssetKind
  message: string
  variant: MediaVariant
  onRetry: () => void
}): ReactElement {
  if (variant === 'thumbnail') {
    return (
      <button
        type="button"
        className={styles.thumbUnavailable}
        title={`${message}，点击重新读取`}
        aria-label={`${message}，重新读取媒体`}
        onClick={onRetry}
        onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => event.preventDefault()}
      >
        <ContentKindIcon contentKind={kind} />
        <span className={styles.thumbOffMark} aria-hidden="true">
          <CardMediaOffIcon />
        </span>
      </button>
    )
  }
  return (
    <MediaFallback kind={kind === 'video' ? 'video' : 'image'} state={message} onRetry={onRetry} />
  )
}

export function AudioDeckUnavailable({
  title,
  message,
  onRetry
}: {
  title: string
  message: string
  onRetry?: () => void
}): ReactElement {
  return (
    <div className={styles.audioDeck} data-audio-state="blocked">
      <button
        type="button"
        className={styles.audioPlay}
        disabled
        aria-label={`播放 ${title}，${message}`}
      >
        <PlayIcon />
      </button>
      <span className={styles.audioState}>{message}</span>
      {onRetry ? (
        <button type="button" className={styles.audioRetry} onClick={onRetry}>
          重新读取
        </button>
      ) : null}
    </div>
  )
}

function MediaSkeleton({
  kind,
  variant
}: {
  kind: ProjectFileAssetKind
  variant: MediaVariant
}): ReactElement {
  if (variant === 'thumbnail') {
    return <span className={styles.thumbSkeleton} aria-hidden="true" />
  }
  if (kind === 'audio') {
    return (
      <div className={styles.audioDeck} data-audio-state="loading" aria-busy="true">
        <span className={styles.audioPlaySkeleton} aria-hidden="true" />
        <span className={styles.audioBarsSkeleton} aria-hidden="true" />
      </div>
    )
  }
  return (
    <div className={styles.surface} aria-busy="true" aria-label="正在读取媒体">
      <span className={styles.cardSkeleton} aria-hidden="true" />
    </div>
  )
}
