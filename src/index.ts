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
import { defineMiddleware } from 'vafast'
import { getRoute } from 'vafast'
import { sanitize, sanitizeHeaders, type SanitizeConfig } from './sanitize'

// ============ Types ============

/** 请求信息 */
export interface RequestData {
  method: string
  url: string
  path: string
  headers: Record<string, string>
  body: unknown
  query: Record<string, string>
  status: number
  duration: number
  userId?: string
  appId?: string
  /** 认证类型（由调用方定义，如 apiKey、jwt 等） */
  authType?: string
  /** 服务标识（区分不同服务，如 auth-server、ones-server） */
  service?: string
  /** 客户端 IP 地址 */
  ip?: string
  /** 浏览器/设备信息 */
  userAgent?: string
  /** 分布式追踪 ID */
  traceId?: string
  createdAt: Date
}

/** 响应信息 */
export interface ResponseData {
  success?: boolean
  message?: string
  code?: number
  data?: unknown
}

/** 完整日志数据 */
export interface LogData {
  request: RequestData
  response: ResponseData
}

/**
 * 存储适配器接口（单一方法）
 */
export interface StorageAdapter {
  /** 存储完整日志（请求+响应） */
  saveLog(log: LogData): Promise<void>
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
  /** 获取客户端 IP 的函数 */
  getClientIp?: (req: Request) => string | undefined
  /** 获取分布式追踪 ID 的函数 */
  getTraceId?: (req: Request) => string | undefined
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
 *   getUserId: (req) => (req as any).__locals?.userInfo?.id,
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
export function createRequestLogger(config: RequestLoggerConfig) {
  const {
    storage,
    sanitize: sanitizeConfig,
    getUserId,
    getAppId,
    getAuthType,
    getClientIp,
    getTraceId,
    service,
    onError = console.error,
    enabled = true,
  } = config

  return defineMiddleware(async (req, next) => {
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
      getClientIp,
      getTraceId,
      service,
      onError,
    }).catch(onError)

    return response
  })
}

// ============ Internal Functions ============

interface RecordLogOptions {
  storage: StorageAdapter
  sanitizeConfig?: SanitizeConfig
  getUserId?: (req: Request) => string | undefined
  getAppId?: (req: Request) => string | undefined
  getAuthType?: (req: Request) => string | undefined
  getClientIp?: (req: Request) => string | undefined
  getTraceId?: (req: Request) => string | undefined
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
  const { storage, sanitizeConfig, getUserId, getAppId, getAuthType, getClientIp, getTraceId, service } = options

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

  // 获取用户信息
  const userId = getUserId?.(req)
  const appId = getAppId?.(req)
  const authType = getAuthType?.(req)
  
  // 获取客户端信息
  const ip = getClientIp?.(req)
  const userAgent = req.headers.get('user-agent') || undefined
  const traceId = getTraceId?.(req)

  // 存储完整日志（请求+响应）
  await storage.saveLog({
    request: {
      method: req.method,
      url: req.url,
      path,
      headers: sanitizedHeaders,
      body: sanitizedBody,
      query: Object.fromEntries(url.searchParams),
      status: response.status,
      duration,
      userId,
      appId,
      authType,
      service,
      ip,
      userAgent,
      traceId,
      createdAt: now,
    },
    response: {
      success: responseData.success,
      message: responseData.message,
      code: responseData.code,
      data: sanitizedResponseData,
    },
  })
}

// ============ MongoDB Adapter ============

