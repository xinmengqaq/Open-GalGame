import { clsx } from 'clsx'
import type { ReactElement, SVGProps } from 'react'

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
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export function ChevronIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m9 6 6 6-6 6" />
    </Glyph>
  )
}

export function CloseIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Glyph>
  )
}

export function MoreIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props} strokeWidth="2.2">
      <path d="M6 12h.01M12 12h.01M18 12h.01" />
    </Glyph>
  )
}

export function PlusIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  )
}

export function FolderIcon({
  open = false,
  ...props
}: IconProps & { open?: boolean }): ReactElement {
  return (
    <Glyph {...props}>
      {open ? (
        <>
          <path d="M3.5 8.5V7a1.5 1.5 0 0 1 1.5-1.5h4.2l1.8 2h7.5A1.5 1.5 0 0 1 20 9v1" />
          <path d="M3.5 9.5h17l-2 9.2a1.5 1.5 0 0 1-1.5 1.3H6a1.5 1.5 0 0 1-1.5-1.3Z" />
        </>
      ) : (
        <path d="M3.5 6.5h6l1.8 2h8.2a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z" />
      )}
    </Glyph>
  )
}

export function FolderPlusIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M3.5 6.5h6l1.8 2h8.2a1.5 1.5 0 0 1 1.5 1.5v2" />
      <path d="M3.5 6.5V18a1.5 1.5 0 0 0 1.5 1.5h7" />
      <path d="M17.5 14v7M14 17.5h7" />
    </Glyph>
  )
}

export function CopyIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </Glyph>
  )
}

export function CutIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="m8.3 15.6 7-10.6M15.7 15.6 8.7 5" />
    </Glyph>
  )
}

export function PasteIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M9 4.5h6v3H9Z" />
      <path d="M9 6H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 6H15" />
      <path d="M8.5 12h7M8.5 16h4.5" />
    </Glyph>
  )
}

export function PencilIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m14.5 5.5 4 4L8 20H4v-4Z" />
      <path d="m12.5 7.5 4 4" />
    </Glyph>
  )
}

export function TrashIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10 11v6M14 11v6" />
    </Glyph>
  )
}

export function ExternalIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M13.5 5H19v5.5M19 5l-8 8" />
      <path d="M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18.5V9A1.5 1.5 0 0 1 6 7.5h4.5" />
    </Glyph>
  )
}

export function SparkIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M12 3.5c.8 4.6 3.4 7.2 8 8-4.6.8-7.2 3.4-8 8-.8-4.6-3.4-7.2-8-8 4.6-.8 7.2-3.4 8-8Z" />
    </Glyph>
  )
}

export function AlertIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M12 4 21 20H3Z" />
      <path d="M12 10v4.5M12 17.5h.01" />
    </Glyph>
  )
}

export function ClipIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M8.5 12.5 14 7a3.5 3.5 0 0 1 5 5l-7 7a5.5 5.5 0 0 1-7.8-7.8l6.6-6.6" />
    </Glyph>
  )
}

export function FolderUpIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M3.5 6.5h6l1.8 2h8.2a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18Z" />
      <path d="M12 16.5v-5M9.5 14l2.5-2.5L14.5 14" />
    </Glyph>
  )
}

export function FileGlyphIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M7 3.5h7l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 6 20V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M14 3.5V9h5M9 13h6M9 17h4" />
    </Glyph>
  )
}

export function ImageGlyphIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="m4 15 4.5-3.5 3.5 3 3-2.5L20 15" />
      <circle cx="9" cy="10" r="1.2" />
    </Glyph>
  )
}

export function SearchNoResultIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 4.5 4.5" />
      <path d="m8 8 5 5M13 8l-5 5" />
    </Glyph>
  )
}

export function WarningDotIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4.5M12 16h.01" />
    </Glyph>
  )
}
