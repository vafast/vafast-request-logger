# @vafast/request-logger

API 请求日志中间件，将日志提交到远程日志服务。

## 安装

```bash
npm install @vafast/request-logger
```

## 使用

```typescript
import { requestLogger } from '@vafast/request-logger'

server.use(requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'my-service',
  headers: { Authorization: 'Bearer apiKeyId:apiKeySecret' },
  onError: (err) => console.error('日志记录失败', err),
}))
```

业务字段（appId、authType、ip、traceId 等）由日志服务端从 headers 自动解析。

## 配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | `string` | 是 | - | 日志服务 URL |
| `service` | `string` | 是 | - | 服务标识 |
| `headers` | `Record<string, string>` | 否 | `{}` | 自定义请求头（如认证） |
| `timeout` | `number` | 否 | `5000` | 超时时间（毫秒） |
| `sanitize` | `SanitizeConfig` | 否 | - | 敏感数据清洗配置 |
| `onError` | `(err) => void` | 否 | `console.error` | 错误回调 |
| `enabled` | `boolean` | 否 | `true` | 是否启用 |

## 路由级别控制

在路由定义中设置 `log: false` 跳过日志记录：

```typescript
// 单个路由
{ method: 'GET', path: '/health', log: false, handler: ... }

// 父路由设置，子路由继承
{
  path: '/internal',
  log: false,
  children: [
    { method: 'GET', path: '/metrics', handler: ... },
    { method: 'GET', path: '/status', handler: ... },
  ]
}
```

## 日志数据格式

发送到日志服务的数据结构：

```typescript
{
  method: 'POST',
  url: 'http://example.com/api/users?page=1',
  path: '/api/users',
  headers: { ... },
  body: { ... },
  query: { page: '1' },
  status: 200,
  duration: 50,
  service: 'my-service',
  userId: 'user123',
  appId: 'app456',
  authType: 'jwt',
  ip: '192.168.1.1',
  userAgent: 'Mozilla/5.0...',
  traceId: 'trace789',
  createdAt: '2024-01-01T00:00:00.000Z',
  response: {
    success: true,
    message: 'OK',
    code: 0,
  },
  responseData: { ... },
}
```

## 敏感数据脱敏

默认自动脱敏以下字段：

- `password`, `pwd`, `secret`, `token`
- `authorization`, `cookie`, `x-api-key`
- `accessToken`, `refreshToken`, `apiKey`

自定义脱敏配置：

```typescript
requestLogger({
  url: '...',
  service: '...',
  sanitize: {
    fields: ['password', 'creditCard', 'ssn'],
    mask: '******',
    deep: true,
  },
})
```

## 特性

- 异步非阻塞（不影响响应速度）
- 自动敏感数据脱敏
- 路由级别日志控制
- 支持多租户（appId）
- 支持分布式追踪（traceId）
