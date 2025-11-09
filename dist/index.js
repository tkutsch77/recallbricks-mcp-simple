#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    apiUrl: process.env.RECALLBRICKS_API_URL || "https://recallbricks-api-clean.onrender.com",
    apiKey: process.env.RECALLBRICKS_API_KEY || "rbk_secret_2025_x7h2p9",
    maxRetries: parseInt(process.env.RECALLBRICKS_MAX_RETRIES || "3"),
    baseDelay: parseInt(process.env.RECALLBRICKS_BASE_DELAY || "1000"),
    requestTimeout: parseInt(process.env.RECALLBRICKS_TIMEOUT || "30000"),
    circuitBreakerThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || "5"),
    circuitBreakerTimeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || "60000"),
    cacheTTL: parseInt(process.env.CACHE_TTL || "3600000"), // 1 hour default
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "300000"), // 5 minutes
    maxMemoryTextLength: parseInt(process.env.MAX_MEMORY_TEXT_LENGTH || "10000"),
    enableMetrics: process.env.ENABLE_METRICS !== "false", // Enabled by default
    enableHealthChecks: process.env.ENABLE_HEALTH_CHECKS !== "false", // Enabled by default
};
// ============================================================================
// CUSTOM ERROR CLASS
// ============================================================================
class APIError extends Error {
    statusCode;
    url;
    attempts;
    originalError;
    constructor(message, statusCode, url, attempts, originalError) {
        super(message);
        this.statusCode = statusCode;
        this.url = url;
        this.attempts = attempts;
        this.originalError = originalError;
        this.name = 'APIError';
        Object.setPrototypeOf(this, APIError.prototype);
    }
    toJSON() {
        return {
            name: this.name,
            message: this.message,
            statusCode: this.statusCode,
            url: this.url,
            attempts: this.attempts,
            originalError: this.originalError?.message,
        };
    }
}
// ============================================================================
// CIRCUIT BREAKER
// ============================================================================
class CircuitBreaker {
    threshold;
    timeout;
    failures = 0;
    lastFailureTime = 0;
    state = 'CLOSED';
    successCount = 0;
    constructor(threshold = CONFIG.circuitBreakerThreshold, timeout = CONFIG.circuitBreakerTimeout) {
        this.threshold = threshold;
        this.timeout = timeout;
    }
    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeout) {
                this.state = 'HALF_OPEN';
                this.successCount = 0;
                console.error('🟡 Circuit breaker entering HALF_OPEN state');
            }
            else {
                throw new APIError('Circuit breaker is OPEN - service temporarily unavailable. Please try again later.', 503);
            }
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= 2) {
                this.state = 'CLOSED';
                this.failures = 0;
                console.error('✅ Circuit breaker CLOSED - service recovered');
            }
        }
        else {
            this.failures = 0;
            this.state = 'CLOSED';
        }
    }
    onFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.state === 'HALF_OPEN') {
            this.state = 'OPEN';
            console.error(`🔴 Circuit breaker reopened in HALF_OPEN state`);
        }
        else if (this.failures >= this.threshold) {
            this.state = 'OPEN';
            console.error(`🔴 Circuit breaker OPEN after ${this.failures} consecutive failures`);
        }
    }
    getState() {
        return this.state;
    }
    getStats() {
        return {
            state: this.state,
            failures: this.failures,
            lastFailureTime: this.lastFailureTime,
            successCount: this.successCount,
        };
    }
}
// ============================================================================
// REQUEST DEDUPLICATION CACHE
// ============================================================================
class RequestCache {
    pending = new Map();
    async fetch(key, fn) {
        if (this.pending.has(key)) {
            console.error(`♻️  Deduplicating request: ${key}`);
            return this.pending.get(key);
        }
        const promise = fn().finally(() => {
            this.pending.delete(key);
        });
        this.pending.set(key, promise);
        return promise;
    }
    clear() {
        this.pending.clear();
    }
}
// ============================================================================
// MEMORY CACHE FOR GRACEFUL DEGRADATION
// ============================================================================
class MemoryCache {
    cache = new Map();
    set(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
        });
    }
    get(key, ttl = CONFIG.cacheTTL) {
        const cached = this.cache.get(key);
        if (!cached)
            return null;
        if (Date.now() - cached.timestamp > ttl) {
            this.cache.delete(key);
            return null;
        }
        return cached.data;
    }
    clear() {
        this.cache.clear();
    }
    size() {
        return this.cache.size;
    }
}
// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================
function validateMemoryText(text) {
    if (typeof text !== 'string') {
        throw new APIError('Memory text must be a string', 400);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        throw new APIError('Memory text cannot be empty', 400);
    }
    if (trimmed.length > CONFIG.maxMemoryTextLength) {
        throw new APIError(`Memory text too long (max ${CONFIG.maxMemoryTextLength} characters, got ${trimmed.length})`, 400);
    }
    return trimmed;
}
function validateLimit(limit) {
    if (typeof limit !== 'number' && typeof limit !== 'undefined') {
        throw new APIError('Limit must be a number', 400);
    }
    const numLimit = limit || 5;
    if (numLimit < 1) {
        throw new APIError('Limit must be at least 1', 400);
    }
    if (numLimit > 100) {
        throw new APIError('Limit cannot exceed 100', 400);
    }
    return numLimit;
}
function validateQuery(query) {
    if (typeof query !== 'string') {
        throw new APIError('Query must be a string', 400);
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        throw new APIError('Query cannot be empty', 400);
    }
    return trimmed;
}
// ============================================================================
// METRICS LOGGING
// ============================================================================
function logMetrics(metrics) {
    if (!CONFIG.enableMetrics)
        return;
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: 'http_request',
        ...metrics,
    };
    console.error(JSON.stringify(logEntry));
}
// ============================================================================
// ENHANCED FETCH WITH RETRY, TIMEOUT, AND CIRCUIT BREAKER
// ============================================================================
async function fetchWithRetry(url, options, maxRetries = CONFIG.maxRetries, baseDelay = CONFIG.baseDelay, timeout = CONFIG.requestTimeout) {
    let lastError = null;
    let lastResponse = null;
    const startTime = Date.now();
    let attempts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attempts = attempt + 1;
        try {
            // Create AbortController for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                // If rate limited (429), wait and retry
                if (response.status === 429) {
                    lastResponse = response;
                    if (attempt < maxRetries) {
                        const retryAfter = response.headers.get('Retry-After');
                        let delay;
                        if (retryAfter) {
                            delay = isNaN(Number(retryAfter))
                                ? Math.max(0, new Date(retryAfter).getTime() - Date.now())
                                : Number(retryAfter) * 1000;
                        }
                        else {
                            delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
                        }
                        console.error(`⚠️  Rate limited, retrying in ${Math.round(delay)}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                // If server error (5xx), wait and retry
                if (response.status >= 500) {
                    lastResponse = response;
                    if (attempt < maxRetries) {
                        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
                        console.error(`⚠️  Server error ${response.status}, retrying in ${Math.round(delay)}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                // Log successful request metrics
                logMetrics({
                    url,
                    method: options.method || 'GET',
                    attempts,
                    totalDuration: Date.now() - startTime,
                    success: response.ok,
                    statusCode: response.status,
                });
                return response;
            }
            catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }
        catch (error) {
            const err = error;
            if (err.name === 'AbortError') {
                lastError = new APIError(`Request timeout after ${timeout}ms`, 408, url, attempts);
            }
            else {
                lastError = error;
            }
            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
                console.error(`⚠️  Network error, retrying in ${Math.round(delay)}ms... (attempt ${attempt + 1}/${maxRetries + 1})`);
                console.error(`   Error: ${lastError.message}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    // Log failed request metrics
    logMetrics({
        url,
        method: options.method || 'GET',
        attempts,
        totalDuration: Date.now() - startTime,
        success: false,
        statusCode: lastResponse?.status,
        error: lastError?.message,
    });
    if (lastResponse) {
        return lastResponse;
    }
    throw new APIError(lastError?.message || 'Max retries exceeded', undefined, url, attempts, lastError || undefined);
}
// ============================================================================
// GLOBAL INSTANCES
// ============================================================================
const circuitBreaker = new CircuitBreaker();
const requestCache = new RequestCache();
const memoryCache = new MemoryCache();
// ============================================================================
// HEALTH CHECK SYSTEM
// ============================================================================
async function healthCheck() {
    try {
        const response = await fetchWithRetry(`${CONFIG.apiUrl}/health`, {
            method: 'GET',
            headers: { 'x-api-key': CONFIG.apiKey },
        }, 1, // Only 1 retry
        500, // Fast fail
        5000 // 5 second timeout
        );
        const healthy = response.ok;
        if (CONFIG.enableMetrics) {
            console.error(JSON.stringify({
                timestamp: new Date().toISOString(),
                type: 'health_check',
                healthy,
                statusCode: response.status,
                circuitBreaker: circuitBreaker.getStats(),
            }));
        }
        return healthy;
    }
    catch (error) {
        if (CONFIG.enableMetrics) {
            console.error(JSON.stringify({
                timestamp: new Date().toISOString(),
                type: 'health_check',
                healthy: false,
                error: error.message,
                circuitBreaker: circuitBreaker.getStats(),
            }));
        }
        return false;
    }
}
function startHealthChecks() {
    if (!CONFIG.enableHealthChecks)
        return;
    // Initial health check
    healthCheck().catch(() => { });
    // Periodic health checks
    setInterval(() => {
        healthCheck().catch(() => { });
    }, CONFIG.healthCheckInterval);
}
// ============================================================================
// API HELPER FUNCTIONS
// ============================================================================
async function createMemoryAPI(text) {
    const validatedText = validateMemoryText(text);
    return circuitBreaker.execute(async () => {
        const cacheKey = `POST:${CONFIG.apiUrl}/api/v1/memories:${validatedText}`;
        const response = await requestCache.fetch(cacheKey, () => fetchWithRetry(`${CONFIG.apiUrl}/api/v1/memories`, {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: validatedText,
                source: 'claude',
                project_id: 'default',
                tags: [],
                metadata: {},
            }),
        }));
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to create memory: ${response.statusText}`, response.status, `${CONFIG.apiUrl}/api/v1/memories`);
        }
        const data = await response.json();
        return data;
    });
}
async function queryMemoriesAPI(query, limit) {
    const validatedQuery = validateQuery(query);
    const validatedLimit = validateLimit(limit);
    return circuitBreaker.execute(async () => {
        const url = new URL(`${CONFIG.apiUrl}/api/v1/memories`);
        url.searchParams.append('limit', String(validatedLimit));
        const cacheKey = `GET:${url.toString()}`;
        try {
            const response = await requestCache.fetch(cacheKey, () => fetchWithRetry(url.toString(), {
                method: 'GET',
                headers: {
                    'x-api-key': CONFIG.apiKey,
                },
            }));
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new APIError(errorData.message || `Failed to query memories: ${response.statusText}`, response.status, url.toString());
            }
            const data = await response.json();
            // Cache successful query results
            memoryCache.set(cacheKey, data);
            return data;
        }
        catch (error) {
            // Try to use cached data as fallback
            const cached = memoryCache.get(cacheKey);
            if (cached) {
                console.error('⚠️  Using cached data due to API failure');
                logMetrics({
                    url: url.toString(),
                    method: 'GET',
                    attempts: 1,
                    totalDuration: 0,
                    success: true,
                    cached: true,
                });
                return cached;
            }
            throw error;
        }
    });
}
// ============================================================================
// MCP SERVER SETUP
// ============================================================================
const server = new Server({
    name: 'recallbricks-memory',
    version: '2.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'create_memory',
                description: 'Save a new memory to RecallBricks with automatic retry and circuit breaker protection',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'The memory content to save (max 10,000 characters)',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'query_memories',
                description: 'Search and retrieve memories from RecallBricks with caching and fallback support',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query to find relevant memories',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of memories to return (1-100, default: 5)',
                        },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_health',
                description: 'Get the current health status and metrics of the RecallBricks MCP server',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
        ],
    };
});
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        if (name === 'create_memory') {
            const result = await createMemoryAPI(args.text);
            return {
                content: [
                    {
                        type: 'text',
                        text: `✅ Memory saved successfully!\n\nID: ${result.id}\nCreated: ${result.created_at}\nLength: ${result.text.length} characters`,
                    },
                ],
            };
        }
        if (name === 'query_memories') {
            const result = await queryMemoriesAPI(args.query, args.limit);
            const memories = result.memories || [];
            if (memories.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: '📭 No memories found matching your query.',
                        },
                    ],
                };
            }
            const memoryText = memories
                .map((m, idx) => `${idx + 1}. [${m.id}] ${m.text.substring(0, 200)}${m.text.length > 200 ? '...' : ''}\n   Created: ${m.created_at || 'N/A'}`)
                .join('\n\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: `📚 Found ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}${result.total ? ` (total available: ${result.total})` : ''}:\n\n${memoryText}`,
                    },
                ],
            };
        }
        if (name === 'get_health') {
            const cbStats = circuitBreaker.getStats();
            const cacheSize = memoryCache.size();
            const healthStatus = {
                status: cbStats.state === 'CLOSED' ? 'healthy' : cbStats.state === 'HALF_OPEN' ? 'degraded' : 'unhealthy',
                circuitBreaker: cbStats,
                cache: {
                    size: cacheSize,
                    ttl: CONFIG.cacheTTL,
                },
                config: {
                    maxRetries: CONFIG.maxRetries,
                    requestTimeout: CONFIG.requestTimeout,
                    apiUrl: CONFIG.apiUrl,
                },
            };
            return {
                content: [
                    {
                        type: 'text',
                        text: `🏥 RecallBricks MCP Server Health Report\n\n${JSON.stringify(healthStatus, null, 2)}`,
                    },
                ],
            };
        }
        throw new APIError(`Unknown tool: ${name}`, 400);
    }
    catch (error) {
        const apiError = error instanceof APIError ? error : new APIError(error.message);
        console.error('MCP Error:', JSON.stringify(apiError.toJSON()));
        return {
            content: [
                {
                    type: 'text',
                    text: `❌ Error: ${apiError.message}${apiError.statusCode ? ` (HTTP ${apiError.statusCode})` : ''}`,
                },
            ],
            isError: true,
        };
    }
});
// ============================================================================
// SERVER STARTUP
// ============================================================================
async function main() {
    // Validate critical configuration
    if (!CONFIG.apiKey || CONFIG.apiKey.length < 10) {
        console.error('❌ FATAL: Invalid or missing API key');
        process.exit(1);
    }
    // Start health checks
    startHealthChecks();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('✨ RecallBricks MCP Server v2.0.0 - Production Ready');
    console.error(`🔗 Connected to: ${CONFIG.apiUrl}`);
    console.error(`🔑 API Key: ${CONFIG.apiKey.substring(0, 10)}...`);
    console.error(`🛡️  Circuit Breaker: ${circuitBreaker.getState()}`);
    console.error(`⚡ Max Retries: ${CONFIG.maxRetries}`);
    console.error(`⏱️  Request Timeout: ${CONFIG.requestTimeout}ms`);
    console.error(`💾 Cache TTL: ${CONFIG.cacheTTL}ms`);
    console.error(`📊 Metrics: ${CONFIG.enableMetrics ? 'ENABLED' : 'DISABLED'}`);
    console.error(`💊 Health Checks: ${CONFIG.enableHealthChecks ? 'ENABLED' : 'DISABLED'}`);
    console.error('🚀 Server is ready to handle requests!');
}
main().catch((error) => {
    console.error('❌ Fatal error during startup:', error);
    process.exit(1);
});
