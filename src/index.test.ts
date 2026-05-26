import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestLogger } from './index'

/** 捕获 console.log 输出 */
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  return {
    logs,
    restore: () => {
      console.log = originalLog
    },
  }
}

describe('requestLogger', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('应该创建中间件函数', () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })
    expect(middleware).toBeDefined()
    expect(typeof middleware).toBe('function')
  })

  it('应该调用 next 并返回响应', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      method: 'GET',
    })

    const result = await middleware(mockReq, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(result).toBe(mockResponse)
  })

  it('enabled=false 时应该跳过日志记录', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      enabled: false,
    })

    const mockResponse = new Response('{}')
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test')

    await middleware(mockReq, mockNext)

    // 等待异步操作
    await new Promise((r) => setTimeout(r, 10))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('应该发送正确的日志数据到日志服务', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      headers: { Authorization: 'Bearer key:secret' },
    })

    const mockResponse = new Response(
      JSON.stringify({ success: true, message: 'OK' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/users?page=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Test Browser',
        'app-id': 'app123',
      },
      body: JSON.stringify({ name: 'test' }),
    })

    await middleware(mockReq, mockNext)

    // 等待异步操作
    await new Promise((r) => setTimeout(r, 50))

    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://log-server/api/logs')
    expect(options.method).toBe('POST')
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer key:secret',
    })

    const body = JSON.parse(options.body)
    expect(body.method).toBe('POST')
    expect(body.path).toBe('/api/users')
    expect(body.status).toBe(200)
    expect(body.service).toBe('test-service')
    expect(body.appId).toBe('app123')
    expect(body.authType).toBeNull()
    expect(body.userId).toBeNull()
    expect(body.ip).toBeNull()
    expect(body.traceId).toBeNull()
    expect(body.userAgent).toBe('Test Browser')
    expect(body.headers['app-id']).toBe('app123')
    expect(body.headers['user-agent']).toBe('Test Browser')
    expect(body.query).toEqual({ page: '1' })
    expect(body.response).toEqual({ success: true, message: 'OK' })
  })

  it('应该在 headers 脱敏前提取业务上下文', async () => {
    const tokenPayload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64url')
    const token = `eyJhbGciOiJIUzI1NiJ9.${tokenPayload}.signature`
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'app-id': 'app123',
      },
      body: JSON.stringify({ name: 'test' }),
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.appId).toBe('app123')
    expect(body.authType).toBe('jwt')
    expect(body.userId).toBe('user123')
    expect(body.headers.authorization).not.toContain(token)
  })

  it('应该支持自定义业务上下文提取', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      getAppId: ({ body }) => {
        const data = body as Record<string, string>
        return data.out_trade_no === 'order123' ? 'app-from-order' : undefined
      },
    })

    const mockResponse = new Response('success', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([['out_trade_no', 'order123']]),
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.appId).toBe('app-from-order')
    expect(body.response).toBe('success')
  })

  it('业务处理消费 JSON body 后仍应该记录请求体', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockReq = new Request('http://example.com/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test' }),
    })
    const mockNext = vi.fn(async () => {
      await mockReq.json()
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.body).toEqual({ name: 'test' })
  })

  it('应该记录 form-urlencoded 请求体', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['out_trade_no', 'order123'],
        ['trade_status', 'TRADE_SUCCESS'],
        ['tag', 'a'],
        ['tag', 'b'],
      ]),
    })

    await middleware(mockReq, mockNext)

    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.body).toEqual({
      out_trade_no: 'order123',
      trade_status: 'TRADE_SUCCESS',
      tag: ['a', 'b'],
    })
  })

  it('业务处理消费 form-urlencoded body 后仍应该记录请求体并提取业务上下文', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      getAppId: ({ body }) => {
        const data = body as Record<string, string>
        return data.out_trade_no === 'order123' ? 'app-from-order' : undefined
      },
    })

    const mockReq = new Request('http://example.com/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['out_trade_no', 'order123'],
        ['trade_status', 'TRADE_SUCCESS'],
      ]),
    })
    const mockNext = vi.fn(async () => {
      await mockReq.formData()
      return new Response('success', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.body).toEqual({
      out_trade_no: 'order123',
      trade_status: 'TRADE_SUCCESS',
    })
    expect(body.appId).toBe('app-from-order')
  })

  it('HTTP 请求失败时应该调用 onError 并带 droppedCount', async () => {
    const onError = vi.fn()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    })

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      onError,
    })

    const mockResponse = new Response('{}')
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test')

    await middleware(mockReq, mockNext)

    // 等待异步操作
    await new Promise((r) => setTimeout(r, 50))

    expect(onError).toHaveBeenCalledWith(expect.any(Error), { droppedCount: 0 })
    expect(onError.mock.calls[0][0].message).toContain('500')
  })
})

