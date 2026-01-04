/**
 * @vafast/request-logger - API request logging middleware for Vafast
 * 
 * Features:
 * - Automatic sensitive data sanitization
 * - Pluggable storage adapters (MongoDB, custom)
 * - Async logging (non-blocking)
 * - Path exclusion support
 */
import type { Middleware } from 'vafast'
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
  /** 排除的路径（支持字符串或正则） */
  excludePaths?: (string | RegExp)[]
  /** 敏感数据清洗配置 */
  sanitize?: SanitizeConfig
  /** 获取用户 ID 的函数 */
  getUserId?: (req: Request) => string | undefined
  /** 获取应用 ID 的函数（用于多租户） */
  getAppId?: (req: Request) => string | undefined
  /** 错误回调 */
  onError?: (error: Error) => void
  /** 是否启用 @default true */
  enabled?: boolean
}

// ============ Middleware Factory ============

/**
 * 创建请求日志中间件
 * 
 * @example
 * ```typescript
 * import { createRequestLogger, createMongoAdapter } from '@vafast/request-logger'
 * import { mongoDb } from './mongodb'
 * 
 * const requestLogger = createRequestLogger({
 *   storage: createMongoAdapter(mongoDb, 'logs', 'logsResponse'),
 *   excludePaths: ['/health', '/metrics'],
 *   getUserId: (req) => getLocals(req)?.userInfo?.id,
 * })
 * 
 * server.use(requestLogger)
 * ```
 */
export function createRequestLogger(config: RequestLoggerConfig): Middleware {
  const {
    storage,
    excludePaths = [],
    sanitize: sanitizeConfig,
    getUserId,
    getAppId,
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
      excludePaths,
      sanitizeConfig,
      getUserId,
      getAppId,
      onError,
    }).catch(onError)

    return response
  }
}

// ============ Internal Functions ============

interface RecordLogOptions {
  storage: StorageAdapter
  excludePaths: (string | RegExp)[]
  sanitizeConfig?: SanitizeConfig
  getUserId?: (req: Request) => string | undefined
  getAppId?: (req: Request) => string | undefined
  onError: (error: Error) => void
}

async function recordLog(
  req: Request,
  response: Response,
  startTime: number,
  options: RecordLogOptions
) {
  const { storage, excludePaths, sanitizeConfig, getUserId, getAppId } = options

  const url = new URL(req.url)
  const path = url.pathname

  // 检查是否需要排除
  const shouldExclude = excludePaths.some(pattern => {
    if (typeof pattern === 'string') {
      return path.includes(pattern)
    }
    return pattern.test(path)
  })

  if (shouldExclude) {
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

  // 获取用户 ID 和应用 ID
  const userId = getUserId?.(req)
  const appId = getAppId?.(req)

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

