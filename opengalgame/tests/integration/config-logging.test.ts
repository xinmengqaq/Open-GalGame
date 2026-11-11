import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FileConfigurationGatewayImpl } from '@infrastructure/config/FileConfigurationGatewayImpl'
import { PinoLoggerGatewayImpl } from '@infrastructure/logging/PinoLoggerGatewayImpl'

it('运行配置按默认、文件、环境覆盖，非法配置不回落默认值', () => {
  const root = mkdtempSync(join(tmpdir(), 'opengalgame-config-'))
  const file = join(root, 'runtime-config.json')
  writeFileSync(file, JSON.stringify({ requestTimeoutMs: 5000, logLevel: 'debug' }))
  const config = new FileConfigurationGatewayImpl(file, {
    OPENGALGAME_REQUEST_TIMEOUT_MS: '7000'
  }).getSnapshot()
  expect(config.requestTimeoutMs).toBe(7000)
  expect(config.logLevel).toBe('debug')
  expect(Object.isFrozen(config)).toBe(true)
  expect(
    new FileConfigurationGatewayImpl(file, { OPENGALGAME_REQUEST_TIMEOUT_MS: '' }).getSnapshot()
      .requestTimeoutMs
  ).toBe(5000)
  expect(
    new FileConfigurationGatewayImpl(file, {
      OPENGALGAME_REQUEST_TIMEOUT_MS: '   ',
      OPENGALGAME_LOG_LEVEL: ' \t'
    }).getSnapshot()
  ).toMatchObject({ requestTimeoutMs: 5000, logLevel: 'debug' })
  const missing = join(root, 'missing-runtime-config.json')
  expect(
    new FileConfigurationGatewayImpl(missing, { OPENGALGAME_REQUEST_TIMEOUT_MS: '' }).getSnapshot()
      .requestTimeoutMs
  ).toBe(10000)
  for (const environment of [
    { OPENGALGAME_REQUEST_TIMEOUT_MS: ' 7000 ' },
    { OPENGALGAME_LOG_MAX_BYTES: ' 2048' },
    { OPENGALGAME_REQUEST_TIMEOUT_MS: ' 0 ' },
    { OPENGALGAME_REQUEST_TIMEOUT_MS: '-1' }
  ]) {
    expect(() => new FileConfigurationGatewayImpl(file, environment).getSnapshot()).toThrow(
      expect.objectContaining({ code: ErrorCodes.invalidConfig })
    )
  }
  expect(() =>
    new FileConfigurationGatewayImpl(missing, {
      OPENGALGAME_LOG_RETENTION_DAYS: '\t7\n'
    }).getSnapshot()
  ).toThrow(expect.objectContaining({ code: ErrorCodes.invalidConfig }))
  writeFileSync(file, '{broken')
  expect(() => new FileConfigurationGatewayImpl(file, {})).toThrow()
})

it('诊断日志写中文，字段白名单脱敏，并按大小轮转', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opengalgame-logs-'))
  const logger = new PinoLoggerGatewayImpl(root, {
    logLevel: 'debug',
    logMaxBytes: 1024,
    logRetentionDays: 7,
    requestTimeoutMs: 1000
  })
  for (let i = 0; i < 40; i++)
    logger.info('项目登记完成', { operationId: `op-${i}`, apiKey: 'secret-do-not-log' } as never)
  await logger.close()
  const files = readdirSync(root).filter((name) => name.endsWith('.jsonl'))
  expect(files.length).toBeGreaterThan(1)
  const output = files.map((file) => readFileSync(join(root, file), 'utf8')).join('')
  expect(output).toContain('项目登记完成')
  expect(output).not.toContain('secret-do-not-log')
})

it('诊断事实字段写入日志，不写入异常原文', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opengalgame-log-facts-'))
  const logger = new PinoLoggerGatewayImpl(root, {
    logLevel: 'debug',
    logMaxBytes: 1024 * 1024,
    logRetentionDays: 7,
    requestTimeoutMs: 1000
  })
  logger.error('场景生成后台任务失败', {
    operationId: 'operation-1',
    projectId: 'project-1',
    errorCode: 4103,
    errorName: 'FinalizeRequested',
    causeNames: 'AppException',
    causeCodes: '4103',
    statuses: '503',
    diagnosticRef: 'd4d4080fce38',
    recordedDiagnosticRef: '6d6861187dfb'
  })
  await logger.close()
  const output = readdirSync(root)
    .filter((name) => name.endsWith('.jsonl'))
    .map((file) => readFileSync(join(root, file), 'utf8'))
    .join('')
  const line = output.split('\n').find((record) => record.includes('"operationId":"operation-1"'))
  expect(line).toBeDefined()
  expect(line).toContain('"projectId":"project-1"')
  expect(line).toContain('"diagnosticRef":"d4d4080fce38"')
  expect(line).toContain('"recordedDiagnosticRef":"6d6861187dfb"')
  expect(output).toContain('"errorName":"FinalizeRequested"')
  expect(output).toContain('"causeNames":"AppException"')
  expect(output).toContain('"causeCodes":"4103"')
  expect(output).toContain('"statuses":"503"')
  expect(output).not.toContain('stack')
  expect(output).not.toContain('请求体')
})
