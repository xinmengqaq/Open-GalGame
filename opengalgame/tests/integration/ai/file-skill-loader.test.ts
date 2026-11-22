import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FileSkillLoader } from '@infrastructure/ai/skills/FileSkillLoader'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('受信技能文件', () => {
  it('读取 SKILL.md 与参考文件，按路径稳定排序并给出可绑定摘要', async () => {
    const root = await createRoot()
    await writeSkill(root, 'webgal-scene', {
      'SKILL.md': '# 场景技能\n正文',
      'references/controls.md': '控制语法',
      'examples/basic.md': '示例'
    })
    const loader = new FileSkillLoader(root)
    const skill = await loader.load('webgal-scene')

    expect(skill.id).toBe('webgal-scene')
    expect(skill.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'examples/basic.md',
      'references/controls.md'
    ])
    expect(skill.files[0]).toMatchObject({
      body: '# 场景技能\n正文',
      bytes: Buffer.byteLength('# 场景技能\n正文')
    })
    expect(skill.files[0]?.digest).toBe(
      createHash('sha256').update(Buffer.from('# 场景技能\n正文')).digest('hex')
    )
    const digest = createHash('sha256')
      .update(skill.files.map((file) => `${file.path}\u0000${file.digest}\n`).join(''))
      .digest('hex')
    expect(skill.digest).toBe(digest)
    expect((await loader.load('webgal-scene')).digest).toBe(skill.digest)
  })

  it('缺失、空白、非法编码、非法标识和越界路径都失败', async () => {
    const root = await createRoot()
    const loader = new FileSkillLoader(root)

    await expect(loader.load('missing')).rejects.toThrow('技能不存在')
    await writeSkill(root, 'blank', { 'SKILL.md': ' \n\t' })
    await expect(loader.load('blank')).rejects.toThrow('技能描述为空')
    await writeSkill(root, 'no-manifest', { 'references/a.md': 'x' })
    await expect(loader.load('no-manifest')).rejects.toThrow('技能描述不存在')
    await mkdir(join(root, 'bad-encoding'))
    await writeFile(join(root, 'bad-encoding', 'SKILL.md'), Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(loader.load('bad-encoding')).rejects.toThrow('技能文件不是合法的 UTF-8')
    await expect(loader.load('../secret')).rejects.toThrow('技能标识无效')
    await expect(loader.load('C:/windows')).rejects.toThrow('技能标识无效')
  })

  it('技能目录内的链接一律拒绝；不能创建链接时跳过', async (ctx) => {
    const root = await createRoot()
    const outside = await createRoot()
    const outsideFile = join(outside, 'secret.md')
    await writeFile(outsideFile, '区外正文')
    await writeSkill(root, 'linked', { 'SKILL.md': '# x' })
    try {
      await symlink(outsideFile, join(root, 'linked', 'linked.md'), 'file')
    } catch {
      ctx.skip()
      return
    }
    await expect(new FileSkillLoader(root).load('linked')).rejects.toThrow('技能目录不能包含链接')
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-'))
  roots.push(root)
  return root
}

async function writeSkill(
  root: string,
  skillId: string,
  files: Readonly<Record<string, string>>
): Promise<void> {
  const skillRoot = join(root, skillId)
  await mkdir(skillRoot, { recursive: true })
  for (const [relative, body] of Object.entries(files)) {
    const target = join(skillRoot, relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, body, 'utf8')
  }
}
