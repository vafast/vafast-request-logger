import { describe, it, expect, vi } from 'vitest'
import { createConsoleAdapter, createMongoAdapter, type StorageAdapter } from './index'

describe('createConsoleAdapter', () => {
  it('应该创建一个有效的存储适配器', () => {
    const adapter = createConsoleAdapter()
    expect(adapter).toBeDefined()
    expect(typeof adapter.saveRequestLog).toBe('function')
    expect(typeof adapter.saveResponseLog).toBe('function')
  })

  it('saveRequestLog 应该返回递增的 ID', async () => {
    const adapter = createConsoleAdapter()

    const log1 = {
      method: 'GET',
      url: 'http://example.com/api/test',
      path: '/api/test',
      headers: {},
      body: null,
      query: {},
      response: { success: true },
      status: 200,
      duration: 100,
      createdAt: new Date(),
    }

    const id1 = await adapter.saveRequestLog(log1)
    const id2 = await adapter.saveRequestLog(log1)

    expect(id1).toBe('log_1')
    expect(id2).toBe('log_2')
  })

  it('saveRequestLog 应该打印日志信息', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adapter = createConsoleAdapter()

    await adapter.saveRequestLog({
      method: 'POST',
      url: 'http://example.com/api/users',
      path: '/api/users',
      headers: {},
      body: { name: 'test' },
      query: {},
      response: { success: true },
      status: 201,
      duration: 50,
      createdAt: new Date(),
    })

    expect(consoleSpy).toHaveBeenCalledWith(
      '[REQUEST] POST /api/users 201 50ms'
    )

    consoleSpy.mockRestore()
  })

  it('saveResponseLog 应该在失败时打印错误信息', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adapter = createConsoleAdapter()

    await adapter.saveResponseLog({
      requestLogId: 'log_1',
      success: false,
      message: 'User not found',
      createdAt: new Date(),
    })

    expect(consoleSpy).toHaveBeenCalledWith('[RESPONSE ERROR] User not found')

    consoleSpy.mockRestore()
  })

  it('saveResponseLog 成功时不应该打印', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const adapter = createConsoleAdapter()

    await adapter.saveResponseLog({
      requestLogId: 'log_1',
      success: true,
      message: 'OK',
      createdAt: new Date(),
    })

    expect(consoleSpy).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

describe('createMongoAdapter', () => {
  it('应该创建一个有效的存储适配器', () => {
    const mockDb = {
      collection: vi.fn().mockReturnValue({
        insertOne: vi.fn(),
      }),
    }

    const adapter = createMongoAdapter(mockDb)
    expect(adapter).toBeDefined()
    expect(typeof adapter.saveRequestLog).toBe('function')
    expect(typeof adapter.saveResponseLog).toBe('function')
  })

  it('saveRequestLog 应该调用正确的 collection 和返回 ID', async () => {
    const mockInsertOne = vi.fn().mockResolvedValue({
      insertedId: { toHexString: () => '507f1f77bcf86cd799439011' },
    })
    const mockCollection = vi.fn().mockReturnValue({
      insertOne: mockInsertOne,
    })
    const mockDb = { collection: mockCollection }

    const adapter = createMongoAdapter(mockDb, 'myLogs', 'myLogsResponse')

    const log = {
      method: 'GET',
      url: 'http://example.com/api/test',
      path: '/api/test',
      headers: {},
      body: null,
      query: {},
      response: { success: true },
      status: 200,
      duration: 100,
      createdAt: new Date(),
    }

    const id = await adapter.saveRequestLog(log)

    expect(mockCollection).toHaveBeenCalledWith('myLogs')
    expect(mockInsertOne).toHaveBeenCalled()
    expect(id).toBe('507f1f77bcf86cd799439011')
  })

  it('saveResponseLog 应该调用正确的 collection', async () => {
    const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: {} })
    const mockCollection = vi.fn().mockReturnValue({
      insertOne: mockInsertOne,
    })
    const mockDb = { collection: mockCollection }

    const adapter = createMongoAdapter(mockDb, 'logs', 'logsResponse')

    await adapter.saveResponseLog({
      requestLogId: '507f1f77bcf86cd799439011',
      success: true,
      message: 'OK',
      createdAt: new Date(),
    })

    expect(mockCollection).toHaveBeenCalledWith('logsResponse')
    expect(mockInsertOne).toHaveBeenCalled()
  })

  it('应该使用默认 collection 名称', async () => {
    const mockInsertOne = vi.fn().mockResolvedValue({
      insertedId: { toHexString: () => 'id' },
    })
    const mockCollection = vi.fn().mockReturnValue({
      insertOne: mockInsertOne,
    })
    const mockDb = { collection: mockCollection }

    const adapter = createMongoAdapter(mockDb)

    await adapter.saveRequestLog({
      method: 'GET',
      url: 'http://example.com',
      path: '/',
      headers: {},
      body: null,
      query: {},
      response: {},
      status: 200,
      duration: 10,
      createdAt: new Date(),
    })

    await adapter.saveResponseLog({
      requestLogId: 'id',
      createdAt: new Date(),
    })

    // 验证使用了默认 collection 名称
    expect(mockCollection).toHaveBeenCalledWith('logs')
    expect(mockCollection).toHaveBeenCalledWith('logsResponse')
  })
})

describe('StorageAdapter 接口', () => {
  it('应该可以实现自定义存储适配器', async () => {
    const logs: unknown[] = []

    const customAdapter: StorageAdapter = {
      async saveRequestLog(log) {
        const id = `custom_${logs.length + 1}`
        logs.push({ id, type: 'request', ...log })
        return id
      },
      async saveResponseLog(log) {
        logs.push({ type: 'response', ...log })
      },
    }

    const id = await customAdapter.saveRequestLog({
      method: 'GET',
      url: 'http://example.com',
      path: '/',
      headers: {},
      body: null,
      query: {},
      response: {},
      status: 200,
      duration: 10,
      createdAt: new Date(),
    })

    expect(id).toBe('custom_1')
    expect(logs.length).toBe(1)

    await customAdapter.saveResponseLog({
      requestLogId: id,
      success: true,
      createdAt: new Date(),
    })

    expect(logs.length).toBe(2)
  })
})

