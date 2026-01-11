/**
 * @vafast/request-logger - API request logging middleware for Vafast
 * 
 * Features:
 * - Automatic sensitive data sanitization
 * - Pluggable storage adapters (MongoDB, custom)
 * - Async logging (non-blocking)
 * - Route-level log control (log: false in route definition, supports inheritance)
 * 
 * Uses vafast RouteRegistry to query route configurations at runtime,
 * similar to @vafast/webhook implementation.
 */
import type { Middleware } from 'vafast'
import { getRoute } from 'vafast'
import { sanitize, sanitizeHeaders, type SanitizeConfig } from './sanitize'

// ============ Types ============

export interface RequestLog {
  method: string
  url: string
  path: string
  headers: Record<string, string>
  body: unknown
  query: Record<string, string>
  response: {
    success?: boolean
    message?: string
    code?: number
  }
  status: number
  duration: number
  userId?: string
  appId?: string
  /** 认证类型（由调用方定义，如 apiKey、jwt 等） */
  authType?: string
  /** 服务标识（区分不同服务，如 auth-server、ones-server） */
  service?: string
  createdAt: Date
}

export interface ResponseLog {
  requestLogId: string
  success?: boolean
  message?: string
  code?: number
  data?: unknown
  createdAt: Date
}

/**
 * 存储适配器接口
 */
export interface StorageAdapter {
  /** 存储请求日志 */
  saveRequestLog(log: RequestLog): Promise<string>
  /** 存储响应详情 */
  saveResponseLog(log: ResponseLog): Promise<void>
}

export interface RequestLoggerConfig {
  /** 存储适配器 */
  storage: StorageAdapter
  /** 敏感数据清洗配置 */
  sanitize?: SanitizeConfig
  /** 获取用户 ID 的函数 */
  getUserId?: (req: Request) => string | undefined
  /** 获取应用 ID 的函数（用于多租户） */
  getAppId?: (req: Request) => string | undefined
  /** 获取认证类型的函数（如 apiKey、jwt 等） */
  getAuthType?: (req: Request) => string | undefined
  /** 服务标识（区分不同服务，如 auth-server、ones-server） */
  service?: string
  /** 错误回调 */
  onError?: (error: Error) => void
  /** 是否启用 @default true */
  enabled?: boolean
}

// ============ Middleware Factory ============

/**
 * 创建请求日志中间件
 * 
 * 日志排除：在路由定义中设置 log: false，支持嵌套继承（父路由设置会自动继承给子路由）
 * 
 * @example
 * ```typescript
 * import { createRequestLogger, createMongoAdapter } from '@vafast/request-logger'
 * import { mongoDb } from './mongodb'
 * 
 * const requestLogger = createRequestLogger({
 *   storage: createMongoAdapter(mongoDb, 'logs', 'logsResponse'),
 *   getUserId: (req) => getLocals(req)?.userInfo?.id,
 * })
 * 
 * server.use(requestLogger)
 * ```
 * 
 * 在路由定义中使用 log: false（支持嵌套继承）：
 * ```typescript
 * // 单个路由
 * { method: 'GET', path: '/health', log: false, handler: ... }
 * 
 * // 父路由设置，所有子路由继承
 * {
 *   path: '/logs',
 *   log: false,  // 所有子路由都不记录日志
 *   children: [
 *     { method: 'POST', path: '/find', handler: ... },
 *     { method: 'POST', path: '/search', handler: ... },
 *   ]
 * }
 * ```
 */
export function createRequestLogger(config: RequestLoggerConfig): Middleware {
  const {
    storage,
    sanitize: sanitizeConfig,
    getUserId,
    getAppId,
    getAuthType,
    service,
    onError = console.error,
    enabled = true,
  } = config

  return async (req: Request, next: () => Promise<Response>) => {
    if (!enabled) {
      return next()
    }

    const startTime = Date.now()
    const response = await next()

    // 异步记录日志，不阻塞响应
    recordLog(req, response, startTime, {
      storage,
      sanitizeConfig,
      getUserId,
      getAppId,
      getAuthType,
      service,
      onError,
    }).catch(onError)

    return response
  }
}

// ============ Internal Functions ============

interface RecordLogOptions {
  storage: StorageAdapter
  sanitizeConfig?: SanitizeConfig
  getUserId?: (req: Request) => string | undefined
  getAppId?: (req: Request) => string | undefined
  getAuthType?: (req: Request) => string | undefined
  service?: string
  onError: (error: Error) => void
}

