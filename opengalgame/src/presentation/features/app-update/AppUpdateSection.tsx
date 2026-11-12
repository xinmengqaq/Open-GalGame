import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import { ArrowIcon } from '../../components/Icons'
import { Button } from '../../components/Button'
import styles from './AppUpdateSection.module.css'
import type { AppUpdateFlow } from './useAppUpdate'

/** 发布源不可用时的固定手动下载入口；不接受运行时传入的任意地址。 */
const MANUAL_DOWNLOAD_URL = 'https://github.com/xinmengqaq/Open-GalGame/releases/latest'

type DialKind =
  | 'loading'
  | 'unchecked'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'failed'
  | 'unsupported'
  | 'idle'

interface UpdateView {
  kind: DialKind
  eyebrow: string
  title: string
  detail: string
  live: string
  actionLabel: string
  actionDisabled: boolean
  action: 'check' | 'retry' | 'download' | 'install' | 'none'
  showManualDownload: boolean
  showProgress: boolean
}

const failureDetails: Record<string, string> = {
  unsupported: '安装版才支持应用内更新。',
  'source-unavailable': '发布源暂时不可达；检查网络后重试，或手动下载安装包。',
  'download-failed': '下载没有完成，重新检查后会再试一次。',
  'install-failed': '安装没有完成，可以重试，或手动下载安装包。',
  'invalid-state': '更新状态已经变化，重新检查后可以继续。'
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : size >= 100 ? 0 : 1
  return `${size.toFixed(digits)} ${units[unit]}`
}