describe('熔断器 (Circuit Breaker)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('连续失败达到阈值后应该停止上报', async () => {
    const onError = vi.fn()
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    })

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      onError,
      circuitBreaker: {
        failureThreshold: 3,
        resetTimeout: 1000,
      },
      errorThrottle: {
        interval: 0, // 禁用节流以便测试
      },
    })

    const mockNext = vi.fn().mockResolvedValue(new Response('{}'))

    // 发送 5 个请求
    for (let i = 0; i < 5; i++) {
      const req = new Request(`http://example.com/api/test${i}`)
      await middleware(req, mockNext)
      await new Promise((r) => setTimeout(r, 20))
    }

    // 前 3 次失败会触发 onError，之后熔断器打开，不再尝试
    // 所以 fetch 只被调用 3 次
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('熔断器恢复后应该重新尝试上报', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue({ ok: true }) // 恢复后成功

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      circuitBreaker: {
        failureThreshold: 3,
        resetTimeout: 100, // 100ms 后恢复
      },
      errorThrottle: {
        interval: 0,
      },
    })

    const mockNext = vi.fn().mockResolvedValue(new Response('{}'))

    // 触发熔断
    for (let i = 0; i < 4; i++) {
      await middleware(new Request(`http://example.com/api/test${i}`), mockNext)
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(fetchMock).toHaveBeenCalledTimes(3) // 熔断后不再调用

    // 等待熔断恢复
    await new Promise((r) => setTimeout(r, 150))

    // 再发一个请求，应该尝试上报
    await middleware(new Request('http://example.com/api/test-after'), mockNext)
    await new Promise((r) => setTimeout(r, 20))

    expect(fetchMock).toHaveBeenCalledTimes(4) // 恢复后重新尝试
  })
})

describe('错误节流 (Error Throttle)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('在节流间隔内只应该打印一次错误', async () => {
    const onError = vi.fn()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      onError,
      circuitBreaker: {
        failureThreshold: 100, // 设高一点，不触发熔断
      },
      errorThrottle: {
        interval: 200, // 200ms 内只打一次
      },
    })

    const mockNext = vi.fn().mockResolvedValue(new Response('{}'))

    // 快速发送 5 个请求
    for (let i = 0; i < 5; i++) {
      await middleware(new Request(`http://example.com/api/test${i}`), mockNext)
      await new Promise((r) => setTimeout(r, 20))
    }

    // 虽然 fetch 被调用 5 次，但 onError 只被调用 1 次
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { droppedCount: 0 })
  })

  it('节流后第二次打印应该包含 droppedCount', async () => {
    const onError = vi.fn()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      onError,
      circuitBreaker: {
        failureThreshold: 100,
      },
      errorThrottle: {
        interval: 100, // 100ms
      },
    })

    const mockNext = vi.fn().mockResolvedValue(new Response('{}'))

    // 发送 3 个请求（第一次打印）
    for (let i = 0; i < 3; i++) {
      await middleware(new Request(`http://example.com/api/test${i}`), mockNext)
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(onError).toHaveBeenCalledTimes(1)

    // 等待节流间隔
    await new Promise((r) => setTimeout(r, 120))

    // 再发 2 个请求（第二次打印，应该带 droppedCount: 2）
    for (let i = 0; i < 2; i++) {
      await middleware(
        new Request(`http://example.com/api/test-after${i}`),
        mockNext
      )
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(onError).toHaveBeenCalledTimes(2)
    // 第二次调用应该有 droppedCount = 2（第一批的后两个被忽略了）
    expect(onError.mock.calls[1][1].droppedCount).toBe(2)
  })
})

