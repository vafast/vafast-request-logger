/**
 * 敏感数据清洗工具
 * 
 * 用于在记录日志前移除或脱敏敏感信息
 */

// ============ Types ============

export interface SanitizeConfig {
  /** 需要完全移除的字段（小写） */
  removeFields?: string[]
  /** 需要脱敏的字段（小写，部分匹配） */
  maskFields?: string[]
  /** 脱敏占位符 @default '[REDACTED]' */
  placeholder?: string
  /** 最大递归深度 @default 10 */
  maxDepth?: number
}

// ============ Default Config ============

/** 默认需要完全移除的敏感字段 */
const DEFAULT_REMOVE_FIELDS = [
  'password',
  'newpassword',
  'oldpassword',
  'confirmpassword',
  'secret',
  'secretkey',
  'privatekey',
  'apisecret',
  'clientsecret',
]

/** 默认需要脱敏的字段（保留部分信息） */
const DEFAULT_MASK_FIELDS = [
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'apikey',
  'api_key',
  'x-api-key',
  'idtoken',
  'sessiontoken',
  'bearer',
]

const DEFAULT_PLACEHOLDER = '[REDACTED]'
const DEFAULT_MAX_DEPTH = 10

// ============ Sanitize Functions ============

/**
 * 部分脱敏（保留前4后4位）
 */
function partialMask(value: string, placeholder: string): string {
  if (value.length <= 8) return placeholder
  return value.slice(0, 4) + '****' + value.slice(-4)
}

/**
 * 深度清洗对象中的敏感数据
 * 
 * @example
 * ```typescript
 * const data = { password: '123456', token: 'eyJhbG...' }
 * const sanitized = sanitize(data)
 * // { password: '[REDACTED]', token: 'eyJh****...' }
 * ```
 */
export function sanitize<T>(data: T, config?: SanitizeConfig, depth = 0): T {
  const {
    removeFields = DEFAULT_REMOVE_FIELDS,
    maskFields = DEFAULT_MASK_FIELDS,
    placeholder = DEFAULT_PLACEHOLDER,
    maxDepth = DEFAULT_MAX_DEPTH,
  } = config ?? {}

  // 防止无限递归
  if (depth > maxDepth) return data
  
  if (data === null || data === undefined) {
    return data
  }

  // 处理数组
  if (Array.isArray(data)) {
    return data.map(item => sanitize(item, config, depth + 1)) as T
  }

  // 处理对象
  if (typeof data === 'object') {
    const result: Record<string, unknown> = {}
    
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase()
      
      // 完全移除的字段
      if (removeFields.some(field => lowerKey === field)) {
        result[key] = placeholder
        continue
      }
      
      // 部分脱敏的字段
      if (maskFields.some(field => lowerKey.includes(field))) {
        if (typeof value === 'string') {
          result[key] = partialMask(value, placeholder)
        } else {
          result[key] = placeholder
        }
        continue
      }
      
      // 递归处理嵌套对象
      result[key] = sanitize(value, config, depth + 1)
    }
    
    return result as T
  }

  return data
}

/**
 * 清洗 HTTP 请求头
 * 
 * @example
 * ```typescript
 * const headers = { Authorization: 'Bearer eyJhbG...', Cookie: 'session=xxx' }
 * const sanitized = sanitizeHeaders(headers)
 * // { Authorization: 'Bearer eyJh****...', Cookie: '[REDACTED]' }
 * ```
 */
export function sanitizeHeaders(
  headers: Record<string, string>,
  config?: SanitizeConfig
): Record<string, string> {
  const {
    maskFields = DEFAULT_MASK_FIELDS,
    placeholder = DEFAULT_PLACEHOLDER,
  } = config ?? {}

  const result: Record<string, string> = {}
  
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase()
    
    // Authorization 头部分脱敏
    if (lowerKey === 'authorization') {
      if (value.startsWith('Bearer ')) {
        result[key] = 'Bearer ' + partialMask(value.slice(7), placeholder)
      } else {
        result[key] = partialMask(value, placeholder)
      }
      continue
    }
    
    // Cookie 完全脱敏
    if (lowerKey === 'cookie' || lowerKey === 'set-cookie') {
      result[key] = placeholder
      continue
    }
    
    // API Key 相关头脱敏
    if (maskFields.some(field => lowerKey.includes(field))) {
      result[key] = partialMask(value, placeholder)
      continue
    }
    
    result[key] = value
  }
  
  return result
}

/**
 * 检查值是否为敏感字段
 */
export function isSensitiveField(fieldName: string, config?: SanitizeConfig): boolean {
  const {
    removeFields = DEFAULT_REMOVE_FIELDS,
    maskFields = DEFAULT_MASK_FIELDS,
  } = config ?? {}

  const lowerName = fieldName.toLowerCase()
  
  return (
    removeFields.some(field => lowerName === field) ||
    maskFields.some(field => lowerName.includes(field))
  )
}

