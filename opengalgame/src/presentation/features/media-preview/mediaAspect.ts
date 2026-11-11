export type MediaPixelSize = {
  width: number
  height: number
}

/**
 * 把原始媒体尺寸装进给定边界：保持原始比例、不裁切，也不放大超过原始尺寸。
 * 画布媒体卡与输入目录缩略图共用这一条比例规则。
 * @returns 边界尺寸；任一参数不合法时为 null。
 */
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