describe('状态码日志级别', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('2xx 响应应该输出 INFO 级别 (level: 30)', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      stdout: { enabled: true },
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test')

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.level).toBe(30)
  })

  it('4xx 响应应该输出 WARN 级别 (level: 40)', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      stdout: { enabled: true },
    })

    const mockResponse = new Response('{}', { status: 404 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/notfound')

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.level).toBe(40)
    expect(stdoutLog.status).toBe(404)
  })

  it('5xx 响应应该输出 ERROR 级别 (level: 50)', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      stdout: { enabled: true },
    })

    const mockResponse = new Response('{}', { status: 500 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/error')

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.level).toBe(50)
    expect(stdoutLog.status).toBe(500)
  })
})


describe('客户端 IP 提取', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('应该从 X-Forwarded-For 提取客户端 IP', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      headers: { 'X-Forwarded-For': '1.2.3.4, 5.6.7.8' },
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.clientIp).toBe('1.2.3.4')
  })

  it('应该从 X-Real-IP 提取客户端 IP', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      headers: { 'X-Real-IP': '10.20.30.40' },
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.clientIp).toBe('10.20.30.40')
  })

  it('X-Forwarded-For 优先于 X-Real-IP', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      headers: {
        'X-Forwarded-For': '1.1.1.1',
        'X-Real-IP': '2.2.2.2',
      },
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.clientIp).toBe('1.1.1.1')
  })
})

describe('Request ID 提取', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('应该从 x-request-id header 提取 Request ID', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      headers: { 'x-request-id': 'abc-123-def-456' },
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.requestId).toBe('abc-123-def-456')
  })

  it('应该支持自定义 requestIdHeader', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      requestIdHeader: 'x-correlation-id',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      headers: { 'x-correlation-id': 'corr-789' },
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.requestId).toBe('corr-789')
  })

  it('应该优先使用 req.id（如果存在）', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    const mockReq = new Request('http://example.com/api/test', {
      headers: { 'x-request-id': 'header-id' },
    }) as Request & { id?: string }
    // 模拟 @vafast/request-id 设置的 req.id
    mockReq.id = 'req-id-from-middleware'

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    restore()

    const stdoutLog = JSON.parse(logs[0])
    expect(stdoutLog.requestId).toBe('req-id-from-middleware')
  })
})

/**
 * GET/HEAD 请求 body 解析防御测试
 * 
 * 背景：某些客户端（如 Electron/浏览器）可能会为 GET 请求添加 Content-Type: application/json header
 * 中间件不应该尝试解析 GET/HEAD 请求的 body，因为这可能导致流读取异常
 * 
 * 参考：Fastify 文档 "for GET and HEAD requests, the payload is never parsed"
 */
