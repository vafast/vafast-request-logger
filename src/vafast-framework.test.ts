import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Server, type ProcessedRoute } from 'vafast'
import { requestLogger } from './index'

describe('requestLogger with real Vafast Server', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('Vafast 路由消费 JSON body 后仍应该上报请求体', async () => {
    const server = new Server([
      {
        method: 'POST',
        path: '/json',
        handler: async (req) => {
          const body = await req.json()
          return new Response(JSON.stringify({ ok: true, body }), {
            headers: { 'Content-Type': 'application/json' },
          })
        },
      },
    ] satisfies ProcessedRoute[])

    server.use(
      requestLogger({
        url: 'http://log-server/api/logs',
        service: 'framework-test',
      })
    )

    const response = await server.fetch(
      new Request('http://example.com/json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'app-id': 'app123',
        },
        body: JSON.stringify({ name: 'vafast' }),
      })
    )
    expect(await response.json()).toEqual({ ok: true, body: { name: 'vafast' } })

    await new Promise((r) => setTimeout(r, 50))
    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toEqual({ name: 'vafast' })
    expect(logBody.appId).toBe('app123')
  })

  it('Vafast 路由消费 form-urlencoded body 后仍应该上报请求体并支持上下文提取', async () => {
    const server = new Server([
      {
        method: 'POST',
        path: '/notify',
        handler: async (req) => {
          const form = await req.formData()
          return new Response(form.get('out_trade_no') as string, {
            headers: { 'Content-Type': 'text/plain' },
          })
        },
      },
    ] satisfies ProcessedRoute[])

    server.use(
      requestLogger({
        url: 'http://log-server/api/logs',
        service: 'framework-test',
        getAppId: ({ body }) => {
          const data = body as Record<string, string>
          return data.out_trade_no === 'order123' ? 'app-from-order' : undefined
        },
      })
    )

    const response = await server.fetch(
      new Request('http://example.com/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
          ['out_trade_no', 'order123'],
          ['trade_status', 'TRADE_SUCCESS'],
        ]),
      })
    )
    expect(await response.text()).toBe('order123')

    await new Promise((r) => setTimeout(r, 50))
    const [, options] = fetchMock.mock.calls[0]
    const logBody = JSON.parse(options.body)
    expect(logBody.body).toEqual({
      out_trade_no: 'order123',
      trade_status: 'TRADE_SUCCESS',
    })
    expect(logBody.appId).toBe('app-from-order')
  })

  it('Vafast log=false 路由不应该读取 body 或上报日志', async () => {
    const server = new Server([
      {
        method: 'POST',
        path: '/silent',
        log: false,
        handler: async (req) => {
          const body = await req.json()
          return new Response(JSON.stringify(body), {
            headers: { 'Content-Type': 'application/json' },
          })
        },
      },
    ] satisfies ProcessedRoute[])

    server.use(
      requestLogger({
        url: 'http://log-server/api/logs',
        service: 'framework-test',
      })
    )

    const response = await server.fetch(
      new Request('http://example.com/silent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      })
    )
    expect(await response.json()).toEqual({ hidden: true })

    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
