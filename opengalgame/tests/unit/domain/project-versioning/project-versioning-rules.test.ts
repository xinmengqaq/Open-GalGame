import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import {
  ProjectVersioningErrorCodes,
  type ProjectVersioningErrorCode
} from '@domain/project-versioning/errors/ProjectVersioningErrorCodes'
import type { VersionProtocolState } from '@domain/project-versioning/models/VersionProtocolState'
import type { VersionTransactionFact } from '@domain/project-versioning/models/VersionTransactionFact'
import { bindPreparedOperation } from '@domain/project-versioning/services/bindPreparedOperation'
import { resolveCommitTransition } from '@domain/project-versioning/services/resolveCommitTransition'
import { resolveRollbackTransition } from '@domain/project-versioning/services/resolveRollbackTransition'
import { resolveVersionSettlement } from '@domain/project-versioning/services/resolveVersionSettlement'

const operationId = 'operation-1'
const contentFingerprint = 'fingerprint-a'
const paths = ['docs/a.md', 'assets/b.png'] as const
const watched = ['notes/watch.md'] as const

function expectCode(run: () => unknown, code: ProjectVersioningErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AppException ${code}`)
}

function fact(
  state: VersionProtocolState,
  fingerprint = contentFingerprint
): VersionTransactionFact {
  return { operationId, contentFingerprint: fingerprint, state }
}

describe('准备操作绑定', () => {
  it('接受合法身份，并只把声明修改路径作为可写范围', () => {
    const binding = bindPreparedOperation({
      operationId,
      contentFingerprint,
      changePaths: paths,
      watchedPaths: watched
    })

    expect(binding).toEqual({ operationId, contentFingerprint })
    expect(binding).not.toHaveProperty('changePaths')
  })

  it('拒绝把观察路径登记成写入路径', () => {
    expectCode(
      () =>
        bindPreparedOperation({
          operationId,
          contentFingerprint,
          changePaths: ['docs/a.md', 'notes/watch.md'],
          watchedPaths: watched
        }),
      ProjectVersioningErrorCodes.watchedPathNotWritable
    )
  })

  it('拒绝非法操作身份、空指纹和重复声明路径', () => {
    expectCode(
      () =>
        bindPreparedOperation({
          operationId: 'bad id',
          contentFingerprint,
          changePaths: paths,
          watchedPaths: []
        }),
      ProjectVersioningErrorCodes.invalidOperationIdentity
    )
    expectCode(
      () =>
        bindPreparedOperation({
          operationId,
          contentFingerprint: '  ',
          changePaths: paths,
          watchedPaths: []
        }),
      ProjectVersioningErrorCodes.invalidContentFingerprint
    )
    expectCode(
      () =>
        bindPreparedOperation({
          operationId,
          contentFingerprint,
          changePaths: ['docs/a.md', 'docs/a.md'],
          watchedPaths: []
        }),
      ProjectVersioningErrorCodes.pathOutOfScope
    )
  })
})

describe('提交规则', () => {
  it('尚无持久事实时允许原指纹在声明范围内提交', () => {
    expect(
      resolveCommitTransition({
        operationId,
        contentFingerprint,
        requestedPaths: ['assets/b.png'],
        allowedPaths: paths,
        fact: null
      })
    ).toEqual({ kind: 'continue' })
  })

  it('相同内容的可靠提交或无变更返回既有结果', () => {
    expect(
      resolveCommitTransition({
        operationId,
        contentFingerprint,
        requestedPaths: paths,
        allowedPaths: paths,
        fact: fact('已提交')
      })
    ).toEqual({ kind: 'existing', state: '已提交' })
    expect(
      resolveCommitTransition({
        operationId,
        contentFingerprint,
        requestedPaths: [],
        allowedPaths: paths,
        fact: fact('无变更')
      })
    ).toEqual({ kind: 'existing', state: '无变更' })
  })

  it('拒绝换内容复用同一操作，也拒绝声明范围外或观察路径写入', () => {
    expectCode(
      () =>
        resolveCommitTransition({
          operationId,
          contentFingerprint: 'fingerprint-b',
          requestedPaths: paths,
          allowedPaths: paths,
          fact: fact('已提交')
        }),
      ProjectVersioningErrorCodes.contentFingerprintConflict
    )
    expectCode(
      () =>
        resolveCommitTransition({
          operationId,
          contentFingerprint,
          requestedPaths: ['outside.md'],
          allowedPaths: paths,
          fact: null
        }),
      ProjectVersioningErrorCodes.pathOutOfScope
    )
    expectCode(
      () =>
        resolveCommitTransition({
          operationId,
          contentFingerprint,
          requestedPaths: watched,
          allowedPaths: paths,
          watchedPaths: watched,
          fact: null
        }),
      ProjectVersioningErrorCodes.watchedPathNotWritable
    )
  })

  it('待核对、待回退和已回退不能作为新的提交起点', () => {
    for (const state of ['待核对', '待回退', '已回退'] as const) {
      expectCode(
        () =>
          resolveCommitTransition({
            operationId,
            contentFingerprint,
            requestedPaths: paths,
            allowedPaths: paths,
            fact: fact(state)
          }),
        ProjectVersioningErrorCodes.illegalStateTransition
      )
    }
  })
})

describe('结算映射', () => {
  it('把已核实事实规范成对应结算，证据不足保持待核对', () => {
    expect(resolveVersionSettlement(fact('已提交'), operationId)).toBe('已提交')
    expect(resolveVersionSettlement(fact('无变更'), operationId)).toBe('无变更')
    expect(resolveVersionSettlement(fact('未提交'), operationId)).toBe('未提交')
    expect(resolveVersionSettlement(fact('待回退'), operationId)).toBe('待回退')
    expect(resolveVersionSettlement(fact('已回退'), operationId)).toBe('已回退')
    expect(resolveVersionSettlement(fact('待核对'), operationId)).toBe('待核对')
    expect(resolveVersionSettlement(null, operationId)).toBe('待核对')
    expectCode(
      () => resolveVersionSettlement(fact('已提交'), 'operation-2'),
      ProjectVersioningErrorCodes.operationOwnershipMismatch
    )
    expectCode(
      () =>
        resolveVersionSettlement({
          operationId,
          contentFingerprint: '',
          state: '已提交'
        }),
      ProjectVersioningErrorCodes.invalidContentFingerprint
    )
    expect(resolveVersionSettlement(null)).toBe('待核对')
  })
})

describe('回退与撤销规则', () => {
  it('只允许原操作从待回退进入回退，已回退返回既有事实', () => {
    expect(
      resolveRollbackTransition({
        operationId,
        requestedPaths: ['docs/a.md'],
        ownedPaths: paths,
        fact: fact('待回退')
      })
    ).toEqual({ kind: 'continue' })
    expect(
      resolveRollbackTransition({
        operationId,
        requestedPaths: paths,
        ownedPaths: paths,
        fact: fact('已回退')
      })
    ).toEqual({ kind: 'existing', state: '已回退' })
  })

  it('拒绝跨操作、范围外路径和重复或证据不足的回退', () => {
    expectCode(
      () =>
        resolveRollbackTransition({
          operationId,
          requestedPaths: paths,
          ownedPaths: paths,
          fact: {
            operationId: 'operation-2',
            contentFingerprint,
            state: '待回退'
          }
        }),
      ProjectVersioningErrorCodes.operationOwnershipMismatch
    )
    expectCode(
      () =>
        resolveRollbackTransition({
          operationId,
          requestedPaths: ['outside.md'],
          ownedPaths: paths,
          fact: fact('待回退')
        }),
      ProjectVersioningErrorCodes.pathOutOfScope
    )
    expectCode(
      () =>
        resolveRollbackTransition({
          operationId,
          requestedPaths: paths,
          ownedPaths: paths,
          fact: fact('已提交')
        }),
      ProjectVersioningErrorCodes.illegalStateTransition
    )
    expectCode(
      () =>
        resolveRollbackTransition({
          operationId,
          requestedPaths: paths,
          ownedPaths: paths,
          fact: fact('待核对')
        }),
      ProjectVersioningErrorCodes.insufficientEvidence
    )
  })
})
