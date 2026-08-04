/**
 * @vafast/request-logger - API 请求日志中间件
 *
 * 特性：
 * - 自动敏感数据脱敏
 * - HTTP 远程日志服务
 * - 异步非阻塞记录
 * - 路由级别日志控制（路由定义中设置 log: false）
 * - 熔断器：连续失败后暂停上报，避免无谓等待
 * - 错误节流：同类错误在一段时间内只打一次日志
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
  /**
   * Ones App Client：web / desktop / ios / android
   * 用户端可选；服务间调用不带
   */
  clientKey?: string
  /**
   * 运行时平台：browser / darwin / win32 / linux / ios / android
   * 用户端可选；服务间调用不带
   */
  platform?: string
  /** 应用版本（用户端可选） */
  appVersion?: string
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

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  /** 触发熔断的连续失败次数，默认 5 */
  failureThreshold?: number
  /** 熔断恢复时间（毫秒），默认 60000（1分钟） */
  resetTimeout?: number
}

/** 错误节流配置 */
export interface ErrorThrottleConfig {
  /** 同类错误的节流间隔（毫秒），默认 60000（1分钟） */
  interval?: number
}

/** stdout 双写配置 */
export interface StdoutConfig {
  /** 是否启用 stdout 输出 @default true */
  enabled?: boolean
  /** 输出格式 @default 'json' */
  format?: 'json' | 'text'
  /** 是否包含请求体 @default true */
  includeBody?: boolean
  /** 是否包含响应体（可能很大）@default false */
  includeResponse?: boolean
}

/** 业务上下文提取参数 */
export interface RequestLoggerContext {
  req: Request
  response: Response
  method: string
  url: URL
  path: string
  headers: Record<string, string>
  body: unknown
  responseData: unknown
}

type ContextGetter = (
  context: RequestLoggerContext
) => string | undefined | Promise<string | undefined>

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
  onError?: (error: Error, context: { droppedCount: number }) => void
  /** 是否启用 @default true */
  enabled?: boolean
  /** 排除的路径列表（精确匹配或正则），这些路径不记录日志 */
  excludePaths?: (string | RegExp)[]
  /** 熔断器配置 */
  circuitBreaker?: CircuitBreakerConfig
  /** 错误节流配置 */
  errorThrottle?: ErrorThrottleConfig
  /** stdout 双写配置（用于 K8s 日志采集） */
  stdout?: StdoutConfig
  /** 日志采样率 (0-1)，1 表示记录所有请求，0.1 表示只记录 10% @default 1 */
  sampleRate?: number
  /** 请求 ID 的 header 名称，用于分布式追踪 @default 'x-request-id' */
  requestIdHeader?: string
  /** 自定义 appId 提取逻辑，适用于支付回调等无 app-id header 的请求 */
  getAppId?: ContextGetter
  /** 自定义 userId 提取逻辑 */
  getUserId?: ContextGetter
  /** 自定义认证类型提取逻辑 */
  getAuthType?: ContextGetter
}

// ============ Circuit Breaker ============

type CircuitState = 'closed' | 'open' | 'half-open'

class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private lastFailureTime = 0
  private readonly failureThreshold: number
  private readonly resetTimeout: number

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5
    this.resetTimeout = config.resetTimeout ?? 60000
  }

  /** 检查是否允许请求 */
  canRequest(): boolean {
    if (this.state === 'closed') return true

    if (this.state === 'open') {
      // 检查是否到了恢复时间
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = 'half-open'
        return true
      }
      return false
    }

    // half-open 状态允许一个请求通过测试
    return true
  }

  /** 记录成功 */
  recordSuccess(): void {
    this.failureCount = 0
    this.state = 'closed'
  }

  /** 记录失败 */
  recordFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open'
    }
  }

  /** 获取当前状态信息 */
  getStatus(): { state: CircuitState; failureCount: number } {
    return { state: this.state, failureCount: this.failureCount }
  }
}

// ============ Error Throttle ============

class ErrorThrottle {
  private lastErrorTime = 0
  private droppedCount = 0
  private readonly interval: number

  constructor(config: ErrorThrottleConfig = {}) {
    this.interval = config.interval ?? 60000
  }

