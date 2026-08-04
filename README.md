# @vafast/request-logger

HTTP 访问日志中间件：脱敏、异步上报远程服务、stdout 双写、熔断与错误节流。

> `url` 与 `service` **必填**。应用内 `logger.info` 请用 [`@vafast/logger`](https://www.npmjs.com/package/@vafast/logger)（不是中间件）。

## 安装

```bash
npm install @vafast/request-logger
```

## 快速开始

```typescript
import { Server, defineRoute, defineRoutes, serve } from 'vafast'
import { requestId } from '@vafast/request-id'
import { requestLogger } from '@vafast/request-logger'

const routes = defineRoutes([
  defineRoute({
    method: 'GET',
    path: '/',
    handler: () => ({ ok: true }),
  }),
])

const server = new Server(routes)
server.use(requestId())
server.use(
  requestLogger({
    url: 'http://log-server:9005/api/logs/ingest',
    service: 'my-server',
  }),
)

serve({ fetch: server.fetch, port: 3000 })
```

## 用法

### 排除路径 / 路由关闭

```typescript
requestLogger({
  url: '...',
  service: 'my-server',
  excludePaths: ['/health', /^\/metrics/],
})

defineRoute({
  method: 'GET',
  path: '/ready',
  log: false,
  handler: () => ({ ok: true }),
})
```

### stdout / 采样 / 熔断

```typescript
requestLogger({
  url: '...',
  service: 'gateway',
  sampleRate: 0.1,
  stdout: { format: 'json', includeResponse: false },
  circuitBreaker: { failureThreshold: 5, resetTimeout: 60_000 },
  errorThrottle: { interval: 60_000 },
})
```

### 自定义业务字段

```typescript
requestLogger({
  url: '...',
  service: 'billing',
  getUserId: ({ req }) => req.__locals?.userInfo?.id,
  getAppId: async ({ body }) => lookupAppId(body),
  getAuthType: ({ headers }) =>
    headers.authorization?.startsWith('Bearer ak_') ? 'apiKey' : undefined,
})
```

## API 完整参数

### `requestLogger(options)` — `RequestLoggerOptions`

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `url` | **是** | — | 远程 ingest URL |
| `service` | **是** | — | 服务标识 |
| `headers` | 否 | `{}` | 上报额外头 |
| `timeout` | 否 | `5000` | 超时毫秒 |
| `enabled` | 否 | `true` | 总开关 |
| `excludePaths` | 否 | `[]` | 排除路径 |
| `sanitize` | 否 | 内置 | `removeFields` / `maskFields` / `placeholder` / `maxDepth` |
| `onError` | 否 | 结构化 warn | `(error, { droppedCount })` |
| `circuitBreaker` | 否 | `5` / `60000` | 熔断 |
| `errorThrottle` | 否 | `60000` | 错误节流 |
| `stdout` | 否 | 开启 JSON | `enabled` / `format` / `includeBody` / `includeResponse` |
| `sampleRate` | 否 | `1` | `0–1` |
| `requestIdHeader` | 否 | `'x-request-id'` | 无 `req.id` 时读取 |
| `getAppId` / `getUserId` / `getAuthType` | 否 | — | 自定义提取 |

`createRequestLogger` 为废弃别名。另导出 `sanitize` / `sanitizeHeaders`。

## 最佳实践

- 先 `requestId()` 再本中间件
- 健康检查用 `excludePaths` 或 `log: false`（**无**默认排除 `/health`）
- 高流量用 `sampleRate`；stdout 默认不要带完整 response
- 支付回调等用 `getAppId` 从 body 反查

## 端字段（Ones App Client）

在 headers 脱敏前读取约定头，并写入 ingest **顶层**字段（log-server 不再从 headers 兜底解析）：

| Header | 顶层字段 | 示例 |
|--------|----------|------|
| `client-key` | `clientKey` | `web` / `desktop` / `ios` / `android` |
| `x-platform` | `platform` | `browser` / `darwin` / `win32` / `linux` / `ios` / `android` |
| `x-app-version` | `appVersion` | `1.2.3` |

缺失或空串时**不写**该顶层字段（可选，非必填；服务间调用通常没有）。

## 注意事项

- 上报异步，失败不影响业务响应
- 跳过日志的请求不会 `clone` 读 body
- sanitize 字段名是 `removeFields` / `maskFields`，不是 `fields` / `mask`
- JWT userId 默认解析不验签，仅日志归属

## 相关链接

- 文档：[`docs/middleware/request-logger.md`](../vafast-doc/docs/middleware/request-logger.md)
- [@vafast/logger](https://www.npmjs.com/package/@vafast/logger)
- [@vafast/request-id](https://www.npmjs.com/package/@vafast/request-id)

## License

MIT
