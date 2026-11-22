import * as React from 'react'
import { cn } from '@presentation/lib/utils'
import theme from '@presentation/pages/workbench/workbenchTheme.module.css'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { POPOVER_Z_INDEX, resolvePopoverPortal } from './popoverPortal'


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
