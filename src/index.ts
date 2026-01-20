/**
 * @vafast/request-logger - API 请求日志中间件
 * 
 * 特性：
 * - 自动敏感数据脱敏
 * - HTTP 远程日志服务
 * - 异步非阻塞记录
 * - 路由级别日志控制（路由定义中设置 log: false）
 * 
 * @example
 * ```typescript
 * import { requestLogger } from '@vafast/request-logger'
 * 
 * server.use(requestLogger({
 *   url: 'http://log-server:9005/api/logs/ingest',
 *   service: 'auth-server',
 *   getUserId: (req) => req.__locals?.userInfo?.id,
 * }))
 * ```
 */
import { defineMiddleware, getRoute } from 'vafast'
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
  authType?: string
  service?: string
  ip?: string
  userAgent?: string
  traceId?: string
  createdAt: Date
}

/** 响应数据（完整响应体） */
export type ResponseData = unknown

/** 完整日志数据 */
export interface LogData {
  request: RequestData
  response: ResponseData
}

/** 请求日志配置 */
export interface RequestLoggerOptions {
  /** 日志服务 URL */
  url: string
  /** 服务标识（如 auth-server、ones-server） */
  service: string
  /** 自定义请求头（如认证信息） */
  headers?: Record<string, string>
  /** 超时时间（毫秒），默认 5000 */
  timeout?: number
  /** 敏感数据清洗配置 */
  sanitize?: SanitizeConfig
  /** 错误回调 */
  onError?: (error: Error) => void
  /** 是否启用 @default true */
  enabled?: boolean
  /** 排除的路径列表（精确匹配或正则），这些路径不记录日志 */
  excludePaths?: (string | RegExp)[]
}


// ============ Middleware ============

/**
 * 请求日志中间件
 * 
 * @example
 * ```typescript
 * import { requestLogger } from '@vafast/request-logger'
 * 
 * server.use(requestLogger({
 *   url: 'http://log-server:9005/api/logs/ingest',
 *   service: 'auth-server',
 *   auth: { apiKeyId: 'xxx', apiKeySecret: 'yyy' },
 * }))
 * ```
 */
export function requestLogger(options: RequestLoggerOptions) {
  const {
    url,
    service,
    headers = {},
    timeout = 5000,
    sanitize: sanitizeConfig,
    onError = console.error,
    enabled = true,
    excludePaths = [],
  } = options

  return defineMiddleware(async (req, next) => {
    if (!enabled) return next()

    const startTime = Date.now()
    const response = await next()

    // 异步记录日志，不阻塞响应
    recordLog(req, response, startTime, {
      url,
      service,
      headers,
      timeout,
      sanitizeConfig,
      onError,
      excludePaths,
    }).catch(onError)

    return response
  })
}

/** @deprecated 使用 requestLogger 代替 */
export const createRequestLogger = requestLogger

// ============ Internal ============

interface RecordLogOptions {
  url: string
  service: string
  headers: Record<string, string>
  timeout: number
  sanitizeConfig?: SanitizeConfig
  onError: (error: Error) => void
  excludePaths: (string | RegExp)[]
}

/** 检查路由是否配置了 log: false */
function shouldSkipLog(method: string, path: string): boolean {
  try {
    const route = getRoute<{ log?: boolean }>(method, path)
    return route?.log === false
  } catch {
    return false
  }
}

/** 检查路径是否在排除列表中 */
function isPathExcluded(path: string, excludePaths: (string | RegExp)[]): boolean {
  return excludePaths.some(pattern => {
    if (typeof pattern === 'string') {
      return path === pattern || path.startsWith(pattern + '/')
    }
    return pattern.test(path)
  })
}

/** 带超时的 fetch */
async function fetchWithTimeout(
  targetUrl: string,
  options: RequestInit,
  timeout: number
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    return await fetch(targetUrl, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function recordLog(
  req: Request,
  response: Response,
  startTime: number,
  options: RecordLogOptions
) {
  const { url: logUrl, service, headers: customHeaders, timeout, sanitizeConfig, onError, excludePaths } = options

  const reqUrl = new URL(req.url)
  const path = reqUrl.pathname

  // 检查路径是否在排除列表中
  if (isPathExcluded(path, excludePaths)) return

  // 检查路由是否禁用日志
  if (shouldSkipLog(req.method, path)) return

  // 解析请求体
  let body: unknown = null
  try {
    const contentType = req.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      body = await req.clone().json()
    }
  } catch {
    // 忽略
  }

  // 解析响应体
  let responseData: ResponseData = null
  try {
    responseData = await response.clone().json()
  } catch {
    // 忽略（非 JSON 响应）
  }

  // 提取请求头
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    headers[key] = value
  })

  // 清洗敏感数据
  const sanitizedHeaders = sanitizeHeaders(headers, sanitizeConfig)
  const sanitizedBody = sanitize(body, sanitizeConfig)
  const sanitizedResponseData = sanitize(responseData, sanitizeConfig)

  // 构建日志数据（业务字段由 log-server 从 headers 解析）
  const logBody = {
    method: req.method,
    url: req.url,
    path,
    headers: sanitizedHeaders,
    body: sanitizedBody,
    query: Object.fromEntries(reqUrl.searchParams),
    status: response.status,
    duration: Date.now() - startTime,
    service,
    createdAt: new Date().toISOString(),
    response: sanitizedResponseData, // 直接存储完整响应数据
  }

  // 发送到日志服务
  try {
    const res = await fetchWithTimeout(
      logUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...customHeaders },
        body: JSON.stringify(logBody),
      },
      timeout
    )

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }
  } catch (error) {
    onError(error as Error)
  }
}

// ============ Re-exports ============

export { sanitize, sanitizeHeaders, type SanitizeConfig } from './sanitize'
export default requestLogger
