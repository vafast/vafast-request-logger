# @vafast/request-logger

API request logging middleware for Vafast with automatic sensitive data sanitization.

## Features

- 📝 Automatic API request/response logging
- 🔒 Built-in sensitive data sanitization (passwords, tokens, etc.)
- 🔌 Pluggable storage adapters (MongoDB, HTTP, Console, Custom)
- 🌐 HTTP adapter for microservices architecture
- ⚡ Non-blocking async logging
- 🚫 Path exclusion support
- 📊 Request duration tracking

## Installation

```bash
npm install @vafast/request-logger
# or
npm install @vafast/request-logger
```

## Quick Start

### With MongoDB

```typescript
import { Server } from 'vafast'
import { createRequestLogger, createMongoAdapter } from '@vafast/request-logger'
import { mongoDb } from './mongodb'

const server = new Server(routes)

// Create request logger middleware
const requestLogger = createRequestLogger({
  storage: createMongoAdapter(mongoDb, 'logs', 'logsResponse'),
  excludePaths: ['/health', '/metrics', '/performance/add'],
  getUserId: (req) => {
    const locals = getLocals(req)
    return locals?.userInfo?.id
  },
})

server.use(requestLogger)
```

### With HTTP (Microservices)

```typescript
import { createRequestLogger, createHttpAdapter } from '@vafast/request-logger'

const requestLogger = createRequestLogger({
  storage: createHttpAdapter({
    url: 'http://log-server:9005/api/logs/ingest',
    headers: {
      'Authorization': 'Bearer your-api-key',
    },
  }),
  service: 'auth-server',
})
```

### Development (Console)

```typescript
import { createRequestLogger, createConsoleAdapter } from '@vafast/request-logger'

const requestLogger = createRequestLogger({
  storage: createConsoleAdapter(),
})
```

## Sensitive Data Sanitization

The middleware automatically sanitizes sensitive data before logging:

| Original | Sanitized |
|----------|-----------|
| `{ password: "abc123" }` | `{ password: "[REDACTED]" }` |
| `Authorization: "Bearer eyJhbG..."` | `Authorization: "Bearer eyJh****bG..."` |
| `Cookie: "session=xxx"` | `Cookie: "[REDACTED]"` |
| `{ apiKey: "sk-1234567890abcdef" }` | `{ apiKey: "sk-1****cdef" }` |

### Default Removed Fields

- `password`, `newPassword`, `oldPassword`
- `secret`, `secretKey`, `privateKey`
- `apiSecret`, `clientSecret`

### Default Masked Fields (partial)

- `token`, `accessToken`, `refreshToken`
- `authorization`, `apiKey`, `bearer`

### Custom Sanitization

```typescript
const requestLogger = createRequestLogger({
  storage: adapter,
  sanitize: {
    removeFields: ['password', 'ssn', 'creditCard'],
    maskFields: ['token', 'apiKey', 'phoneNumber'],
    placeholder: '***HIDDEN***',
  },
})
```

## Configuration

```typescript
interface RequestLoggerConfig {
  /** Storage adapter (required) */
  storage: StorageAdapter
  /** Paths to exclude from logging */
  excludePaths?: (string | RegExp)[]
  /** Sanitization config */
  sanitize?: SanitizeConfig
  /** Function to get user ID from request */
  getUserId?: (req: Request) => string | undefined
  /** Error callback */
  onError?: (error: Error) => void
  /** Enable/disable logging @default true */
  enabled?: boolean
}
```

## HTTP Adapter Configuration

For microservices architecture, use `createHttpAdapter` to send logs to a remote log service.

**Features:**
- Single HTTP request per log (request + response combined)
- Server-side splits data into separate collections
- Reduced network overhead

```typescript
import { createHttpAdapter } from '@vafast/request-logger'

const adapter = createHttpAdapter({
  // Required: API endpoint
  url: 'http://log-server/api/logs/ingest',
  
  // Optional: Custom headers (authentication, etc.)
  headers: {
    'Authorization': 'Bearer ak_xxx:sk_xxx',
  },
  
  // Optional: Timeout in milliseconds (default: 5000)
  timeout: 5000,
  
  // Optional: Custom field mapping
  mapLog: (log) => ({
    ...log.request,
    responseData: log.response.data,
    timestamp: log.request.createdAt.toISOString(),
  }),
  
  // Optional: Error callback
  onError: (error) => console.error('Log failed:', error),
})
```

### HTTP Adapter Config Reference

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `url` | `string` | ✅ | - | Log API endpoint |
| `headers` | `Record<string, string>` | ❌ | `{}` | Custom HTTP headers |
| `timeout` | `number` | ❌ | `5000` | Request timeout (ms) |
| `mapLog` | `(log: LogData) => object` | ❌ | Built-in | Field mapping function |
| `onError` | `(error) => void` | ❌ | - | Error callback |

### Expected Request Body

The adapter sends a combined log with this default structure:

```json
{
  "method": "POST",
  "url": "http://example.com/api/users",
  "path": "/api/users",
  "headers": {},
  "body": {},
  "query": {},
  "status": 200,
  "duration": 15,
  "userId": "123",
  "appId": "app_1",
  "authType": "jwt",
  "service": "auth-server",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "response": { "success": true, "message": "OK", "code": 0 },
  "responseData": { /* full response data */ }
}
```

The server should split and store:
- Main fields → `logs` collection
- `responseData` → `logsResponse` collection (with reference to log ID)

## Custom Storage Adapter

```typescript
import type { StorageAdapter, LogData } from '@vafast/request-logger'

const myAdapter: StorageAdapter = {
  async saveLog(log: LogData) {
    // log.request - 请求信息
    // log.response - 响应信息（包含 data）
    await myDb.insert('logs', {
      ...log.request,
      response: log.response,
    })
  },
}
```

## Log Structure

```typescript
interface LogData {
  request: {
    method: 'POST',
    url: 'http://localhost:3000/api/users',
    path: '/api/users',
    headers: { /* sanitized */ },
    body: { /* sanitized */ },
    query: {},
    status: 200,
    duration: 15,
    userId: '123',
    appId: 'app_1',
    authType: 'jwt',
    service: 'auth-server',
    createdAt: Date,
  },
  response: {
    success: true,
    message: 'OK',
    code: 0,
    data: { /* sanitized response data */ },
  },
}
```

## License

MIT

