export type MediaPixelSize = {
  width: number
  height: number
}

export function mediaFitSize(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number
): MediaPixelSize | null {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    !Number.isFinite(boxWidth) ||
    !Number.isFinite(boxHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    boxWidth <= 0 ||
    boxHeight <= 0
  ) {
    return null
  }
  const scale = Math.min(1, boxWidth / naturalWidth, boxHeight / naturalHeight)
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale))
  }
}
