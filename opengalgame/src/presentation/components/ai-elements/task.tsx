import { Collapsible, CollapsibleTrigger } from '@presentation/components/ui/collapsible'
import { cn } from '@presentation/lib/utils'
import { ChevronDownIcon, SearchIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

export type TaskProps = ComponentProps<typeof Collapsible>

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
)

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string
}

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn('group', className)} {...props}>
    {children ?? (
      <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <SearchIcon className="size-4" />
        <p className="text-sm">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
)
