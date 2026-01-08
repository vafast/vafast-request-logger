# @vafast/request-logger

API request logging middleware for Vafast with automatic sensitive data sanitization.

## Features

- 📝 Automatic API request/response logging
- 🔒 Built-in sensitive data sanitization (passwords, tokens, etc.)
- 🔌 Pluggable storage adapters (MongoDB, Console, Custom)
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

## Custom Storage Adapter

```typescript
import type { StorageAdapter } from '@vafast/request-logger'

const myAdapter: StorageAdapter = {
  async saveRequestLog(log) {
    // Save to your database
    const id = await myDb.insert('request_logs', log)
    return id
  },

  async saveResponseLog(log) {
    // Save response details
    await myDb.insert('response_logs', log)
  },
}
```

## Log Structure

### Request Log

```typescript
{
  method: 'POST',
  url: 'http://localhost:3000/api/users',
  path: '/api/users',
  headers: { /* sanitized */ },
  body: { /* sanitized */ },
  query: {},
  response: {
    success: true,
    message: 'OK',
    code: 0,
  },
  status: 200,
  duration: 15,
  userId: '123',
  createdAt: Date,
}
```

### Response Log

```typescript
{
  requestLogId: 'abc123',
  success: true,
  message: 'OK',
  code: 0,
  data: { /* sanitized response data */ },
  createdAt: Date,
}
```

## License

MIT

