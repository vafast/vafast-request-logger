import { Middleware } from 'vafast';

/**
 * 敏感数据清洗工具
 *
 * 用于在记录日志前移除或脱敏敏感信息
 */
interface SanitizeConfig {
    /** 需要完全移除的字段（小写） */
    removeFields?: string[];
    /** 需要脱敏的字段（小写，部分匹配） */
    maskFields?: string[];
    /** 脱敏占位符 @default '[REDACTED]' */
    placeholder?: string;
    /** 最大递归深度 @default 10 */
    maxDepth?: number;
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
declare function sanitize<T>(data: T, config?: SanitizeConfig, depth?: number): T;
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
declare function sanitizeHeaders(headers: Record<string, string>, config?: SanitizeConfig): Record<string, string>;

/**
 * @vafast/request-logger - API request logging middleware for Vafast
 *
 * Features:
 * - Automatic sensitive data sanitization
 * - Pluggable storage adapters (MongoDB, custom)
 * - Async logging (non-blocking)
 * - Path exclusion support
 */

interface RequestLog {
    method: string;
    url: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
    query: Record<string, string>;
    response: {
        success?: boolean;
        message?: string;
        code?: number;
    };
    status: number;
    duration: number;
    userId?: string;
    createdAt: Date;
}
interface ResponseLog {
    requestLogId: string;
    success?: boolean;
    message?: string;
    code?: number;
    data?: unknown;
    createdAt: Date;
}
/**
 * 存储适配器接口
 */
interface StorageAdapter {
    /** 存储请求日志 */
    saveRequestLog(log: RequestLog): Promise<string>;
    /** 存储响应详情 */
    saveResponseLog(log: ResponseLog): Promise<void>;
}
interface RequestLoggerConfig {
    /** 存储适配器 */
    storage: StorageAdapter;
    /** 排除的路径（支持字符串或正则） */
    excludePaths?: (string | RegExp)[];
    /** 敏感数据清洗配置 */
    sanitize?: SanitizeConfig;
    /** 获取用户 ID 的函数 */
    getUserId?: (req: Request) => string | undefined;
    /** 错误回调 */
    onError?: (error: Error) => void;
    /** 是否启用 @default true */
    enabled?: boolean;
}
/**
 * 创建请求日志中间件
 *
 * @example
 * ```typescript
 * import { createRequestLogger, createMongoAdapter } from '@vafast/request-logger'
 * import { mongoDb } from './mongodb'
 *
 * const requestLogger = createRequestLogger({
 *   storage: createMongoAdapter(mongoDb, 'logs', 'logsResponse'),
 *   excludePaths: ['/health', '/metrics'],
 *   getUserId: (req) => getLocals(req)?.userInfo?.id,
 * })
 *
 * server.use(requestLogger)
 * ```
 */
declare function createRequestLogger(config: RequestLoggerConfig): Middleware;
/**
 * 创建 MongoDB 存储适配器
 *
 * @example
 * ```typescript
 * import { Db } from 'mongodb'
 * import { createMongoAdapter } from '@vafast/request-logger'
 *
 * const adapter = createMongoAdapter(db, 'logs', 'logsResponse')
 * ```
 */
declare function createMongoAdapter(db: {
    collection: (name: string) => {
        insertOne: (doc: any) => Promise<{
            insertedId: {
                toHexString: () => string;
            };
        }>;
    };
}, logsCollection?: string, logsResponseCollection?: string): StorageAdapter;
/**
 * 创建控制台存储适配器（用于开发调试）
 */
declare function createConsoleAdapter(): StorageAdapter;

export { type RequestLog, type RequestLoggerConfig, type ResponseLog, type SanitizeConfig, type StorageAdapter, createConsoleAdapter, createMongoAdapter, createRequestLogger, createRequestLogger as default, sanitize, sanitizeHeaders };
