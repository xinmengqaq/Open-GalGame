import { clsx } from 'clsx'
import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { useDialogElement } from './dialogElement'
import styles from './SettingsHelp.module.css'

interface SettingsHelpProps {
  label: string
  align?: 'start' | 'end'
  variant?: 'icon' | 'status'
  tone?: 'neutral' | 'warning'
  triggerId?: string
  triggerLabel?: string
  triggerContent?: ReactNode
  children: ReactNode
}

/**
 * 设置项的统一帮助入口：点击或键盘打开，Esc/失焦关闭，内容不依赖悬停。
 * 浮层锚定在触发控件旁，并限制在设置内容区内，避免遮挡页脚操作。
 */
export function SettingsHelp({
  label,
  align = 'start',
  variant = 'icon',
  tone = 'neutral',
  triggerId,
  triggerLabel,
  triggerContent,
  children
}: SettingsHelpProps): ReactElement {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const dialogElement = useDialogElement()
  const collisionBoundary =
    dialogElement?.querySelector<HTMLElement>('[data-settings-content]') ?? undefined

  return (
    <PopoverPrimitive.Root modal={false} open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={triggerId}
          type="button"
          className={clsx(styles.trigger, variant === 'status' && styles.statusTrigger)}
          data-variant={variant}
          data-tone={tone}
          aria-label={triggerLabel ?? `${label}说明`}
          aria-describedby={open ? contentId : undefined}
        >
          {triggerContent ?? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.25" />
              <path d="M12 11v5" />
              <path d="M12 8.2h.01" />
            </svg>
          )}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal container={dialogElement ?? undefined}>
        <PopoverPrimitive.Content
          id={contentId}
          className={styles.bubble}
          role="note"
          aria-label={`${label}说明`}
          side="bottom"
          align={align}
          sideOffset={8}
          collisionPadding={12}
          collisionBoundary={collisionBoundary}
          avoidCollisions
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {children}
          <PopoverPrimitive.Arrow className={styles.arrow} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