  /** 检查是否应该打印错误，返回 { shouldLog, droppedCount } */
  shouldLog(): { shouldLog: boolean; droppedCount: number } {
    const now = Date.now()

    if (now - this.lastErrorTime >= this.interval) {
      const dropped = this.droppedCount
      this.lastErrorTime = now
      this.droppedCount = 0
      return { shouldLog: true, droppedCount: dropped }
    }

    this.droppedCount++
    return { shouldLog: false, droppedCount: 0 }
  }
}

// ============ Default Error Handler ============

/**
 * 默认错误处理函数
 * - 输出结构化 JSON 到 stdout（K8s 友好）
 * - 使用 warn 级别（level: 40）
 * - 包含 droppedCount 信息
 */
function defaultOnError(error: Error, context: { droppedCount: number }): void {
  const { droppedCount } = context
  const log = {
    level: 40, // warn
    time: Date.now(),
    errorName: error.name,
    errorMessage: error.message,
    droppedCount,
    msg:
      droppedCount > 0
        ? `request-logger 上报失败 (已忽略 ${droppedCount} 条相同错误)`
        : 'request-logger 上报失败',
  }
  console.log(JSON.stringify(log))
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
    onError = defaultOnError,
    enabled = true,
    excludePaths = [],
    circuitBreaker: circuitBreakerConfig,
    errorThrottle: errorThrottleConfig,
    stdout: stdoutConfig,
    sampleRate = 1,
    requestIdHeader = 'x-request-id',
    getAppId,
    getUserId,
    getAuthType,
  } = options

  // 创建熔断器和错误节流器实例
  const circuitBreaker = new CircuitBreaker(circuitBreakerConfig)
  const errorThrottle = new ErrorThrottle(errorThrottleConfig)

  return defineMiddleware(async (req, next) => {
    if (!enabled) return next()

    const reqUrl = new URL(req.url)
    const path = reqUrl.pathname

    // 这些判断必须发生在读取 body 前，避免无日志路由产生额外开销。
    if (isPathExcluded(path, excludePaths)) return next()
    if (shouldSkipLog(req.method, path)) return next()

    // 日志采样：随机跳过部分请求
    if (sampleRate < 1 && Math.random() > sampleRate) {
      return next()
    }

    // Fetch Request body 是一次性流。必须在业务处理前用 clone 读取，
    // 否则路由/框架消费 body 后，日志侧只能读到空 body。
    const requestBody = await parseRequestBody(req)
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
      circuitBreaker,
      errorThrottle,
      stdoutConfig,
      requestIdHeader,
      getAppId,
      getUserId,
      getAuthType,
      requestBody,
    }).catch(() => {
      // 错误已在 recordLog 内部处理，这里静默忽略
    })

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
  onError: (error: Error, context: { droppedCount: number }) => void
  circuitBreaker: CircuitBreaker
  errorThrottle: ErrorThrottle
  stdoutConfig?: StdoutConfig
  requestIdHeader: string
  getAppId?: ContextGetter
  getUserId?: ContextGetter
  getAuthType?: ContextGetter
  requestBody: unknown
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
function isPathExcluded(
  path: string,
  excludePaths: (string | RegExp)[]
): boolean {
  return excludePaths.some((pattern) => {
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

/** 从请求中提取客户端 IP */
function getClientIp(req: Request): string | undefined {
  // 按优先级尝试获取真实 IP
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    // X-Forwarded-For 可能包含多个 IP，第一个是客户端真实 IP
    return forwarded.split(',')[0].trim()
  }
  return (
    req.headers.get('x-real-ip') ??
    req.headers.get('cf-connecting-ip') ?? // Cloudflare
    req.headers.get('true-client-ip') ?? // Akamai
    undefined
  )
}

/** 从请求中提取 Request ID */
function getRequestId(req: Request, headerName: string): string | undefined {
  // 优先从 req.id 获取（如果使用了 @vafast/request-id 中间件）
  const reqWithId = req as Request & { id?: string }
  if (reqWithId.id) {
    return reqWithId.id
  }
  // 否则从 header 获取
  return req.headers.get(headerName) ?? undefined
}

/** 读取约定请求头；空串视为缺失，统一返回 null */
function readNonEmptyHeader(headers: Record<string, string>, name: string): string | null {
  const value = headers[name]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** 从原始 Authorization 解析认证类型，必须发生在 headers 脱敏前 */
function getAuthTypeFromHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization
  if (auth?.startsWith('Bearer ak_')) return 'apiKey'
  if (auth?.startsWith('Bearer eyJ')) return 'jwt'
  return undefined
}

/** 从原始 JWT 解析 userId，不验证签名，仅用于日志归属 */
function getUserIdFromHeaders(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization
  if (!auth?.startsWith('Bearer eyJ')) return undefined

  try {
    const token = auth.slice(7)
    const parts = token.split('.')
    if (parts.length !== 3) return undefined

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return payload.sub || payload.userId || payload.id || undefined
  }
  catch {
    return undefined
  }
}

/** 根据状态码获取日志级别 */
function getLogLevel(status: number): number {
  if (status >= 500) return 50 // ERROR
  if (status >= 400) return 40 // WARN
  return 30 // INFO
}

function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of formData.entries()) {
    const normalizedValue = value instanceof File
      ? { name: value.name, type: value.type, size: value.size }
      : value
    const currentValue = result[key]

    if (currentValue === undefined) {
      result[key] = normalizedValue
    }
    else if (Array.isArray(currentValue)) {
      currentValue.push(normalizedValue)
    }
    else {
      result[key] = [currentValue, normalizedValue]
    }
  }

  return result
}

