import type { ReactElement, ReactNode } from 'react'

import { Stage } from '../effects/Stage'

export function AppShell({ children }: { children: ReactNode }): ReactElement {
  return <Stage>{children}</Stage>
}