/**
 * 检查路由是否配置了 log: false
 * 使用 vafast RouteRegistry 查询路由配置（支持嵌套继承）
 */
function shouldSkipLog(method: string, path: string): boolean {
  try {
    // RouteRegistry 使用完整路径 (fullPath) 作为 key，直接查询
    const route = getRoute<{ log?: boolean }>(method, path)
    return route?.log === false
  } catch {
    // RouteRegistry 未初始化时忽略错误
    return false
  }
}

async function recordLog(
  req: Request,
  response: Response,
  startTime: number,
  options: RecordLogOptions
) {
  const { storage, sanitizeConfig, getUserId, getAppId, getAuthType, service } = options

  const url = new URL(req.url)
  const path = url.pathname

  // 检查路由定义中的 log: false（通过 RouteRegistry 查询，支持嵌套继承）
  if (shouldSkipLog(req.method, path)) {
    return
  }

  // 解析请求体
  let body: unknown = null
  try {
    const clonedReq = req.clone()
    const contentType = req.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      body = await clonedReq.json()
    }
  } catch {
    // 忽略解析错误
  }

  // 解析响应体
  let responseData: { success?: boolean; message?: string; code?: number; data?: unknown } = {}
  try {
    const clonedRes = response.clone()
    responseData = await clonedRes.json()
  } catch {
    // 忽略解析错误
  }

  // 提取请求头
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    headers[key] = value
  })

  // 清洗敏感数据
  const sanitizedHeaders = sanitizeHeaders(headers, sanitizeConfig)
  const sanitizedBody = sanitize(body, sanitizeConfig)
  const sanitizedResponseData = sanitize(responseData.data, sanitizeConfig)

  const now = new Date()
  const duration = Date.now() - startTime

  // 获取用户 ID、应用 ID 和认证类型
  const userId = getUserId?.(req)
  const appId = getAppId?.(req)
  const authType = getAuthType?.(req)

  // 存储请求日志
  const requestLogId = await storage.saveRequestLog({
    method: req.method,
    url: req.url,
    path,
    headers: sanitizedHeaders,
    body: sanitizedBody,
    query: Object.fromEntries(url.searchParams),
    response: {
      success: responseData.success,
      message: responseData.message,
      code: responseData.code,
    },
    status: response.status,
    duration,
    userId,
    appId,
    authType,
    service,
    createdAt: now,
  })

  // 存储响应详情
  await storage.saveResponseLog({
    requestLogId,
    success: responseData.success,
    message: responseData.message,
    code: responseData.code,
    data: sanitizedResponseData,
    createdAt: now,
  })
}

// ============ MongoDB Adapter ============

/**
 * 创建 MongoDB 存储适配器
 * 
 * @example
 * ```typescript
 * import { Db } from 'mongodb'
 * import { createMongoAdapter } from '@vafast/request-logger'
 * 
 * const adapter = createMongoAdapter(db, 'logs', 'logsResponse')
 * ```
 */
export function createMongoAdapter(
  db: { collection: (name: string) => { insertOne: (doc: any) => Promise<{ insertedId: { toHexString: () => string } }> } },
  logsCollection: string = 'logs',
  logsResponseCollection: string = 'logsResponse'
): StorageAdapter {
  return {
    async saveRequestLog(log: RequestLog): Promise<string> {
      const result = await db.collection(logsCollection).insertOne({
        ...log,
        createAt: log.createdAt,
        updateAt: log.createdAt,
      })
      return result.insertedId.toHexString()
    },

    async saveResponseLog(log: ResponseLog): Promise<void> {
      await db.collection(logsResponseCollection).insertOne({
        logsId: log.requestLogId,
        ...log,
        createAt: log.createdAt,
        updateAt: log.createdAt,
      })
    },
  }
}

// ============ Console Adapter (for development) ============

/**
 * 创建控制台存储适配器（用于开发调试）
 */
export function createConsoleAdapter(): StorageAdapter {
  let idCounter = 0

  return {
    async saveRequestLog(log: RequestLog): Promise<string> {
      const id = `log_${++idCounter}`
      console.log(`[REQUEST] ${log.method} ${log.path} ${log.status} ${log.duration}ms`)
      return id
    },

    async saveResponseLog(log: ResponseLog): Promise<void> {
      if (!log.success) {
        console.log(`[RESPONSE ERROR] ${log.message}`)
      }
    },
  }
}

// ============ Re-exports ============

export { sanitize, sanitizeHeaders, type SanitizeConfig } from './sanitize'
export default createRequestLogger

