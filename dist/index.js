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
/**
 * Agent Configuration - Customizable via environment variables
 *
 * Users can set:
 * - RECALLBRICKS_AGENT_ID: Unique identifier for this agent instance
 * - RECALLBRICKS_AGENT_NAME: Display name (optional)
 * - RECALLBRICKS_USER_ID: User identifier
 *
 * Example in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "recallbricks": {
 *       "command": "node",
 *       "args": ["build/index.js"],
 *       "env": {
 *         "RECALLBRICKS_API_KEY": "rbk_...",
 *         "RECALLBRICKS_AGENT_ID": "tyler_personal_assistant",
 *         "RECALLBRICKS_AGENT_NAME": "Nova",
 *         "RECALLBRICKS_USER_ID": "tyler"
 *       }
 *     }
 *   }
 * }
 */
const AGENT_CONFIG = {
    agentId: process.env.RECALLBRICKS_AGENT_ID || `claude_desktop_${process.env.USER || process.env.USERNAME || 'user'}`,
    displayName: process.env.RECALLBRICKS_AGENT_NAME,
    userId: process.env.RECALLBRICKS_USER_ID || 'default',
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
async function predictMemoriesAPI(currentContext, recentMemories, limit) {
    return circuitBreaker.execute(async () => {
        const url = new URL(`${CONFIG.apiUrl}/api/v1/memories/predict`);
        if (currentContext) {
            url.searchParams.append('current_context', currentContext);
        }
        if (recentMemories && recentMemories.length > 0) {
            url.searchParams.append('recent_memories', JSON.stringify(recentMemories));
        }
        if (limit) {
            url.searchParams.append('limit', String(limit));
        }
        const response = await fetchWithRetry(url.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': CONFIG.apiKey,
            },
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to predict memories: ${response.statusText}`, response.status, url.toString());
        }
        return await response.json();
    });
}
async function suggestMemoriesAPI(context, limit, includeReasoning, minConfidence) {
    const validatedContext = validateQuery(context);
    const validatedLimit = validateLimit(limit);
    return circuitBreaker.execute(async () => {
        const response = await fetchWithRetry(`${CONFIG.apiUrl}/api/v1/memories/suggest`, {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                context: validatedContext,
                limit: validatedLimit,
                include_reasoning: includeReasoning ?? true,
                min_confidence: minConfidence ?? 0.6,
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to get suggestions: ${response.statusText}`, response.status, `${CONFIG.apiUrl}/api/v1/memories/suggest`);
        }
        return await response.json();
    });
}
async function getLearningMetricsAPI(days) {
    return circuitBreaker.execute(async () => {
        const url = new URL(`${CONFIG.apiUrl}/api/v1/learning/metrics`);
        if (days) {
            url.searchParams.append('days', String(days));
        }
        const response = await fetchWithRetry(url.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': CONFIG.apiKey,
            },
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to get learning metrics: ${response.statusText}`, response.status, url.toString());
        }
        return await response.json();
    });
}
async function getPatternsAPI(days) {
    return circuitBreaker.execute(async () => {
        const url = new URL(`${CONFIG.apiUrl}/api/v1/memories/meta/patterns`);
        if (days) {
            url.searchParams.append('days', String(days));
        }
        const response = await fetchWithRetry(url.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': CONFIG.apiKey,
            },
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to get patterns: ${response.statusText}`, response.status, url.toString());
        }
        return await response.json();
    });
}
async function searchMemoriesWeightedAPI(query, limit, weightByUsage, decayOldMemories, learningMode, minHelpfulnessScore, adaptiveWeights) {
    const validatedQuery = validateQuery(query);
    const validatedLimit = validateLimit(limit);
    return circuitBreaker.execute(async () => {
        const response = await fetchWithRetry(`${CONFIG.apiUrl}/api/v1/memories/search`, {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query: validatedQuery,
                limit: validatedLimit,
                weight_by_usage: weightByUsage ?? false,
                decay_old_memories: decayOldMemories ?? false,
                learning_mode: learningMode ?? false,
                min_helpfulness_score: minHelpfulnessScore,
                adaptive_weights: adaptiveWeights ?? true,
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to search memories: ${response.statusText}`, response.status, `${CONFIG.apiUrl}/api/v1/memories/search`);
        }
        return await response.json();
    });
}
async function getAgentContextAPI(agentId = 'nova', userId = 'default', depth = 'standard') {
    return circuitBreaker.execute(async () => {
        const response = await fetchWithRetry(`${CONFIG.apiUrl}/api/v1/agents/${agentId}/context`, {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                user_id: userId,
                depth: depth,
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to get agent context: ${response.statusText}`, response.status, `${CONFIG.apiUrl}/api/v1/agents/${agentId}/context`);
        }
        return await response.json();
    });
}
async function autoSaveMemoryAPI(text, userId = 'default', context, forceSave = false) {
    const validatedText = validateMemoryText(text);
    return circuitBreaker.execute(async () => {
        const response = await fetchWithRetry(`${CONFIG.apiUrl}/api/v1/memories/auto-save`, {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: validatedText,
                user_id: userId,
                context: context,
                force_save: forceSave,
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to auto-save memory: ${response.statusText}`, response.status, `${CONFIG.apiUrl}/api/v1/memories/auto-save`);
        }
        return await response.json();
    });
}
async function validateAgentIdentityAPI(agentId, responseText, autoCorrect = false) {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
        throw new APIError('Agent ID must be a non-empty string', 400);
    }
    const validatedText = validateMemoryText(responseText);
    return circuitBreaker.execute(async () => {
        const response = await fetchWithRetry(`${CONFIG.apiUrl}/api/v1/agents/validate-identity`, {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                agent_id: agentId,
                response_text: validatedText,
                auto_correct: autoCorrect,
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new APIError(errorData.message || `Failed to validate agent identity: ${response.statusText}`, response.status, `${CONFIG.apiUrl}/api/v1/agents/validate-identity`);
        }
        return await response.json();
    });
}
// ============================================================================
// MCP SERVER SETUP
// ============================================================================
const server = new Server({
    name: 'recallbricks-memory',
    version: '3.0.0',
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
                name: 'search_memories_weighted',
                description: 'Advanced semantic search with usage-based weighting, recency decay, and adaptive learning',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query to find relevant memories',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of memories to return (1-100, default: 10)',
                        },
                        weight_by_usage: {
                            type: 'boolean',
                            description: 'Boost frequently-used memories in results (default: false)',
                        },
                        decay_old_memories: {
                            type: 'boolean',
                            description: 'Penalize stale memories not accessed in 90+ days (default: false)',
                        },
                        learning_mode: {
                            type: 'boolean',
                            description: 'Track which results are used to improve future searches (default: false)',
                        },
                        min_helpfulness_score: {
                            type: 'number',
                            description: 'Filter results below this helpfulness threshold (0.0-1.0)',
                        },
                        adaptive_weights: {
                            type: 'boolean',
                            description: 'Use per-user learned weights for personalization (default: true)',
                        },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'predict_memories',
                description: 'Predict which memories will likely be needed next based on context and usage patterns',
                inputSchema: {
                    type: 'object',
                    properties: {
                        current_context: {
                            type: 'string',
                            description: 'What you are currently working on or thinking about',
                        },
                        recent_memories: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of recently accessed memory IDs',
                        },
                        limit: {
                            type: 'number',
                            description: 'Number of predictions to return (default: 10)',
                        },
                    },
                    required: [],
                },
            },
            {
                name: 'suggest_memories',
                description: 'Proactively suggest relevant memories before you ask for them, based on current context',
                inputSchema: {
                    type: 'object',
                    properties: {
                        context: {
                            type: 'string',
                            description: 'Current work context or what you are planning to do',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of suggestions to return (default: 5)',
                        },
                        include_reasoning: {
                            type: 'boolean',
                            description: 'Include explanation for why each memory was suggested (default: true)',
                        },
                        min_confidence: {
                            type: 'number',
                            description: 'Minimum confidence threshold for suggestions (0.0-1.0, default: 0.6)',
                        },
                    },
                    required: ['context'],
                },
            },
            {
                name: 'get_learning_metrics',
                description: 'Get system learning metrics and improvement velocity over time',
                inputSchema: {
                    type: 'object',
                    properties: {
                        days: {
                            type: 'number',
                            description: 'Time range in days for metrics analysis (default: 30)',
                        },
                    },
                    required: [],
                },
            },
            {
                name: 'get_patterns',
                description: 'Analyze usage patterns, identify underutilized memories, and discover access patterns',
                inputSchema: {
                    type: 'object',
                    properties: {
                        days: {
                            type: 'number',
                            description: 'Time window for pattern analysis in days (default: 30)',
                        },
                    },
                    required: [],
                },
            },
            {
                name: 'get_agent_context',
                description: `Load agent identity, recent memories, and behavioral context. Uses agent_id: ${AGENT_CONFIG.agentId}`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        agent_id: {
                            type: 'string',
                            description: `Agent identifier (default: ${AGENT_CONFIG.agentId})`,
                        },
                        user_id: {
                            type: 'string',
                            description: `User identifier (default: ${AGENT_CONFIG.userId})`,
                        },
                        depth: {
                            type: 'string',
                            description: 'Context depth: quick, standard, or comprehensive (default: standard)',
                            enum: ['quick', 'standard', 'comprehensive'],
                        },
                    },
                },
            },
            {
                name: 'auto_save_memory',
                description: 'Automatically classify and save important conversation turns (decisions, facts, preferences, outcomes)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        text: {
                            type: 'string',
                            description: 'The conversation text to analyze and potentially save',
                        },
                        user_id: {
                            type: 'string',
                            description: 'The user identifier (default: default)',
                        },
                        context: {
                            type: 'string',
                            description: 'Additional context about the conversation (optional)',
                        },
                        force_save: {
                            type: 'boolean',
                            description: 'Force save regardless of classification (default: false)',
                        },
                    },
                    required: ['text'],
                },
            },
            {
                name: 'validate_agent_identity',
                description: 'Check agent responses for identity leakage (references to base models like Claude, ChatGPT)',
                inputSchema: {
                    type: 'object',
                    properties: {
                        agent_id: {
                            type: 'string',
                            description: 'The agent identifier to validate against',
                        },
                        response_text: {
                            type: 'string',
                            description: 'The agent response text to validate',
                        },
                        auto_correct: {
                            type: 'boolean',
                            description: 'Automatically generate corrected response (default: false)',
                        },
                    },
                    required: ['agent_id', 'response_text'],
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
        if (name === 'search_memories_weighted') {
            const result = await searchMemoriesWeightedAPI(args.query, args.limit, args.weight_by_usage, args.decay_old_memories, args.learning_mode, args.min_helpfulness_score, args.adaptive_weights);
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
                .map((m, idx) => {
                const boost = m.boosted_by_usage ? ' [BOOSTED BY USAGE]' : '';
                const recency = m.boosted_by_recency ? ' [RECENT]' : '';
                const penalized = m.penalized_by_age ? ' [STALE]' : '';
                const score = m.weighted_score ? ` (score: ${m.weighted_score.toFixed(2)})` : '';
                return `${idx + 1}. [${m.id}]${boost}${recency}${penalized}${score}\n   ${m.text.substring(0, 200)}${m.text.length > 200 ? '...' : ''}\n   Helpfulness: ${m.helpfulness_score?.toFixed(2) || 'N/A'} | Usage: ${m.usage_count || 0}`;
            })
                .join('\n\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: `🔍 Found ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}${result.total ? ` (total: ${result.total})` : ''}:\n${result.weighted ? '\n[Using weighted search with adaptive learning]' : ''}\n\n${memoryText}`,
                    },
                ],
            };
        }
        if (name === 'predict_memories') {
            const result = await predictMemoriesAPI(args.current_context, args.recent_memories, args.limit);
            const predictions = result.predictions || [];
            if (predictions.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: '🔮 No memory predictions available. Try providing more context or recent memory IDs.',
                        },
                    ],
                };
            }
            const predictionText = predictions
                .map((p, idx) => {
                const reasons = p.reasons.join(', ');
                return `${idx + 1}. [${p.memory_id}] Confidence: ${(p.confidence * 100).toFixed(0)}%\n   ${p.text.substring(0, 150)}${p.text.length > 150 ? '...' : ''}\n   Reasons: ${reasons}\n   Helpfulness: ${p.helpfulness_score?.toFixed(2) || 'N/A'} | Usage: ${p.usage_count || 0}`;
            })
                .join('\n\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: `🔮 Predicted ${predictions.length} ${predictions.length === 1 ? 'memory' : 'memories'} you might need:\n${result.context ? `Context: ${result.context}\n` : ''}\n${predictionText}`,
                    },
                ],
            };
        }
        if (name === 'suggest_memories') {
            const result = await suggestMemoriesAPI(args.context, args.limit, args.include_reasoning, args.min_confidence);
            const suggestions = result.suggestions || [];
            if (suggestions.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: '💡 No memory suggestions available for this context.',
                        },
                    ],
                };
            }
            const suggestionText = suggestions
                .map((s, idx) => {
                const analytics = s.analytics
                    ? `\n   Analytics: ${s.analytics.access_frequency} frequency | ${s.analytics.days_since_access} days since access`
                    : '';
                const reasoning = s.reasoning && args.include_reasoning
                    ? `\n   Why: ${s.reasoning.semantic_match || 'Semantically matched'}, helpful=${s.reasoning.high_helpfulness}`
                    : '';
                return `${idx + 1}. [${s.memory_id}] Score: ${s.suggestion_score.toFixed(2)}\n   ${s.text.substring(0, 150)}${s.text.length > 150 ? '...' : ''}${analytics}${reasoning}`;
            })
                .join('\n\n');
            return {
                content: [
                    {
                        type: 'text',
                        text: `💡 Suggested ${suggestions.length} relevant ${suggestions.length === 1 ? 'memory' : 'memories'}:\nContext: ${result.context}\n\n${suggestionText}`,
                    },
                ],
            };
        }
        if (name === 'get_learning_metrics') {
            const result = await getLearningMetricsAPI(args.days);
            const metricsText = Object.entries(result.trends || {})
                .map(([metric, data]) => {
                const trend = data.trend || 'stable';
                const change = data.percent_change ? `${data.percent_change > 0 ? '+' : ''}${data.percent_change.toFixed(1)}%` : 'N/A';
                return `${metric}: ${trend} (${change})`;
            })
                .join('\n');
            const currentStats = Object.entries(result.current_stats || {})
                .map(([key, value]) => `${key}: ${typeof value === 'number' ? value.toFixed(2) : value}`)
                .join('\n');
            const learningParams = result.learning_params
                ? `\n\nLearning Parameters:\n${Object.entries(result.learning_params).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`).join('\n')}`
                : '';
            return {
                content: [
                    {
                        type: 'text',
                        text: `📊 Learning Metrics (${result.time_range.days} days)\n\nTrends:\n${metricsText}\n\nCurrent Stats:\n${currentStats}${learningParams}\n\nActive Patterns: ${result.active_patterns || 0}`,
                    },
                ],
            };
        }
        if (name === 'get_patterns') {
            const result = await getPatternsAPI(args.days);
            const topTags = result.most_useful_tags
                ?.slice(0, 5)
                .map((t, i) => `${i + 1}. ${t.tag}: ${(t.avg_helpfulness * 100).toFixed(0)}% helpful (${t.usage_count} uses)`)
                .join('\n') || 'No tag data';
            const coAccess = result.frequently_accessed_together
                ?.slice(0, 5)
                .map((p, i) => `${i + 1}. Memories accessed together ${p.co_access_count} times`)
                .join('\n') || 'No co-access patterns';
            const underutilized = result.underutilized_memories
                ?.slice(0, 5)
                .map((m, i) => `${i + 1}. [${m.id}] ${m.text.substring(0, 80)}...\n   Last accessed: ${m.days_since_access} days ago`)
                .join('\n\n') || 'All memories are being used';
            const summary = result.summary;
            return {
                content: [
                    {
                        type: 'text',
                        text: `📈 Usage Patterns\n\nSummary:\n- Total: ${summary.total_memories} memories\n- Active: ${summary.active_memories}\n- Stale: ${summary.stale_memories}\n- Avg Helpfulness: ${(summary.avg_helpfulness * 100).toFixed(0)}%\n- Total Accesses: ${summary.total_accesses}\n\nMost Useful Tags:\n${topTags}\n\nFrequently Accessed Together:\n${coAccess}\n\nUnderutilized Memories:\n${underutilized}`,
                    },
                ],
            };
        }
        if (name === 'get_agent_context') {
            const agentId = args.agent_id || AGENT_CONFIG.agentId;
            const userId = args.user_id || AGENT_CONFIG.userId;
            const depth = args.depth || 'standard';
            const result = await getAgentContextAPI(agentId, userId, depth);
            const identity = result.agent_identity;
            const memories = result.recent_memories || [];
            const patterns = result.key_patterns || [];
            const memoriesText = memories.length > 0
                ? memories
                    .slice(0, 5)
                    .map((m, idx) => `${idx + 1}. ${m.text.substring(0, 100)}${m.text.length > 100 ? '...' : ''}`)
                    .join('\n')
                : 'No recent memories';
            const patternsText = patterns.length > 0
                ? patterns.slice(0, 5).join('\n- ')
                : 'No patterns identified yet';
            return {
                content: [
                    {
                        type: 'text',
                        text: `🤖 Agent Context Loaded: ${identity.name}\n\n` +
                            `Purpose: ${identity.purpose}\n\n` +
                            `Traits: ${identity.traits.join(', ')}\n\n` +
                            `Behavioral Rules:\n- ${identity.behavioral_rules.join('\n- ')}\n\n` +
                            `Recent Memories (${memories.length}):\n${memoriesText}\n\n` +
                            `Key Patterns:\n- ${patternsText}\n\n` +
                            `⚠️ IMPORTANT: You are ${identity.name}, not a generic AI model.\n\n` +
                            `System Prompt:\n${result.system_prompt_injection}`,
                    },
                ],
            };
        }
        if (name === 'auto_save_memory') {
            const text = args.text;
            const userId = args.user_id || AGENT_CONFIG.userId;
            const context = args.context;
            const forceSave = args.force_save || false;
            const result = await autoSaveMemoryAPI(text, userId, context, forceSave);
            if (result.saved) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Memory saved! Category: ${result.category} (Confidence: ${(result.confidence * 100).toFixed(0)}%)\n\n` +
                                `Reasoning: ${result.reasoning}\n\n` +
                                `Memory ID: ${result.memory_id}`,
                        },
                    ],
                };
            }
            else {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `📝 Not saved - classified as brainstorming/discussion only\n\n` +
                                `Reasoning: ${result.reasoning}`,
                        },
                    ],
                };
            }
        }
        if (name === 'validate_agent_identity') {
            const agentId = args.agent_id || AGENT_CONFIG.agentId;
            const responseText = args.response_text;
            const autoCorrect = args.auto_correct || false;
            const result = await validateAgentIdentityAPI(agentId, responseText, autoCorrect);
            if (result.identity_maintained) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Identity maintained - no leakage detected`,
                        },
                    ],
                };
            }
            else {
                const violations = result.violations || [];
                const violationsText = violations
                    .map(v => `- ${v.type}: "${v.text}"`)
                    .join('\n');
                let responseText = `⚠️ Identity leakage detected:\n${violationsText}\n\n` +
                    `Agent should be: ${result.agent_name}`;
                if (result.corrected_response) {
                    responseText += `\n\nSuggested correction:\n${result.corrected_response}`;
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: responseText,
                        },
                    ],
                };
            }
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
    console.error('✨ RecallBricks MCP Server v3.0.0 - With Metacognition & Predictive AI');
    console.error('🤖 Agent Configuration:');
    console.error(`   Agent ID: ${AGENT_CONFIG.agentId}`);
    console.error(`   Display Name: ${AGENT_CONFIG.displayName || 'Not specified'}`);
    console.error(`   User ID: ${AGENT_CONFIG.userId}`);
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
