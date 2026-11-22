import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'

import { Button } from './Button'
import styles from './DangerAction.module.css'

interface DangerActionProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string
  emphasis?: 'quiet' | 'solid'
  icon?: ReactNode
  showIcon?: boolean
}

export function DangerIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4 3.5 19h17Z" />
      <path d="M12 9.5v4.2" />
      <path d="M12 16.6h.01" />
    </svg>
  )
}

export function DangerAction({
  label,
  emphasis = 'quiet',
  icon,
  showIcon = true,
  className,
  type = 'button',
  ...props
}: DangerActionProps): ReactElement {
  return (
    <Button
      type={type}
      variant={emphasis === 'solid' ? 'danger' : 'secondary'}
      className={clsx(styles.action, styles[emphasis], className)}
      {...props}
    >
      {showIcon ? (
        <span className={styles.glyph} aria-hidden="true">
          {icon ?? <DangerIcon />}
        </span>
      ) : null}
      <span>{label}</span>
    </Button>
  )
}