async function parseRequestBody(req: Request): Promise<unknown> {
  const methodsWithBody = ['POST', 'PUT', 'PATCH', 'DELETE']
  if (!methodsWithBody.includes(req.method)) return null

  const contentType = req.headers.get('content-type') || ''
  try {
    if (contentType.includes('application/json')) {
      return await req.clone().json()
    }

    if (contentType.includes('application/x-www-form-urlencoded')) {
      return formDataToObject(await req.clone().formData())
    }

    if (contentType.includes('multipart/form-data')) {
      return formDataToObject(await req.clone().formData())
    }

    if (
      contentType.includes('text/plain')
      || contentType.includes('application/xml')
      || contentType.includes('text/xml')
      || contentType.includes('application/graphql')
    ) {
      return await req.clone().text()
    }
  }
  catch {
    // 忽略解析错误（如空 body、无效 JSON、无效表单等）
  }

  return null
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || ''

  try {
    if (contentType.includes('application/json')) {
      return await response.clone().json()
    }

    if (
      contentType.includes('text/')
      || contentType.includes('application/xml')
      || contentType.includes('application/graphql')
    ) {
      return await response.clone().text()
    }
  }
  catch {
    // 忽略（非 JSON/文本响应、流读取失败等）
  }

  return null
}

async function resolveContextValue(
  getter: ContextGetter | undefined,
  context: RequestLoggerContext,
  fallback: string | undefined
): Promise<string | undefined> {
  if (!getter) return fallback
  return (await getter(context)) || fallback
}

