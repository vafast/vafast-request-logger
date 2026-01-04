import { describe, it, expect } from 'vitest'
import { sanitize, sanitizeHeaders, isSensitiveField } from './sanitize'

describe('sanitize', () => {
  describe('基础类型处理', () => {
    it('应该原样返回 null', () => {
      expect(sanitize(null)).toBe(null)
    })

    it('应该原样返回 undefined', () => {
      expect(sanitize(undefined)).toBe(undefined)
    })

    it('应该原样返回字符串', () => {
      expect(sanitize('hello')).toBe('hello')
    })

    it('应该原样返回数字', () => {
      expect(sanitize(123)).toBe(123)
    })

    it('应该原样返回布尔值', () => {
      expect(sanitize(true)).toBe(true)
      expect(sanitize(false)).toBe(false)
    })
  })

  describe('敏感字段移除', () => {
    it('应该脱敏 password 字段', () => {
      const data = { username: 'test', password: '123456' }
      const result = sanitize(data)
      expect(result.username).toBe('test')
      expect(result.password).toBe('[REDACTED]')
    })

    it('应该脱敏 Password 字段（大小写不敏感）', () => {
      const data = { Username: 'test', Password: 'secret123' }
      const result = sanitize(data)
      expect(result.Username).toBe('test')
      expect(result.Password).toBe('[REDACTED]')
    })

    it('应该脱敏多个密码相关字段', () => {
      const data = {
        oldPassword: 'old123',
        newPassword: 'new456',
        confirmPassword: 'new456',
      }
      const result = sanitize(data)
      expect(result.oldPassword).toBe('[REDACTED]')
      expect(result.newPassword).toBe('[REDACTED]')
      expect(result.confirmPassword).toBe('[REDACTED]')
    })

    it('应该脱敏 secret 相关字段', () => {
      const data = {
        secret: 'mysecret',
        secretKey: 'key123',
        apiSecret: 'api-secret',
        clientSecret: 'client-secret',
      }
      const result = sanitize(data)
      expect(result.secret).toBe('[REDACTED]')
      expect(result.secretKey).toBe('[REDACTED]')
      expect(result.apiSecret).toBe('[REDACTED]')
      expect(result.clientSecret).toBe('[REDACTED]')
    })
  })

  describe('敏感字段部分脱敏', () => {
    it('应该部分脱敏 token 字段', () => {
      const data = { token: 'abcd1234efgh5678' }
      const result = sanitize(data)
      expect(result.token).toBe('abcd****5678')
    })

    it('应该部分脱敏 accessToken 字段', () => {
      const data = { accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }
      const result = sanitize(data)
      expect(result.accessToken).toBe('eyJh****VCJ9')
    })

    it('应该完全脱敏短 token（长度<=8）', () => {
      const data = { token: 'short' }
      const result = sanitize(data)
      expect(result.token).toBe('[REDACTED]')
    })

    it('应该脱敏 apiKey 相关字段', () => {
      const data = {
        apiKey: 'sk-1234567890abcdef',
        api_key: 'pk-abcdefghijklmnop',
      }
      const result = sanitize(data)
      expect(result.apiKey).toBe('sk-1****cdef')
      expect(result.api_key).toBe('pk-a****mnop')
    })
  })

  describe('嵌套对象处理', () => {
    it('应该递归处理嵌套对象', () => {
      const data = {
        user: {
          name: 'test',
          credentials: {
            password: 'secret',
            token: 'verylongtokenvalue',
          },
        },
      }
      const result = sanitize(data)
      expect(result.user.name).toBe('test')
      expect(result.user.credentials.password).toBe('[REDACTED]')
      expect(result.user.credentials.token).toBe('very****alue')
    })
  })

  describe('数组处理', () => {
    it('应该处理对象数组', () => {
      const data = [
        { username: 'user1', password: 'pass1' },
        { username: 'user2', password: 'pass2' },
      ]
      const result = sanitize(data)
      expect(result[0].username).toBe('user1')
      expect(result[0].password).toBe('[REDACTED]')
      expect(result[1].username).toBe('user2')
      expect(result[1].password).toBe('[REDACTED]')
    })

    it('应该处理嵌套数组', () => {
      const data = {
        users: [
          { token: 'longtoken1234567890' },
          { token: 'longtoken0987654321' },
        ],
      }
      const result = sanitize(data)
      expect(result.users[0].token).toBe('long****7890')
      expect(result.users[1].token).toBe('long****4321')
    })
  })

  describe('自定义配置', () => {
    it('应该支持自定义脱敏占位符', () => {
      const data = { password: '123456' }
      const result = sanitize(data, { placeholder: '***' })
      expect(result.password).toBe('***')
    })

    it('应该支持自定义移除字段', () => {
      const data = { customSecret: 'secret', normalField: 'value' }
      const result = sanitize(data, { removeFields: ['customsecret'] })
      expect(result.customSecret).toBe('[REDACTED]')
      expect(result.normalField).toBe('value')
    })

    it('应该支持自定义脱敏字段', () => {
      const data = { myCustomToken: 'verylongtokenvalue' }
      const result = sanitize(data, { maskFields: ['customtoken'] })
      expect(result.myCustomToken).toBe('very****alue')
    })
  })

  describe('深度限制', () => {
    it('应该在达到最大深度时停止递归', () => {
      // 创建深度嵌套对象
      let data: Record<string, unknown> = { password: 'secret' }
      for (let i = 0; i < 15; i++) {
        data = { nested: data }
      }

      // 使用较小的 maxDepth
      const result = sanitize(data, { maxDepth: 5 })
      
      // 结果应该存在（不会栈溢出）
      expect(result).toBeDefined()
    })
  })
})

