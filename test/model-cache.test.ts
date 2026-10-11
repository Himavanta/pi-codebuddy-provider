import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'

import type { PiModelConfig } from '../src/models.ts'

// 缓存路径由 homedir() 推导，测试前把 HOME 指到临时目录，避免污染真实 ~/.pi
const tmpHome = await fs.mkdtemp(join(os.tmpdir(), 'cb-cache-test-'))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => tmpHome }
})

const { readCachedModels, writeCachedModels, getModelCachePath } =
  await import('../src/model-cache.ts')

function model(id: string, extra: Partial<PiModelConfig> = {}): PiModelConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    ...extra
  }
}

describe('model-cache', () => {
  const cachePath = getModelCachePath()

  beforeEach(async () => {
    await fs.rm(cachePath, { force: true })
  })
  afterEach(async () => {
    await fs.rm(cachePath, { force: true })
  })

  it('缓存路径落在 pi agent 目录下', () => {
    expect(cachePath).toContain('codebuddy-models-cache.json')
  })

  it('无缓存时返回空数组（不抛错）', async () => {
    await expect(readCachedModels()).resolves.toEqual([])
  })

  it('写入后可原样读回', async () => {
    const models = [model('hy4-preview', { contextWindow: 1000000, maxTokens: 64000 })]
    await writeCachedModels(models)
    const got = await readCachedModels()
    expect(got).toHaveLength(1)
    expect(got[0]!.id).toBe('hy4-preview')
    expect(got[0]!.contextWindow).toBe(1000000)
    expect(got[0]!.maxTokens).toBe(64000)
  })

  it('空数组不写盘（避免用空列表覆盖有效缓存）', async () => {
    await writeCachedModels([model('auto')])
    await writeCachedModels([])
    expect(await readCachedModels()).toHaveLength(1)
  })

  it('损坏的 JSON 返回空数组而不抛错', async () => {
    await fs.mkdir(join(tmpHome, '.pi', 'agent'), { recursive: true })
    await fs.writeFile(cachePath, '{{{broken', 'utf8')
    await expect(readCachedModels()).resolves.toEqual([])
  })

  it('version 不匹配返回空数组', async () => {
    await fs.mkdir(join(tmpHome, '.pi', 'agent'), { recursive: true })
    await fs.writeFile(
      cachePath,
      JSON.stringify({ version: 999, updatedAt: Date.now(), models: [model('x')] }),
      'utf8'
    )
    await expect(readCachedModels()).resolves.toEqual([])
  })

  it('过滤缺 id 的非法条目', async () => {
    await fs.mkdir(join(tmpHome, '.pi', 'agent'), { recursive: true })
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        models: [model('keep'), { name: 'no-id' }, 'garbage']
      }),
      'utf8'
    )
    const got = await readCachedModels()
    expect(got).toHaveLength(1)
    expect(got[0]!.id).toBe('keep')
  })

  it('过期缓存仍作为启动种子返回（有模型好过只有 auto）', async () => {
    await fs.mkdir(join(tmpHome, '.pi', 'agent'), { recursive: true })
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
    await fs.writeFile(
      cachePath,
      JSON.stringify({ version: 1, updatedAt: stale, models: [model('old')] }),
      'utf8'
    )
    expect(await readCachedModels()).toHaveLength(1)
  })

  it('写入失败不抛出（只读环境下不阻断启动）', async () => {
    // 把 agent 目录替换成一个文件，mkdir 必然失败，验证 writeCachedModels 不向上抛
    const agentDir = join(tmpHome, '.pi', 'agent')
    await fs.rm(agentDir, { recursive: true, force: true })
    await fs.mkdir(join(tmpHome, '.pi'), { recursive: true })
    await fs.writeFile(agentDir, 'not-a-dir', 'utf8')
    await expect(writeCachedModels([model('x')])).resolves.toBeUndefined()
    await fs.rm(agentDir, { force: true })
  })
})
