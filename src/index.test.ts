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

  it('HTTP 请求失败时应该调用 onError', async () => {
    const onError = vi.fn()
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' })

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

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(onError.mock.calls[0][0].message).toContain('500')
  })
})