/**
 * 创建 MongoDB 存储适配器
 * 
 * 内部分表存储：
 * - 请求主体 → logsCollection
 * - 响应详情 → logsResponseCollection（通过 logsId 关联）
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
  db: { collection: (name: string) => { insertOne: (doc: unknown) => Promise<{ insertedId: { toHexString: () => string } }> } },
  logsCollection: string = 'logs',
  logsResponseCollection: string = 'logsResponse'
): StorageAdapter {
  return {
    async saveLog(log: LogData): Promise<void> {
      const { request, response } = log
      const now = request.createdAt

      // 1. 存储请求主体
      const result = await db.collection(logsCollection).insertOne({
        method: request.method,
        url: request.url,
        path: request.path,
        headers: request.headers,
        body: request.body,
        query: request.query,
        response: {
          success: response.success,
          message: response.message,
          code: response.code,
        },
        status: request.status,
        duration: request.duration,
        userId: request.userId,
        appId: request.appId,
        authType: request.authType,
        service: request.service,
        ip: request.ip,
        userAgent: request.userAgent,
        traceId: request.traceId,
        createAt: now,
        updateAt: now,
      })

      const logId = result.insertedId.toHexString()

      // 2. 存储响应详情
      await db.collection(logsResponseCollection).insertOne({
        logsId: logId,
        success: response.success,
        message: response.message,
        code: response.code,
        data: response.data,
        createAt: now,
      })
    },
  }
}

// ============ Console Adapter (for development) ============

/**
 * 创建控制台存储适配器（用于开发调试）
 */
export function createConsoleAdapter(): StorageAdapter {
  return {
    async saveLog(log: LogData): Promise<void> {
      const { request, response } = log
      console.log(`[LOG] ${request.method} ${request.path} ${request.status} ${request.duration}ms`)
      if (!response.success) {
        console.log(`[ERROR] ${response.message}`)
      }
    },
  }
}

// ============ HTTP Adapter ============

export interface HttpAdapterConfig {
  /** 日志写入 URL */
  url: string
  /** 自定义请求头（如认证信息） */
  headers?: Record<string, string>
  /** 超时时间（毫秒），默认 5000 */
  timeout?: number
  /** 
   * 自定义日志字段映射
   * @param log 完整日志数据（请求+响应）
   * @returns 发送到服务端的数据
   */
  mapLog?: (log: LogData) => Record<string, unknown>
  /** 错误回调 */
  onError?: (error: Error) => void
}

/**
 * 创建 HTTP 存储适配器
 * 
 * 适用于微服务架构，将日志通过 HTTP API 发送到远程日志服务
 * 
 * 特点：
 * - 单次 HTTP 请求
 * - 服务端负责分表存储（logs + logsResponse）
 * 
 * @example
 * ```typescript
 * const adapter = createHttpAdapter({
 *   url: 'http://log-server/api/logs/ingest',
 *   headers: {
 *     'Authorization': 'Bearer your-api-key',
 *   },
 * })
 * ```
 */
export function createHttpAdapter(config: HttpAdapterConfig): StorageAdapter {
  const {
    url,
    headers = {},
    timeout = 5000,
    mapLog,
    onError,
  } = config

  // 默认日志映射
  const defaultMapLog = (log: LogData): Record<string, unknown> => ({
    // 请求信息
    method: log.request.method,
    url: log.request.url,
    path: log.request.path,
    headers: log.request.headers,
    body: log.request.body,
    query: log.request.query,
    status: log.request.status,
    duration: log.request.duration,
    userId: log.request.userId,
    appId: log.request.appId,
    authType: log.request.authType,
    service: log.request.service,
    ip: log.request.ip,
    userAgent: log.request.userAgent,
    traceId: log.request.traceId,
    createdAt: log.request.createdAt.toISOString(),
    // 响应摘要
    response: {
      success: log.response.success,
      message: log.response.message,
      code: log.response.code,
    },
    // 响应详情
    responseData: log.response.data,
  })

  // 带超时的 fetch
  const fetchWithTimeout = async (targetUrl: string, options: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const res = await fetch(targetUrl, {
        ...options,
        signal: controller.signal,
      })
      return res
    } finally {
      clearTimeout(timeoutId)
    }
  }

  return {
    async saveLog(log: LogData): Promise<void> {
      try {
        const body = (mapLog || defaultMapLog)(log)

        const res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        }
      } catch (error) {
        onError?.(error as Error)
      }
    },
  }
}

// ============ Re-exports ============

export { sanitize, sanitizeHeaders, type SanitizeConfig } from './sanitize'
export default createRequestLogger
