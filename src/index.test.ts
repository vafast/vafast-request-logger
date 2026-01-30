import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestLogger, type RequestLoggerOptions } from './index'

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
    expect(body.headers['app-id']).toBe('app123')
    expect(body.headers['user-agent']).toBe('Test Browser')
    expect(body.query).toEqual({ page: '1' })
    expect(body.response).toEqual({ success: true, message: 'OK' })
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
