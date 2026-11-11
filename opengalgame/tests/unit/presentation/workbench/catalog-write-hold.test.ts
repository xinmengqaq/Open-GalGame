import { afterEach, describe, expect, it } from 'vitest'

import {
  beginCatalogWrite,
  catalogWriteBlockedFor,
  endCatalogWrite,
  holdUnresolvedCatalogWrite,
  releaseCatalogWriteHold
} from '@presentation/features/input-catalog/catalogWrites'

afterEach(() => {
  releaseCatalogWriteHold('project-1', 'op-1', 'notCommitted', () => undefined)
  releaseCatalogWriteHold('project-2', 'op-2', 'notCommitted', () => undefined)
})

describe('结果不明的文件区写入', () => {
  it('离开再进入同一工程，未核对前不能再写', () => {
    const busy = { value: false }
    const setBusy = (value: boolean): void => {
      busy.value = value
    }
    holdUnresolvedCatalogWrite('project-1', 'op-1')
    endCatalogWrite('project-1', setBusy)
    expect(catalogWriteBlockedFor('project-1')).toBe(true)
    expect(beginCatalogWrite('project-2', false, setBusy)).toBe(true)
    endCatalogWrite('project-2', setBusy)
    expect(beginCatalogWrite('project-1', false, setBusy)).toBe(false)
    expect(releaseCatalogWriteHold('project-1', 'op-1', 'unsettled', setBusy)).toBe(false)
    expect(beginCatalogWrite('project-1', false, setBusy)).toBe(false)
    expect(releaseCatalogWriteHold('project-1', 'other-op', 'committed', setBusy)).toBe(false)
    expect(releaseCatalogWriteHold('project-1', 'op-1', 'committed', setBusy)).toBe(true)
    expect(catalogWriteBlockedFor('project-1')).toBe(false)
    expect(beginCatalogWrite('project-1', false, setBusy)).toBe(true)
    endCatalogWrite('project-1', setBusy)
  })
})
