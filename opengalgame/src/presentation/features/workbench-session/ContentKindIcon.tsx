import { clsx } from 'clsx'
import type { ReactElement, SVGProps } from 'react'

import type { SessionContentKind } from './contentKindLabel'

type IconProps = SVGProps<SVGSVGElement>

function Glyph({
  className,
  children,
  ...props
}: IconProps & { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      className={clsx(className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export function ContentKindIcon({
  contentKind,
  textKind,
  className
}: {
  contentKind: SessionContentKind
  textKind?: 'document' | 'prompt'
  className?: string
}): ReactElement {
  const kind = contentKind === 'text' ? (textKind ?? 'document') : contentKind
  switch (kind) {
    case 'document':
      return (
        <Glyph className={className}>
          <path d="M7 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5Z" />
          <path d="M14 3.5V9h5.5M8 13h8M8 17h5" />
        </Glyph>
      )
    case 'prompt':
      return (
        <Glyph className={className}>
          <path d="M5 7h14M5 12h10M5 17h7" />
          <path d="m16 15 3 3-3 3" />
        </Glyph>
      )
    case 'image':
      return (
        <Glyph className={className}>
          <rect x="4" y="6" width="16" height="12" rx="2" />
          <path d="m4 15 4.5-3.5 3.5 3 3-2.5L20 15" />
          <circle cx="9" cy="10" r="1.2" />
        </Glyph>
      )
    case 'audio':
      return (
        <Glyph className={className}>
          <path d="M9 18V6l10-2v12" />
          <circle cx="7" cy="18" r="2.4" />
          <circle cx="17" cy="16" r="2.4" />
        </Glyph>
      )
    case 'video':
      return (
        <Glyph className={className}>
          <rect x="3.5" y="6" width="13" height="12" rx="2" />
          <path d="m16.5 10 4-2.5v9l-4-2.5Z" />
        </Glyph>
      )
    case 'animation':
      return (
        <Glyph className={className}>
          <path d="M5 16c3-8 11-8 14 0" />
          <path d="M8 16c2-5 6-5 8 0" />
          <circle cx="12" cy="7" r="2" />
        </Glyph>
      )
    case 'effect':
      return (
        <Glyph className={className}>
          <path d="M12 3 13.8 9h6.7l-5.4 4 2 6.5L12 16.2 6.9 19.5l2-6.5L3.5 9h6.7Z" />
        </Glyph>
      )
  }
}
