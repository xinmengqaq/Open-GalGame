import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Glyph({ children, ...props }: IconProps & { children: ReactElement | ReactElement[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

/** 来源状态使用的图标，由共享状态组件自己拥有，不从卡片领域反向引用。 */
export function CardCheckIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </Glyph>
  )
}

export function CardUnreadableIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M2.8 12S6.1 6.2 12 6.2c1.4 0 2.6.35 3.7.9M21.2 12S17.9 17.8 12 17.8c-1.4 0-2.6-.35-3.7-.9" />
      <path d="M9.2 9.2a4 4 0 0 0 5.6 5.6M4 4l16 16" />
    </Glyph>
  )
}

export function CardUnlinkIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <path d="M9.5 14.5 7.8 16.2a3.6 3.6 0 0 1-5.1-5.1l1.7-1.7M14.5 9.5l1.7-1.7a3.6 3.6 0 0 1 5.1 5.1l-1.7 1.7" />
      <path d="m4.5 4.5 15 15" />
    </Glyph>
  )
}

export function CardQuestionIcon(props: IconProps): ReactElement {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M9.7 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.35-1.1.9-1.1 1.7v.4M12 16.9v.2" />
    </Glyph>
  )
}