describe('GET/HEAD 请求 body 解析防御', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET 请求不应该尝试解析 body（即使有 Content-Type header）', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    // 模拟 Electron 发送带 Content-Type 的 GET 请求
    const mockReq = new Request('http://example.com/api/data', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })

    // 这不应该抛出错误
    const result = await middleware(mockReq, mockNext)
    expect(result).toBe(mockResponse)

    // 等待日志异步操作
    await new Promise((r) => setTimeout(r, 50))

    // 验证日志中 body 应该是 null
    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toBeNull()
  })

  it('HEAD 请求不应该尝试解析 body', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response(null, { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    const mockReq = new Request('http://example.com/api/data', {
      method: 'HEAD',
      headers: { 'Content-Type': 'application/json' },
    })

    const result = await middleware(mockReq, mockNext)
    expect(result).toBe(mockResponse)

    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toBeNull()
  })

  it('POST 请求应该正常解析 JSON body', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    const mockReq = new Request('http://example.com/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toEqual({ message: 'hello' })
  })

  it('PUT 请求应该正常解析 JSON body', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    const mockReq = new Request('http://example.com/api/data/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, name: 'updated' }),
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toEqual({ id: 1, name: 'updated' })
  })

  it('PATCH 请求应该正常解析 JSON body', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    const mockReq = new Request('http://example.com/api/data/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'patched' }),
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toEqual({ name: 'patched' })
  })

  it('DELETE 请求应该正常解析 JSON body（如果有）', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    const mockReq = new Request('http://example.com/api/data/1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '不再需要' }),
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toEqual({ reason: '不再需要' })
  })

  it('GET 请求应该正常记录其他元数据（不受 body 解析跳过影响）', async () => {
    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
    })

    const mockResponse = new Response(JSON.stringify({ data: [1, 2, 3] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)
    
    const mockReq = new Request('http://example.com/api/items?page=1&limit=10', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TestClient/1.0',
        'app-id': 'test-app',
      },
    })

    await middleware(mockReq, mockNext)
    await new Promise((r) => setTimeout(r, 50))

    // 验证发送到日志服务的完整日志数据
    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    
    expect(logBody.method).toBe('GET')
    expect(logBody.path).toBe('/api/items')
    expect(logBody.status).toBe(200)
    expect(logBody.query).toEqual({ page: '1', limit: '10' })
    expect(logBody.headers['user-agent']).toBe('TestClient/1.0')
    expect(logBody.headers['app-id']).toBe('test-app')
    // body 应该是 null（GET 请求不解析 body）
    expect(logBody.body).toBeNull()
    // response 应该正常记录
    expect(logBody.response).toEqual({ data: [1, 2, 3] })
  })
})

describe('日志采样 (sampleRate)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sampleRate=1 时应该记录所有请求', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      sampleRate: 1,
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)

    // 发送 10 个请求
    for (let i = 0; i < 10; i++) {
      await middleware(new Request(`http://example.com/api/test${i}`), mockNext)
    }
    await new Promise((r) => setTimeout(r, 100))

    restore()

    expect(logs.length).toBe(10)
  })

  it('sampleRate=0 时应该不记录任何请求', async () => {
    const { logs, restore } = captureConsoleLog()

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      sampleRate: 0,
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)

    // 发送 10 个请求
    for (let i = 0; i < 10; i++) {
      await middleware(new Request(`http://example.com/api/test${i}`), mockNext)
    }
    await new Promise((r) => setTimeout(r, 100))

    restore()

    expect(logs.length).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sampleRate=0.5 时应该记录约一半请求', async () => {
    const { logs, restore } = captureConsoleLog()

    // Mock Math.random 以获得可预测的结果
    let callCount = 0
    const originalRandom = Math.random
    Math.random = () => {
      callCount++
      // 交替返回 0.3 和 0.7，模拟 50% 采样
      return callCount % 2 === 1 ? 0.3 : 0.7
    }

    const middleware = requestLogger({
      url: 'http://log-server/api/logs',
      service: 'test-service',
      sampleRate: 0.5,
    })

    const mockResponse = new Response('{}', { status: 200 })
    const mockNext = vi.fn().mockResolvedValue(mockResponse)

    // 发送 10 个请求
    for (let i = 0; i < 10; i++) {
      await middleware(new Request(`http://example.com/api/test${i}`), mockNext)
    }
    await new Promise((r) => setTimeout(r, 100))

    Math.random = originalRandom
    restore()

    // 应该有约一半被记录（由于 mock，精确是 5 个）
    expect(logs.length).toBe(5)
  })
})
