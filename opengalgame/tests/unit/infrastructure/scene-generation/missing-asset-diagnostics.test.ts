import { describe, expect, it } from 'vitest'

import type { SceneValidationReport } from '@domain/scene-generation/models/SceneValidationReport'
import { enrichMissingAssetDiagnostics } from '@infrastructure/scene-generation/artifacts/missingAssetDiagnostics'

const REAL_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353838'
const WRONG_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353538'

function missingAssetReport(reference: string, sequence = 4): SceneValidationReport {
  return {
    issues: [
      {
        code: 'missing-asset',
        message: '素材引用在工程中不存在',
        sequence,
        reference,
        line: sequence + 5,
        correctable: true,
        requiresHumanDecision: false
      }
    ]
  }
}

describe('enrichMissingAssetDiagnostics', () => {
  it('十六进制抄错一位时给出最近似引用、素材名与工程路径', () => {
    const report = missingAssetReport(`${WRONG_KEY}/josei_01_a.png`)

    const enriched = enrichMissingAssetDiagnostics(report, [
      { name: '澪', relativePath: `assets/${REAL_KEY}/josei_01_a.png` }
    ])

    expect(enriched.issues[0]).toMatchObject({
      reference: `${WRONG_KEY}/josei_01_a.png`,
      line: 9,
      nearestReference: `${REAL_KEY}/josei_01_a.png`,
      nearestAssetName: '澪',
      nearestAssetPath: `assets/${REAL_KEY}/josei_01_a.png`
    })
    expect(report.issues[0]).not.toHaveProperty('nearestReference')
  })

  it('没有素材清单时原样返回，不伪造最近似引用', () => {
    const report = missingAssetReport(`${WRONG_KEY}/josei_01_a.png`)

    expect(enrichMissingAssetDiagnostics(report, [])).toBe(report)
  })

  it('并列最相似时按素材清单顺序稳定选择', () => {
    const report = missingAssetReport('x/foo.png')

    const enriched = enrichMissingAssetDiagnostics(report, [
      { name: '甲', relativePath: 'assets/a/foo.png' },
      { name: '乙', relativePath: 'assets/b/foo.png' }
    ])

    expect(enriched.issues[0]).toMatchObject({
      nearestReference: 'a/foo.png',
      nearestAssetName: '甲',
      nearestAssetPath: 'assets/a/foo.png'
    })
  })

  it('不处理非缺失素材问题', () => {
    const report: SceneValidationReport = {
      issues: [
        {
          code: 'unknown-command',
          message: '未知命令',
          correctable: true,
          requiresHumanDecision: false
        }
      ]
    }

    expect(
      enrichMissingAssetDiagnostics(report, [
        { name: '澪', relativePath: `assets/${REAL_KEY}/josei_01_a.png` }
      ])
    ).toBe(report)
  })
})
