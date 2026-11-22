export type CheckForUpdateDTO = {
  reason: 'manual' | 'background'
}

export type DownloadUpdateDTO = Record<string, never>

export type InstallUpdateDTO = Record<string, never>

export type ReadUpdateStatusDTO = Record<string, never>
