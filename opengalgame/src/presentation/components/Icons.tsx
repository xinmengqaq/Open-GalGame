import { clsx } from 'clsx'
import type { ReactElement, SVGProps } from 'react'

import styles from './Icons.module.css'

type IconProps = SVGProps<SVGSVGElement>

export function ArrowIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M4 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}

export function DownloadIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M12 4v11" />
      <path data-download-head d="m8 11 4 4 4-4" />
      <path d="M5 20h14" />
    </svg>
  )
}

export function PlusIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

export function ListIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <g data-list-line>
        <path d="M5 7h14" />
      </g>
      <g data-list-line>
        <path d="M5 12h14" />
      </g>
      <g data-list-line>
        <path d="M5 17h14" />
      </g>
    </svg>
  )
}

export function SettingsIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    </svg>
  )
}

export function CheckIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M5 12.5 10 17l9-10" />
    </svg>
  )
}

export function ErrorIcon({ className, ...props }: IconProps): ReactElement {
  return (
    <svg className={clsx(styles.icon, className)} viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="m9 9 6 6m0-6-6 6" />
    </svg>
  )
}
