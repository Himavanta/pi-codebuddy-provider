// 持久化已发现的模型列表，消除启动时的模型发现竞态
//
// 问题：会话恢复走同步路径，而模型发现（GET /v3/config）是异步且带 5s 超时。
// 扩展初始化时只注册了 fallback（仅 `auto`），随后才 `void discoverAndReregister(...)`。
// 若会话在发现返回前恢复，getModel("codebuddy","hy4-preview") === undefined
//   → warning "Could not restore model ... (model no longer exists)"
//   → 回落到 auto，表现为"每次都得重新配一次模型"。
//
// 方案：把上次成功发现的模型落盘，启动时先同步载入缓存再注册，
// 网络发现完成后刷新缓存。缓存只是启动期的种子，不替代网络发现。
//
// 刻意不写 models.json：codebuddy 是扩展注册的 provider，其鉴权由 auth-fetch
// 拦截器注入（自定义 streamSimple）。在 models.json 里声明同 id 的原生 provider
// 会引入 baseUrl/api 的重复定义，并可能与 pi-model-manager 的跨进程锁相互干扰。

import * as fs from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'

import type { PiModelConfig } from './models.ts'

const CACHE_VERSION = 1
// 缓存过期只用于日志提示；过期后仍会作为启动种子使用（有 15 个模型好过只有 auto）
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

interface CacheDocument {
  version: number
  updatedAt: number
  models: PiModelConfig[]
}

export function getModelCachePath(): string {
  return join(homedir(), CONFIG_DIR_NAME || '.pi', 'agent', 'codebuddy-models-cache.json')
}

function isValidModel(value: unknown): value is PiModelConfig {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string' && m.id.length > 0
}

/** 读取缓存的模型列表；缺失、损坏或为空时返回 []。永不抛错。 */
export async function readCachedModels(): Promise<PiModelConfig[]> {
  try {
    const raw = await fs.readFile(getModelCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CacheDocument>
    if (parsed?.version !== CACHE_VERSION) return []
    if (!Array.isArray(parsed.models)) return []
    const models = parsed.models.filter(isValidModel)
    if (models.length === 0) return []
    if (typeof parsed.updatedAt === 'number' && Date.now() - parsed.updatedAt > STALE_AFTER_MS) {
      // 过期但仍返回：种子再旧也比只有 auto 强，发现成功后会被覆盖。
      // 写 stderr 而非 stdout：pi 在非交互模式下接管 stdout（重定向到 stderr），
      // stdout 仅承载程序输出，诊断信息不能混入。
      // 用 error 级别（非 warn）：属常规路径噪声，仅备查。
      console.error('[codebuddy] model cache is stale (>7d), will refresh after discovery')
    }
    return models
  } catch {
    return []
  }
}

/** 写入缓存（先写临时文件再 rename，避免读到半截内容）。永不抛错。 */
export async function writeCachedModels(models: PiModelConfig[]): Promise<void> {
  if (!models?.length) return
  const path = getModelCachePath()
  const doc: CacheDocument = { version: CACHE_VERSION, updatedAt: Date.now(), models }
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
    await fs.rename(tmp, path)
  } catch {
    // 缓存写失败不影响运行，下次仍会重新发现
  }
}
