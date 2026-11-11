import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea
} from '@presentation/components/ui/input-group'
import { Spinner } from '@presentation/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@presentation/components/ui/tooltip'
import { cn } from '@presentation/lib/utils'
import { CornerDownLeftIcon, SquareIcon, XIcon } from 'lucide-react'
import {
  Children,
  type ComponentProps,
  type FormEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useState
} from 'react'

export type PromptInputStatus = 'submitted' | 'streaming' | 'ready' | 'error'

export interface PromptInputMessage {
  text: string
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  onSubmit: (message: PromptInputMessage) => void | Promise<void>
}

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    async (event) => {
      event.preventDefault()
      const form = event.currentTarget
      const text = (new FormData(form).get('message') as string | null) ?? ''
      if (text.trim().length === 0) {
        return
      }
      try {
        await onSubmit({ text })
        form.reset()
      } catch {
        // 提交失败时保留原文，调用方据此保留草稿。
      }
    },
    [onSubmit]
  )

  return (
    <form className={cn('w-full', className)} onSubmit={handleSubmit} {...props}>
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
  )
}

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn('contents', className)} {...props} />
)

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>

export const PromptInputTextarea = ({
  onChange,
  onKeyDown,
  className,
  placeholder = 'What would you like to know?',
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false)

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event)

      if (event.defaultPrevented) {
        return
      }

      if (event.key !== 'Enter' || event.shiftKey) {
        return
      }

      if (isComposing || event.nativeEvent.isComposing) {
        return
      }

      event.preventDefault()

      const { form } = event.currentTarget
      const submitButton = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null
      if (submitButton?.disabled) {
        return
      }

      form?.requestSubmit()
    },
    [onKeyDown, isComposing]
  )

  return (
    <InputGroupTextarea
      className={cn('field-sizing-content max-h-48 min-h-16', className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onChange={onChange}
      placeholder={placeholder}
      {...props}
    />
  )
}

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, 'align'>

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn('order-first flex-wrap gap-1', className)}
    {...props}
  />
)

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, 'align'>

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn('justify-between gap-1', className)}
    {...props}
  />
)

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn('flex min-w-0 items-center gap-1', className)} {...props} />
)

export type PromptInputButtonTooltip =
  | string
  | {
      content: ReactNode
      shortcut?: string
      side?: ComponentProps<typeof TooltipContent>['side']
    }

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: PromptInputButtonTooltip
}

export const PromptInputButton = ({
  variant = 'ghost',
  className,
  size,
  tooltip,
  ...props
}: PromptInputButtonProps) => {
  const newSize = size ?? (Children.count(props.children) > 1 ? 'sm' : 'icon-sm')

  const button = (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  const tooltipContent = typeof tooltip === 'string' ? tooltip : tooltip.content
  const shortcut = typeof tooltip === 'string' ? undefined : tooltip.shortcut
  const side = typeof tooltip === 'string' ? 'top' : (tooltip.side ?? 'top')

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={side}>
        {tooltipContent}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: PromptInputStatus
  onStop?: () => void
}

export const PromptInputSubmit = ({
  className,
  variant = 'default',
  size = 'icon-sm',
  status,
  onStop,
  onClick,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const isGenerating = status === 'submitted' || status === 'streaming'

  let Icon = <CornerDownLeftIcon className="size-4" />

  if (status === 'submitted') {
    Icon = <Spinner />
  } else if (status === 'streaming') {
    Icon = <SquareIcon className="size-4" />
  } else if (status === 'error') {
    Icon = <XIcon className="size-4" />
  }

  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (isGenerating && onStop) {
        event.preventDefault()
        onStop()
        return
      }
      onClick?.(event)
    },
    [isGenerating, onStop, onClick]
  )

  return (
    <InputGroupButton
      aria-label={isGenerating ? '停止生成' : '提交'}
      className={cn(className)}
      onClick={handleClick}
      size={size}
      type={isGenerating && onStop ? 'button' : 'submit'}
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  )
}