async function recordLog(
  req: Request,
  response: Response,
  startTime: number,
  options: RecordLogOptions
) {
  const {
    url: logUrl,
    service,
    headers: customHeaders,
    timeout,
    sanitizeConfig,
    onError,
    circuitBreaker,
    errorThrottle,
    stdoutConfig,
    requestIdHeader,
    getAppId,
    getUserId,
    getAuthType,
    requestBody,
  } = options

  const reqUrl = new URL(req.url)
  const path = reqUrl.pathname
  const body = requestBody

  // 解析响应体
  const responseData: ResponseData = await parseResponseBody(response)

  // 提取请求头
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    headers[key] = value
  })

  const context: RequestLoggerContext = {
    req,
    response,
    method: req.method,
    url: reqUrl,
    path,
    headers,
    body,
    responseData,
  }

  const appId = await resolveContextValue(getAppId, context, headers['app-id'])
  const authType = await resolveContextValue(
    getAuthType,
    context,
    getAuthTypeFromHeaders(headers)
  )
  const userId = await resolveContextValue(
    getUserId,
    context,
    getUserIdFromHeaders(headers)
  )
  // 端字段在脱敏前从约定头解析，作为 ingest 顶层字段（不依赖 log-server 再从 headers 兜底）
  const clientKey = readNonEmptyHeader(headers, 'client-key')
  const platform = readNonEmptyHeader(headers, 'x-platform')
  const appVersion = readNonEmptyHeader(headers, 'x-app-version')

  // 清洗敏感数据
  const sanitizedHeaders = sanitizeHeaders(headers, sanitizeConfig)
  const sanitizedBody = sanitize(body, sanitizeConfig)
  const sanitizedResponseData = sanitize(responseData, sanitizeConfig)

  const duration = Date.now() - startTime

  // 提取客户端 IP 和 Request ID
  const clientIp = getClientIp(req)
  const requestId = getRequestId(req, requestIdHeader)

  // 构建日志数据（业务/端字段均在脱敏前解析后写入顶层）
  const logBody: Record<string, unknown> = {
    method: req.method,
    url: req.url,
    path,
    headers: sanitizedHeaders,
    body: sanitizedBody,
    query: Object.fromEntries(reqUrl.searchParams),
    status: response.status,
    duration,
    service,
    appId: appId ?? null,
    authType: authType ?? null,
    userId: userId ?? null,
    ip: clientIp ?? null,
    traceId: requestId ?? null,
    userAgent: headers['user-agent'] ?? null,
    createdAt: new Date().toISOString(),
    response: sanitizedResponseData, // 直接存储完整响应数据
  }

  // 可选字段（只在有值时添加；端维度仅用户端流量）
  if (clientKey) logBody.clientKey = clientKey
  if (platform) logBody.platform = platform
  if (appVersion) logBody.appVersion = appVersion
  if (clientIp) logBody.clientIp = clientIp
  if (requestId) logBody.requestId = requestId

  // 双写：输出到 stdout（用于 K8s 日志采集，默认开启）
  if (stdoutConfig?.enabled !== false) {
    writeToStdout(logBody, stdoutConfig ?? {})
  }

  // 熔断器检查：如果熔断打开，直接跳过 HTTP 上报
  if (!circuitBreaker.canRequest()) {
    return
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

    // 成功：重置熔断器
    circuitBreaker.recordSuccess()
  } catch (error) {
    // 失败：记录到熔断器
    circuitBreaker.recordFailure()

    // 错误节流：检查是否应该打印
    const { shouldLog, droppedCount } = errorThrottle.shouldLog()
    if (shouldLog) {
      onError(error as Error, { droppedCount })
    }
  }
}

/** 输出到 stdout（用于 K8s 日志采集） */
function writeToStdout(
  logBody: Record<string, unknown>,
  config: StdoutConfig
): void {
  const { format = 'json', includeBody = true, includeResponse = false } =
    config

  const status = logBody.status as number

  // 构建精简版日志（避免 stdout 日志过大）
  const stdoutLog: Record<string, unknown> = {
    level: getLogLevel(status), // 根据状态码设置日志级别
    time: Date.now(),
    service: logBody.service,
    method: logBody.method,
    path: logBody.path,
    status,
    duration: logBody.duration,
    msg: `${logBody.method} ${logBody.path} ${status} ${logBody.duration}ms`,
  }

  // 可选字段
  if (logBody.requestId) stdoutLog.requestId = logBody.requestId
  if (logBody.clientIp) stdoutLog.clientIp = logBody.clientIp

  // 可选：包含请求体
  if (includeBody && logBody.body) {
    stdoutLog.body = logBody.body
  }

  // 可选：包含响应体
  if (includeResponse && logBody.response) {
    stdoutLog.response = logBody.response
  }

  if (format === 'json') {
    console.log(JSON.stringify(stdoutLog))
  } else {
    // text 格式：更易读
    const reqId = logBody.requestId ? ` [${logBody.requestId}]` : ''
    console.log(
      `[${new Date().toISOString()}]${reqId} ${logBody.method} ${logBody.path} ${status} ${logBody.duration}ms`
    )
  }
}

// ============ Re-exports ============

export { sanitize, sanitizeHeaders, type SanitizeConfig } from './sanitize'
export default requestLogger