function releaseDateLabel(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function resolveUpdateView(flow: AppUpdateFlow): UpdateView {
  const status = flow.status
  if (status === null) {
    if (flow.initializing) {
      return {
        kind: 'loading',
        eyebrow: '更新状态',
        title: '正在读取版本信息…',
        detail: '连上主进程后会显示当前版本与发布源状态。',
        live: '正在读取版本信息',
        actionLabel: '检查更新',
        actionDisabled: true,
        action: 'none',
        showManualDownload: false,
        showProgress: false
      }
    }
    return {
      kind: 'failed',
      eyebrow: '更新状态',
      title: '无法读取更新状态',
      detail: '可以重新检查发布源，或稍后再试。',
      live: '无法读取更新状态',
      actionLabel: '重新检查',
      actionDisabled: false,
      action: 'check',
      showManualDownload: true,
      showProgress: false
    }
  }

  if (!status.supported) {
    return {
      kind: 'unsupported',
      eyebrow: '仅安装版可用',
      title: '当前运行形态不支持应用内更新',
      detail: '在 Windows 安装版中，这里会检查发布源并提示下载与重启安装。',
      live: '当前运行形态不支持应用内更新',
      actionLabel: '检查更新',
      actionDisabled: false,
      action: 'check',
      showManualDownload: false,
      showProgress: false
    }
  }

  switch (status.phase) {
    case 'checking':
      return {
        kind: 'checking',
        eyebrow: '更新状态 · 检查中',
        title: '正在检查更新…',
        detail: '正在连接发布源获取最新的版本信息。',
        live: '正在检查更新',
        actionLabel: '正在检查…',
        actionDisabled: true,
        action: 'none',
        showManualDownload: false,
        showProgress: false
      }
    case 'available': {
      const version = status.release?.version ?? ''
      return {
        kind: 'available',
        eyebrow: '可更新',
        title: `发现新版本 ${version}`,
        detail: `当前版本 ${status.currentVersion}。下载由你决定开始，完成后也不会自动重启。`,
        live: `发现新版本 ${version}`,
        actionLabel: '立即更新',
        actionDisabled: false,
        action: 'download',
        showManualDownload: false,
        showProgress: false
      }
    }
    case 'downloading': {
      const progress = status.progress
      const total = progress?.total ?? 0
      const percent = progress?.percent ?? 0
      if (progress !== undefined && total > 0) {
        const speed =
          progress.bytesPerSecond > 0 ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : ''
        return {
          kind: 'downloading',
          eyebrow: '更新状态 · 下载中',
          title: `正在下载 ${percent}%`,
          detail: `${formatBytes(progress.transferred)} / ${formatBytes(total)}${speed}`,
          live: '正在下载更新',
          actionLabel: '正在下载…',
          actionDisabled: true,
          action: 'none',
          showManualDownload: false,
          showProgress: true
        }
      }
      return {
        kind: 'downloading',
        eyebrow: '更新状态 · 下载中',
        title: '正在下载…',
        detail: '下载总量还在确认，完成后会提示你重启安装。',
        live: '正在下载更新',
        actionLabel: '正在下载…',
        actionDisabled: true,
        action: 'none',
        showManualDownload: false,
        showProgress: true
      }
    }
    case 'downloaded': {
      const version = status.release?.version ?? ''
      return {
        kind: 'downloaded',
        eyebrow: '更新已就绪',
        title: '更新已下载，重启后完成安装',
        detail: `新版本 ${version} 已准备就绪；现在不会自动重启，由你确认后安装。`,
        live: '更新已下载，可以重启安装',
        actionLabel: '重启安装',
        actionDisabled: false,
        action: 'install',
        showManualDownload: false,
        showProgress: true
      }
    }
    case 'installing':
      return {
        kind: 'installing',
        eyebrow: '更新状态 · 安装中',
        title: '正在安装更新…',
        detail: '应用即将退出，并在安装完成后重新启动。',
        live: '正在安装更新',
        actionLabel: '正在安装…',
        actionDisabled: true,
        action: 'none',
        showManualDownload: false,
        showProgress: true
      }
    case 'failed': {
      const failure = status.failure
      if (failure === undefined) {
        return {
          kind: 'failed',
          eyebrow: '更新失败',
          title: '更新没有完成',
          detail: '可以重新检查发布源。',
          live: '更新没有完成',
          actionLabel: '重新检查',
          actionDisabled: false,
          action: 'retry',
          showManualDownload: true,
          showProgress: false
        }
      }
      const retryDownload = failure.kind === 'download-failed' || failure.kind === 'install-failed'
      return {
        kind: 'failed',
        eyebrow: '更新失败',
        title: failure.message,
        detail: failureDetails[failure.kind] ?? '可以重新检查发布源。',
        live: `更新失败：${failure.message}`,
        actionLabel: retryDownload ? '重试' : '重新检查',
        actionDisabled: false,
        action: 'retry',
        showManualDownload: failure.kind !== 'unsupported' && failure.kind !== 'invalid-state',
        showProgress: false
      }
    }
    case 'idle':
      return flow.checked
        ? {
            kind: 'idle',
            eyebrow: '更新状态',
            title: '已是最新版本',
            detail: `当前版本 ${status.currentVersion} 已是发布源上的最新版本。`,
            live: '已是最新版本',
            actionLabel: '检查更新',
            actionDisabled: false,
            action: 'check',
            showManualDownload: false,
            showProgress: false
          }
        : {
            kind: 'unchecked',
            eyebrow: '更新状态',
            title: '尚未检查更新',
            detail: '检查后就能知道发布源是否有新版本。',
            live: '尚未检查更新',
            actionLabel: '检查更新',
            actionDisabled: false,
            action: 'check',
            showManualDownload: false,
            showProgress: false
          }
  }
}

function UpdateDial({ kind, percent }: { kind: DialKind; percent: number }): ReactElement {
  const circumference = 2 * Math.PI * 54
  const arc = (() => {
    switch (kind) {
      case 'loading':
      case 'checking':
        return (
          <circle
            className={clsx(styles.dialArc, styles.dialSpin)}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray="86 253"
          />
        )
      case 'available':
        return (
          <circle
            className={styles.dialArc}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray={`${circumference * 0.86} ${circumference}`}
            transform="rotate(-90 66 66)"
          />
        )
      case 'downloading':
        return percent > 0 ? (
          <circle
            className={styles.dialArc}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray={`${(circumference * percent) / 100} ${circumference}`}
            transform="rotate(-90 66 66)"
          />
        ) : (
          <circle
            className={clsx(styles.dialArc, styles.dialSpin)}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray="86 253"
          />
        )
      case 'downloaded':
      case 'idle':
        return (
          <circle className={clsx(styles.dialArc, styles.dialSuccess)} cx="66" cy="66" r="54" />
        )
      case 'installing':
        return (
          <circle
            className={clsx(styles.dialArc, styles.dialPulse)}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray={`${circumference * 0.9} ${circumference}`}
            transform="rotate(-90 66 66)"
          />
        )
      case 'failed':
        return (
          <circle
            className={clsx(styles.dialArc, styles.dialError)}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray="300 40"
          />
        )
      case 'unsupported':
        return (
          <circle
            className={clsx(styles.dialArc, styles.dialMuted)}
            cx="66"
            cy="66"
            r="54"
            strokeDasharray="10 14"
          />
        )
      case 'unchecked':
        return null
    }
  })()

  const glyph = (() => {
    switch (kind) {
      case 'loading':
      case 'checking':
        return (
          <path
            className={styles.dialSpark}
            d="M66 48.5 70 62l13.5 4L70 70l-4 13.5L62 70l-13.5-4L62 62Z"
          />
        )
      case 'available':
        return (
          <g className={styles.glyph}>
            <path d="M52 80 78 54" />
            <path d="M60 52h20v20" />
          </g>
        )
      case 'downloading':
        return percent > 0 ? (
          <text x="66" y="74" textAnchor="middle" className={styles.dialPercent}>
            {percent}
          </text>
        ) : (
          <g className={styles.glyph}>
            <path d="M66 46v36" />
            <path d="m54 70 12 12 12-12" />
          </g>
        )
      case 'downloaded':
      case 'idle':
        return (
          <g className={clsx(styles.glyph, styles.glyphSuccess)}>
            <path d="m48 67 12 12 26-27" />
          </g>
        )
      case 'installing':
        return (
          <g className={styles.glyph}>
            <path d="M66 44v28" />
            <path d="m54 60 12 12 12-12" />
            <path d="M46 88h40" />
          </g>
        )
      case 'failed':
        return (
          <g className={clsx(styles.glyph, styles.glyphError)}>
            <path d="M66 50v24" />
            <circle cx="66" cy="84" r="2.6" fill="currentColor" stroke="none" />
          </g>
        )
      case 'unsupported':
        return (
          <g className={styles.glyph}>
            <path d="M48 66h36" />
          </g>
        )
      case 'unchecked':
        return (
          <g className={styles.glyph}>
            <path d="M66 48l3.6 10.4L80 62l-10.4 3.6L66 76l-3.6-10.4L52 62l10.4-3.6Z" />
          </g>
        )
    }
  })()

  return (
    <svg className={styles.dial} viewBox="0 0 132 132" aria-hidden="true" focusable="false">
      <circle className={styles.dialDisc} cx="66" cy="66" r="62" />
      <circle className={styles.dialTrack} cx="66" cy="66" r="54" />
      {arc}
      {glyph}
    </svg>
  )
}

/** 固定 GitHub Releases 手动下载入口；只作为发布源不可用时的兜底。 */
export function ManualDownloadLink({ className }: { className?: string }): ReactElement {
  return (
    <a
      className={clsx(styles.manualDownload, className)}
      href={MANUAL_DOWNLOAD_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      从 GitHub Releases 手动下载
      <ArrowIcon />
    </a>
  )
}

/** 应用设置里的版本与更新区：版本行、状态主视觉、主操作与发行说明。 */
export function AppUpdateSection({ flow }: { flow: AppUpdateFlow }): ReactElement {
  const view = resolveUpdateView(flow)
  const status = flow.status
  const phase = status?.phase ?? null
  const percent = status?.progress?.percent ?? 0
  const release = status?.release
  const releasedAt = releaseDateLabel(release?.releasedAt)

  function runAction(): void {
    switch (view.action) {
      case 'check':
        void flow.check()
        break
      case 'retry':
        void flow.retry()
        break
      case 'download':
        void flow.download()
        break
      case 'install':
        void flow.install()
        break
      case 'none':
        break
    }
  }

  const progressView = (() => {
    if (phase === 'downloading') {
      const total = status?.progress?.total ?? 0
      if (total > 0) {
        return (
          <div
            className={styles.progress}
            data-kind="determinate"
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
        )
      }
      return (
        <div
          className={styles.progress}
          data-kind="indeterminate"
          role="progressbar"
          aria-label="更新下载进度"
          aria-valuetext="正在下载，总量未知"
        >
          <span className={styles.progressFill} />
        </div>
      )
    }
    if (phase === 'downloaded') {
      return (
        <div className={styles.progress} data-kind="complete" aria-hidden="true">
          <span className={styles.progressFill} />
        </div>
      )
    }
    if (phase === 'installing') {
      return (
        <div className={styles.progress} data-kind="installing" aria-hidden="true">
          <span className={styles.progressFill} />
        </div>
      )
    }
    return null
  })()

  return (
    <div className={styles.section} data-phase={view.kind} data-supported={status?.supported}>
      <p className={styles.live} aria-live="polite" aria-atomic="true">
        {view.live}
      </p>
      <div className={styles.versionRow}>
        <div className={styles.versionIdentity}>
          <span className={styles.versionLabel}>当前版本</span>
          <span className={styles.versionValue}>v{status?.currentVersion ?? '—'}</span>
        </div>
        <span
          className={styles.channel}
          data-tone={status?.supported === false ? 'muted' : 'ready'}
        >
          <span className={styles.channelDot} aria-hidden="true" />
          {status?.supported === false ? '不支持应用内更新' : '应用内更新'}
        </span>
      </div>
      <section className={styles.hero}>
        <div className={styles.heroGlow} aria-hidden="true" />
        <UpdateDial kind={view.kind} percent={percent} />
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>{view.eyebrow}</span>
          <h3 className={styles.title}>{view.title}</h3>
          <p className={styles.detail}>{view.detail}</p>
        </div>
      </section>
      {progressView}
      <div className={styles.actionRow}>
        <Button className={styles.primaryAction} disabled={view.actionDisabled} onClick={runAction}>
          {view.actionLabel}
        </Button>
        {view.showManualDownload ? <ManualDownloadLink /> : null}
      </div>
      {release?.releaseNotes !== undefined && release.releaseNotes !== '' ? (
        <details className={styles.notes}>
          <summary className={styles.notesSummary}>
            <span className={styles.notesChevron} aria-hidden="true">
              ▸
            </span>
            发行说明
            <span className={styles.notesMeta}>
              v{release.version}
              {releasedAt === null ? '' : ` · ${releasedAt}`}
            </span>
          </summary>
          <p className={styles.notesBody}>{release.releaseNotes}</p>
        </details>
      ) : null}
    </div>
  )
}
