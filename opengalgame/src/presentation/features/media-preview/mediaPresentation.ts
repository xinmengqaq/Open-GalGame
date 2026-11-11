/**
 * 媒体时间文案。未知或非法时长按 0 处理，不显示负数或 NaN。
 * @param totalSeconds - 秒数。
 * @returns `m:ss` 或 `h:mm:ss`。
 */
export function formatMediaTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0:00'
  const seconds = Math.floor(totalSeconds)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`
  const hours = Math.floor(minutes / 60)
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/**
 * 由受控字节抽样出能量条。压缩音频没有 PCM 峰值，这里只按字节包络给出稳定的视觉能量，
 * 不把它当作真实波形或播放成功证明。
 * @param bytes - 已读取的媒体字节。
 * @param count - 条数。
 * @returns `0.12–1` 的归一化能量，长度等于 count。
 */
export function audioWaveformPeaks(bytes: Uint8Array, count = 48): readonly number[] {
  if (count <= 0 || bytes.byteLength === 0) return []
  const peaks = new Array<number>(count)
  const bucket = bytes.byteLength / count
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * bucket)
    const end = Math.max(start + 1, Math.floor((index + 1) * bucket))
    const step = Math.max(1, Math.floor((end - start) / 12))
    let total = 0
    let samples = 0
    for (let offset = start; offset < end; offset += step) {
      total += Math.abs(bytes[offset]! - 128)
      samples += 1
    }
    const energy = samples > 0 ? total / samples / 127 : 0
    peaks[index] = Math.min(1, Math.max(0.12, energy * 1.6))
  }
  return peaks
}