describe('sanitizeHeaders', () => {
  it('应该保留普通请求头', () => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
    const result = sanitizeHeaders(headers)
    expect(result['Content-Type']).toBe('application/json')
    expect(result['Accept']).toBe('application/json')
  })

  it('应该部分脱敏 Authorization Bearer token', () => {
    const headers = {
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    }
    const result = sanitizeHeaders(headers)
    expect(result.Authorization).toMatch(/^Bearer eyJh\*\*\*\*VCJ9$/)
  })

  it('应该部分脱敏非 Bearer 的 Authorization', () => {
    const headers = {
      Authorization: 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
    }
    const result = sanitizeHeaders(headers)
    expect(result.Authorization).toBe('Basi****cmQ=')
  })

  it('应该完全脱敏 Cookie 头', () => {
    const headers = {
      Cookie: 'session=abc123; token=xyz789',
    }
    const result = sanitizeHeaders(headers)
    expect(result.Cookie).toBe('[REDACTED]')
  })

  it('应该完全脱敏 Set-Cookie 头', () => {
    const headers = {
      'set-cookie': 'session=abc123; Path=/; HttpOnly',
    }
    const result = sanitizeHeaders(headers)
    expect(result['set-cookie']).toBe('[REDACTED]')
  })

  it('应该部分脱敏 X-API-Key 头', () => {
    const headers = {
      'X-API-Key': 'sk-1234567890abcdef',
    }
    const result = sanitizeHeaders(headers)
    expect(result['X-API-Key']).toBe('sk-1****cdef')
  })

  it('应该支持自定义配置', () => {
    const headers = {
      'X-Custom-Token': 'verylongtokenvalue',
    }
    const result = sanitizeHeaders(headers, { maskFields: ['custom'] })
    expect(result['X-Custom-Token']).toBe('very****alue')
  })
})

describe('isSensitiveField', () => {
  describe('默认配置', () => {
    it('应该识别 password 为敏感字段', () => {
      expect(isSensitiveField('password')).toBe(true)
      expect(isSensitiveField('Password')).toBe(true)
      expect(isSensitiveField('PASSWORD')).toBe(true)
    })

    it('应该识别 token 相关为敏感字段', () => {
      expect(isSensitiveField('token')).toBe(true)
      expect(isSensitiveField('accessToken')).toBe(true)
      expect(isSensitiveField('refreshToken')).toBe(true)
      expect(isSensitiveField('idToken')).toBe(true)
    })

    it('应该识别 apiKey 为敏感字段', () => {
      expect(isSensitiveField('apiKey')).toBe(true)
      expect(isSensitiveField('api_key')).toBe(true)
      expect(isSensitiveField('x-api-key')).toBe(true)
    })

    it('应该识别 secret 相关为敏感字段', () => {
      expect(isSensitiveField('secret')).toBe(true)
      expect(isSensitiveField('secretKey')).toBe(true)
      expect(isSensitiveField('apiSecret')).toBe(true)
    })

    it('不应该将普通字段识别为敏感', () => {
      expect(isSensitiveField('username')).toBe(false)
      expect(isSensitiveField('email')).toBe(false)
      expect(isSensitiveField('name')).toBe(false)
      expect(isSensitiveField('id')).toBe(false)
    })
  })

  describe('自定义配置', () => {
    it('应该支持自定义移除字段', () => {
      const config = { removeFields: ['customsecret'] }
      expect(isSensitiveField('customSecret', config)).toBe(true)
      expect(isSensitiveField('password', config)).toBe(false)
    })

    it('应该支持自定义脱敏字段', () => {
      const config = { maskFields: ['mytoken'] }
      expect(isSensitiveField('myToken', config)).toBe(true)
      expect(isSensitiveField('token', config)).toBe(false)
    })
  })
})

