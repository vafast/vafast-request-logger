# @vafast/request-logger

API 请求日志中间件，将日志提交到远程日志服务。

## 安装

```bash
npm install @vafast/request-logger
```

## 使用

```typescript
import { requestLogger } from '@vafast/request-logger'

// 最简配置 - 开箱即用
server.use(requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'my-service',
}))
```

**开箱即用特性**：
- ✅ stdout 双写（K8s 友好）
- ✅ 智能日志级别（2xx→INFO，4xx→WARN，5xx→ERROR）
- ✅ 默认排除 `/health`、`/metrics` 等
- ✅ 自动提取客户端 IP
- ✅ 自动读取 Request ID
- ✅ 智能错误处理（节流 + 结构化输出）

## 配置

### 基础配置

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `url` | `string` | 是 | - | 日志服务 URL |
| `service` | `string` | 是 | - | 服务标识 |
| `headers` | `Record<string, string>` | 否 | `{}` | 自定义请求头（如认证） |
| `timeout` | `number` | 否 | `5000` | 超时时间（毫秒） |
| `sanitize` | `SanitizeConfig` | 否 | - | 敏感数据清洗配置 |
| `onError` | `(err, ctx) => void` | 否 | 内置智能处理 | 错误回调，`ctx.droppedCount` 为被节流忽略的错误数 |
| `enabled` | `boolean` | 否 | `true` | 是否启用 |
| `excludePaths` | `(string \| RegExp)[]` | 否 | `[]` | 排除的路径列表（在默认排除基础上追加） |
| `useDefaultExcludePaths` | `boolean` | 否 | `true` | 是否使用默认排除路径 |
| `sampleRate` | `number` | 否 | `1` | 日志采样率 (0-1)，1 = 全部，0.1 = 10% |
| `requestIdHeader` | `string` | 否 | `'x-request-id'` | Request ID 的 header 名称 |

### 默认排除路径

以下路径默认不记录日志（可通过 `useDefaultExcludePaths: false` 关闭）：

```
/health, /healthz, /ready, /readiness, /liveness, /metrics, /favicon.ico
```

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
| `stdout.enabled` | `boolean` | `true` | 是否启用 stdout 输出 |
| `stdout.format` | `'json' \| 'text'` | `'json'` | 输出格式 |
| `stdout.includeBody` | `boolean` | `true` | 是否包含请求体（已脱敏） |
| `stdout.includeResponse` | `boolean` | `false` | 是否包含响应体（可能很大） |

```typescript
requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'auth-server',
  stdout: {
    enabled: true,       // 启用双写
    format: 'json',      // JSON 格式（K8s 友好）
    // includeBody: true,   // 默认包含请求体（已脱敏）
    // includeResponse: false, // 默认不含响应体（可能很大）
  },
})
```

**stdout 输出格式**（精简版，兼容 pino/K8s）：

```json
{"level":30,"time":1706123456789,"service":"auth-server","method":"POST","path":"/api/users","status":200,"duration":50,"requestId":"abc-123","clientIp":"1.2.3.4","msg":"POST /api/users 200 50ms"}
```

**日志级别根据状态码自动设置**：

| 状态码 | 级别 | pino level |
|--------|------|------------|
| 2xx | INFO | 30 |
| 4xx | WARN | 40 |
| 5xx | ERROR | 50 |

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
  clientIp: '1.2.3.4',           // 可选：从 X-Forwarded-For 等提取
  requestId: 'abc-123-def-456',  // 可选：分布式追踪 ID
}
```

### 客户端 IP 提取

自动从以下 header 提取（按优先级）：

1. `X-Forwarded-For`（第一个 IP）
2. `X-Real-IP`
3. `CF-Connecting-IP`（Cloudflare）
4. `True-Client-IP`（Akamai）

### Request ID 支持

支持分布式追踪，自动从以下位置获取：

1. `req.id`（如果使用了 `@vafast/request-id` 中间件）
2. 指定的 header（默认 `x-request-id`）

```typescript
import { requestId } from '@vafast/request-id'
import { requestLogger } from '@vafast/request-logger'

// 推荐：配合 request-id 中间件使用
app.use(requestId())  // 先生成/读取 ID
app.use(requestLogger({ ... }))  // 自动读取 req.id
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
- **智能日志级别**：根据状态码自动设置 INFO/WARN/ERROR
- **熔断器**：日志服务故障时自动熔断，避免雪崩
- **错误节流**：相同错误不刷屏，带统计计数
- **默认排除健康检查**：`/health`、`/metrics` 等路径默认不记录
- **路径排除**：支持精确匹配、前缀匹配、正则匹配
- **日志采样**：高流量场景下只记录部分请求
- **客户端 IP 提取**：自动从 X-Forwarded-For 等获取真实 IP
- **Request ID 支持**：分布式追踪，兼容 `@vafast/request-id`
- **敏感数据脱敏**：自动清洗密码、Token 等敏感字段
- **路由级别控制**：可在路由定义中禁用日志
- **支持多租户**：通过 headers 传递 appId

## 完整示例

### 最简配置（推荐）

```typescript
import { requestId } from '@vafast/request-id'
import { requestLogger } from '@vafast/request-logger'

// 推荐配合 request-id 使用
app.use(requestId())
app.use(requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'auth-server',
}))

// 开箱即用：
// ✅ stdout 双写默认开启
// ✅ 智能日志级别 (2xx/4xx/5xx)
// ✅ 健康检查路径默认排除
// ✅ 客户端 IP 自动提取
// ✅ Request ID 自动读取
// ✅ 智能 onError 处理
```

### 完整配置

```typescript
import { requestLogger } from '@vafast/request-logger'
import { logger } from './logger'

server.use(requestLogger({
  url: 'http://log-server:9005/api/logs/ingest',
  service: 'auth-server',
  headers: { Authorization: 'Bearer ak_xxx:sk_xxx' },
  timeout: 5000,
  enabled: true,
  // 路径排除（追加到默认排除列表）
  excludePaths: ['/verifyApiKey'],
  useDefaultExcludePaths: true,  // 使用默认排除（/health 等）
  // 日志采样（高流量场景）
  sampleRate: 1,  // 1 = 100%，0.1 = 10%
  // Request ID header
  requestIdHeader: 'x-request-id',
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
  // 自定义错误处理（可选，默认已有智能处理）
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
