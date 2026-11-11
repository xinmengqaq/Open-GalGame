import * as React from 'react'
import { cn } from '@presentation/lib/utils'
import theme from '@presentation/pages/workbench/workbenchTheme.module.css'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { POPOVER_Z_INDEX, resolvePopoverPortal } from './popoverPortal'

/**
 * 工作台抽屉的基础 Popover（Radix 行为，调用侧外观）。
 *
 * 冻结约定：
 * - 默认 portal 到当前抽屉的 `.theme` 容器；抽屉不在时退回 `document.body`，并在
 *   内容外补一层主题类，保证 `--wb-*` 可用。
 * - 层级在 Sheet 内容（z-index 50）之上。
 * - Esc、外点关闭和关闭后焦点返回触发按钮都由 Radix 负责。
 * - 不提供默认白底、圆角、阴影或内边距，外观由调用侧 className 决定。
 * - 不访问 `document` 直到真正渲染内容，SSR 与测试环境安全。
 */

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverClose({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

function PopoverPortal({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Portal>) {
  return <PopoverPrimitive.Portal data-slot="popover-portal" {...props} />
}

export interface PopoverContentProps extends React.ComponentProps<typeof PopoverPrimitive.Content> {
  /** 已知的 `--wb-*` 主题容器；缺省时按当前抽屉解析。 */
  portalContainer?: HTMLElement | null
}

function PopoverContent({
  className,
  portalContainer,
  sideOffset = 6,
  style,
  children,
  ...props
}: PopoverContentProps) {
  const portal = resolvePopoverPortal(portalContainer)
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      sideOffset={sideOffset}
      className={cn('outline-none', className)}
      style={{ zIndex: POPOVER_Z_INDEX, ...style }}
      {...props}
    >
      {children}
    </PopoverPrimitive.Content>
  )

  return (
    <PopoverPrimitive.Portal container={portal?.container ?? undefined}>
      {portal?.themed ? (
        <div className={theme.theme} data-slot="popover-theme">
          {content}
        </div>
      ) : (
        content
      )}
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverPortal, PopoverContent }
