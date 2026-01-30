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
  excludePaths: ['/health', '/metrics'],
  onError: (err, { droppedCount }) => {
    console.warn(
      `日志上报失败: ${err.message}`,
      droppedCount > 0 ? `(已忽略 ${droppedCount} 条)` : ''
    )
  },
}))
```

业务字段（appId、authType、ip、traceId 等）由日志服务端从 headers 自动解析。

## 配置

### 基础配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | `string` | 是 | - | 日志服务 URL |
| `service` | `string` | 是 | - | 服务标识 |
| `headers` | `Record<string, string>` | 否 | `{}` | 自定义请求头（如认证） |
| `timeout` | `number` | 否 | `5000` | 超时时间（毫秒） |
| `sanitize` | `SanitizeConfig` | 否 | - | 敏感数据清洗配置 |
| `onError` | `(err, ctx) => void` | 否 | `console.error` | 错误回调，`ctx.droppedCount` 为被节流忽略的错误数 |
| `enabled` | `boolean` | 否 | `true` | 是否启用 |
| `excludePaths` | `(string \| RegExp)[]` | 否 | `[]` | 排除的路径列表，不记录日志 |

### 熔断器配置 (Circuit Breaker)

当日志服务不可用时，避免无谓的超时等待。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `circuitBreaker.failureThreshold` | `number` | `5` | 触发熔断的连续失败次数 |
| `circuitBreaker.resetTimeout` | `number` | `60000` | 熔断恢复时间（毫秒） |

```typescript
requestLogger({
  url: '...',
  service: '...',
  circuitBreaker: {
    failureThreshold: 5,  // 连续失败 5 次后熔断
    resetTimeout: 60000,  // 1 分钟后尝试恢复
  },
})
```

**工作原理**：
1. 正常状态：每个请求都尝试上报
2. 连续失败达到阈值：进入熔断状态，跳过所有上报
3. 熔断时间到期：进入半开状态，允许一个请求通过测试
4. 测试成功：恢复正常；测试失败：继续熔断

### stdout 双写配置 (Dual Write)

同时输出到 stdout，用于 K8s 日志采集（如 TKE + CLS）。即使 log-server 挂了，运维也能从 CLS 查日志。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `stdout.enabled` | `boolean` | `false` | 是否启用 stdout 输出 |
| `stdout.format` | `'json' \| 'text'` | `'json'` | 输出格式 |
| `stdout.includeBody` | `boolean` | `false` | 是否包含请求体 |
| `stdout.includeResponse` | `boolean` | `false` | 是否包含响应体 |

```typescript
requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'auth-server',
  stdout: {
    enabled: true,       // 启用双写
    format: 'json',      // JSON 格式（K8s 友好）
    includeBody: false,  // 不含请求体（减小日志量）
    includeResponse: false,
  },
})
```

**stdout 输出格式**（精简版，兼容 pino/K8s）：

```json
{"level":30,"time":1706123456789,"service":"auth-server","method":"POST","path":"/api/users","status":200,"duration":50,"msg":"POST /api/users 200 50ms"}
```

**架构图**：

```
请求进来
    │
    ▼
requestLogger 中间件
    │
    ├── stdout（JSON）──▶ K8s 采集 ──▶ CLS/Loki（运维备份）
    │
    └── HTTP 推送 ──▶ log-server ──▶ MongoDB ──▶ ones（用户查询）
```

### 错误节流配置 (Error Throttle)

避免相同错误刷屏，在一段时间内只打印一次。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `errorThrottle.interval` | `number` | `60000` | 节流间隔（毫秒） |

```typescript
requestLogger({
  url: '...',
  service: '...',
  errorThrottle: {
    interval: 60000,  // 同类错误 1 分钟内只打 1 条
  },
  onError: (err, { droppedCount }) => {
    // droppedCount: 上次打印到这次之间被忽略的错误数
    logger.warn(
      { errorName: err.name, errorMessage: err.message, droppedCount },
      droppedCount > 0
        ? `日志上报失败 (已忽略 ${droppedCount} 条)`
        : '日志上报失败'
    )
  },
})
```

**效果对比**：

```
# 之前（日志服务挂了）
日志上报失败
日志上报失败
日志上报失败
... (每秒好几条，刷屏)

# 之后
日志上报失败
(沉默 1 分钟)
日志上报失败 (已忽略 120 条)
(沉默 1 分钟)
日志上报失败 (已忽略 118 条)
```

## 路径排除

### excludePaths 配置

在中间件配置中排除特定路径：

```typescript
requestLogger({
  url: '...',
  service: '...',
  excludePaths: [
    '/health',           // 精确匹配
    '/internal/',        // 前缀匹配（含子路径）
    /^\/metrics/,        // 正则匹配
  ],
})
```

### 路由级别控制

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
  createdAt: '2024-01-01T00:00:00.000Z',
  response: { success: true, message: 'OK' },
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

- **异步非阻塞**：不影响响应速度
- **stdout 双写**：同时输出到 stdout，支持 K8s 日志采集
- **熔断器**：日志服务故障时自动熔断，避免雪崩
- **错误节流**：相同错误不刷屏，带统计计数
- **路径排除**：支持精确匹配、前缀匹配、正则匹配
- **敏感数据脱敏**：自动清洗密码、Token 等敏感字段
- **路由级别控制**：可在路由定义中禁用日志
- **支持多租户**：通过 headers 传递 appId
- **支持分布式追踪**：通过 headers 传递 traceId

## 完整示例

```typescript
import { requestLogger } from '@vafast/request-logger'
import { logger } from './logger'

server.use(requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'auth-server',
  headers: { Authorization: 'Bearer ak_xxx:sk_xxx' },
  timeout: 5000,
  enabled: true,
  excludePaths: ['/health', '/verifyApiKey'],
  // stdout 双写（K8s 日志采集）
  stdout: {
    enabled: true,
    format: 'json',
  },
  // 熔断器
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeout: 60000,
  },
  // 错误节流
  errorThrottle: {
    interval: 60000,
  },
  onError: (err: Error, { droppedCount }: { droppedCount: number }) =>
    logger.warn(
      {
        errorName: err.name,
        errorMessage: err.message,
        droppedCount,
      },
      droppedCount > 0
        ? `request-logger 上报失败 (已忽略 ${droppedCount} 条相同错误)`
        : 'request-logger 上报失败'
    ),
}))
```
