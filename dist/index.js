// src/sanitize.ts
var DEFAULT_REMOVE_FIELDS = [
  "password",
  "newpassword",
  "oldpassword",
  "confirmpassword",
  "secret",
  "secretkey",
  "privatekey",
  "apisecret",
  "clientsecret"
];
var DEFAULT_MASK_FIELDS = [
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "apikey",
  "api_key",
  "x-api-key",
  "idtoken",
  "sessiontoken",
  "bearer"
];
var DEFAULT_PLACEHOLDER = "[REDACTED]";
var DEFAULT_MAX_DEPTH = 10;
function partialMask(value, placeholder) {
  if (value.length <= 8) return placeholder;
  return value.slice(0, 4) + "****" + value.slice(-4);
}
function sanitize(data, config, depth = 0) {
  const {
    removeFields = DEFAULT_REMOVE_FIELDS,
    maskFields = DEFAULT_MASK_FIELDS,
    placeholder = DEFAULT_PLACEHOLDER,
    maxDepth = DEFAULT_MAX_DEPTH
  } = config ?? {};
  if (depth > maxDepth) return data;
  if (data === null || data === void 0) {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => sanitize(item, config, depth + 1));
  }
  if (typeof data === "object") {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (removeFields.some((field) => lowerKey === field)) {
        result[key] = placeholder;
        continue;
      }
      if (maskFields.some((field) => lowerKey.includes(field))) {
        if (typeof value === "string") {
          result[key] = partialMask(value, placeholder);
        } else {
          result[key] = placeholder;
        }
        continue;
      }
      result[key] = sanitize(value, config, depth + 1);
    }
    return result;
  }
  return data;
}
function sanitizeHeaders(headers, config) {
  const {
    maskFields = DEFAULT_MASK_FIELDS,
    placeholder = DEFAULT_PLACEHOLDER
  } = config ?? {};
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === "authorization") {
      if (value.startsWith("Bearer ")) {
        result[key] = "Bearer " + partialMask(value.slice(7), placeholder);
      } else {
        result[key] = partialMask(value, placeholder);
      }
      continue;
    }
    if (lowerKey === "cookie" || lowerKey === "set-cookie") {
      result[key] = placeholder;
      continue;
    }
    if (maskFields.some((field) => lowerKey.includes(field))) {
      result[key] = partialMask(value, placeholder);
      continue;
    }
    result[key] = value;
  }
  return result;
}

// src/index.ts
function createRequestLogger(config) {
  const {
    storage,
    excludePaths = [],
    sanitize: sanitizeConfig,
    getUserId,
    onError = console.error,
    enabled = true
  } = config;
  return async (req, next) => {
    if (!enabled) {
      return next();
    }
    const startTime = Date.now();
    const response = await next();
    recordLog(req, response, startTime, {
      storage,
      excludePaths,
      sanitizeConfig,
      getUserId,
      onError
    }).catch(onError);
    return response;
  };
}
async function recordLog(req, response, startTime, options) {
  const { storage, excludePaths, sanitizeConfig, getUserId } = options;
  const url = new URL(req.url);
  const path = url.pathname;
  const shouldExclude = excludePaths.some((pattern) => {
    if (typeof pattern === "string") {
      return path.includes(pattern);
    }
    return pattern.test(path);
  });
  if (shouldExclude) {
    return;
  }
  let body = null;
  try {
    const clonedReq = req.clone();
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      body = await clonedReq.json();
    }
  } catch {
  }
  let responseData = {};
  try {
    const clonedRes = response.clone();
    responseData = await clonedRes.json();
  } catch {
  }
  const headers = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const sanitizedHeaders = sanitizeHeaders(headers, sanitizeConfig);
  const sanitizedBody = sanitize(body, sanitizeConfig);
  const sanitizedResponseData = sanitize(responseData.data, sanitizeConfig);
  const now = /* @__PURE__ */ new Date();
  const duration = Date.now() - startTime;
  const userId = getUserId?.(req);
  const requestLogId = await storage.saveRequestLog({
    method: req.method,
    url: req.url,
    path,
    headers: sanitizedHeaders,
    body: sanitizedBody,
    query: Object.fromEntries(url.searchParams),
    response: {
      success: responseData.success,
      message: responseData.message,
      code: responseData.code
    },
    status: response.status,
    duration,
    userId,
    createdAt: now
  });
  await storage.saveResponseLog({
    requestLogId,
    success: responseData.success,
    message: responseData.message,
    code: responseData.code,
    data: sanitizedResponseData,
    createdAt: now
  });
}
function createMongoAdapter(db, logsCollection = "logs", logsResponseCollection = "logsResponse") {
  return {
    async saveRequestLog(log) {
      const result = await db.collection(logsCollection).insertOne({
        ...log,
        createAt: log.createdAt,
        updateAt: log.createdAt
      });
      return result.insertedId.toHexString();
    },
    async saveResponseLog(log) {
      await db.collection(logsResponseCollection).insertOne({
        logsId: log.requestLogId,
        ...log,
        createAt: log.createdAt,
        updateAt: log.createdAt
      });
    }
  };
}
function createConsoleAdapter() {
  let idCounter = 0;
  return {
    async saveRequestLog(log) {
      const id = `log_${++idCounter}`;
      console.log(`[REQUEST] ${log.method} ${log.path} ${log.status} ${log.duration}ms`);
      return id;
    },
    async saveResponseLog(log) {
      if (!log.success) {
        console.log(`[RESPONSE ERROR] ${log.message}`);
      }
    }
  };
}
var index_default = createRequestLogger;
export {
  createConsoleAdapter,
  createMongoAdapter,
  createRequestLogger,
  index_default as default,
  sanitize,
  sanitizeHeaders
};
//# sourceMappingURL=index.js.map