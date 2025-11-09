# RecallBricks MCP Server v2.0 - Production Ready

**Enterprise-grade Model Context Protocol (MCP) server for RecallBricks memory management.**

Built with reliability, observability, and user experience as top priorities. Features automatic retries, circuit breakers, request caching, graceful degradation, and comprehensive health monitoring.

---

## Features

### Core Reliability
- **Exponential Backoff with Jitter** - Intelligent retry strategy prevents thundering herd problems
- **Circuit Breaker Pattern** - Automatically stops requests when service is degraded
- **Request Timeout Protection** - Prevents hanging requests (30s default)
- **Retry-After Header Support** - Respects server rate limiting signals
- **Request Deduplication** - Prevents duplicate simultaneous requests

### Graceful Degradation
- **Memory Cache** - Serves cached results when API is unavailable
- **Fallback Mechanisms** - Continues functioning during partial outages
- **Smart Error Recovery** - Automatic healing when service recovers

### Observability
- **Structured Logging** - JSON-formatted metrics for monitoring
- **Health Check System** - Periodic health verification (5min intervals)
- **Request Metrics** - Tracks attempts, duration, success rates
- **Circuit Breaker Stats** - Real-time service health visibility

### Developer Experience
- **Full TypeScript** - Type-safe API responses and errors
- **Input Validation** - Comprehensive parameter validation
- **Rich Error Messages** - Detailed error context with HTTP status codes
- **Environment-based Config** - Easy configuration via env vars

---

## Quick Start

### 1. Installation

```bash
npm install
npm run build
```

### 2. Configuration

Create a `.env` file (see `.env.example`):

```bash
RECALLBRICKS_API_URL=https://your-api-url.com
RECALLBRICKS_API_KEY=your_api_key_here
```

### 3. Run

```bash
node dist/index.js
```

---

## Configuration

All settings can be configured via environment variables:

### API Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RECALLBRICKS_API_URL` | `https://recallbricks-api-clean.onrender.com` | RecallBricks API endpoint (Render) |
| `RECALLBRICKS_API_KEY` | `rbk_secret_2025_x7h2p9` | API authentication key |

### Reliability Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `RECALLBRICKS_MAX_RETRIES` | `3` | Maximum retry attempts per request |
| `RECALLBRICKS_BASE_DELAY` | `1000` | Base delay in ms for exponential backoff |
| `RECALLBRICKS_TIMEOUT` | `30000` | Request timeout in milliseconds |

### Circuit Breaker

| Variable | Default | Description |
|----------|---------|-------------|
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before opening circuit |
| `CIRCUIT_BREAKER_TIMEOUT` | `60000` | Time in ms before trying to close circuit |

### Caching

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_TTL` | `3600000` | Cache time-to-live in ms (1 hour) |

### Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_METRICS` | `true` | Enable structured logging |
| `ENABLE_HEALTH_CHECKS` | `true` | Enable periodic health checks |
| `HEALTH_CHECK_INTERVAL` | `300000` | Health check interval in ms (5 min) |

### Validation

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_MEMORY_TEXT_LENGTH` | `10000` | Maximum characters for memory text |

---

## Available Tools

### 1. `create_memory`

Save a new memory to RecallBricks with automatic retry and circuit breaker protection.

**Parameters:**
- `text` (string, required): Memory content to save (max 10,000 characters)

**Example:**
```json
{
  "text": "Claude Code is an amazing development tool"
}
```

**Response:**
```
✅ Memory saved successfully!

ID: mem_abc123
Created: 2025-01-15T10:30:00Z
Length: 45 characters
```

---

### 2. `query_memories`

Search and retrieve memories with caching and fallback support.

**Parameters:**
- `query` (string, required): Search query
- `limit` (number, optional): Max results (1-100, default: 5)

**Example:**
```json
{
  "query": "development tools",
  "limit": 10
}
```

**Response:**
```
📚 Found 3 memories (total available: 15):

1. [mem_abc123] Claude Code is an amazing development tool
   Created: 2025-01-15T10:30:00Z

2. [mem_def456] VSCode extensions improve productivity...
   Created: 2025-01-14T09:15:00Z
```

---

### 3. `get_health`

Get current health status and metrics of the MCP server.

**Parameters:** None

**Response:**
```json
{
  "status": "healthy",
  "circuitBreaker": {
    "state": "CLOSED",
    "failures": 0,
    "lastFailureTime": 0,
    "successCount": 0
  },
  "cache": {
    "size": 12,
    "ttl": 3600000
  },
  "config": {
    "maxRetries": 3,
    "requestTimeout": 30000,
    "apiUrl": "https://..."
  }
}
```

---

## Architecture

### Request Flow

```
User Request
    ↓
Input Validation
    ↓
Circuit Breaker Check
    ↓
Request Deduplication
    ↓
Fetch with Retry (exponential backoff + jitter)
    ↓
Response Caching
    ↓
Success / Fallback to Cache
```

### Circuit Breaker States

1. **CLOSED** (Normal)
   - All requests pass through
   - Failures are tracked

2. **OPEN** (Service Down)
   - Requests fail immediately
   - No API calls made
   - After timeout, transitions to HALF_OPEN

3. **HALF_OPEN** (Testing Recovery)
   - Limited requests allowed
   - If 2 succeed → CLOSED
   - If any fails → OPEN

### Error Handling

All errors include:
- HTTP status codes
- Descriptive messages
- Request context (URL, attempts)
- Original error details

Example error:
```
❌ Error: Failed to create memory: Service unavailable (HTTP 503)
```

---

## Metrics & Logging

All logs are JSON-formatted for easy parsing:

### Request Metrics
```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "type": "http_request",
  "url": "https://api.com/memories",
  "method": "POST",
  "attempts": 2,
  "totalDuration": 1523,
  "success": true,
  "statusCode": 200
}
```

### Health Checks
```json
{
  "timestamp": "2025-01-15T10:35:00.000Z",
  "type": "health_check",
  "healthy": true,
  "statusCode": 200,
  "circuitBreaker": {
    "state": "CLOSED",
    "failures": 0
  }
}
```

### Cached Requests
```json
{
  "url": "...",
  "cached": true,
  "success": true
}
```

---

## Production Deployment

### Recommended Settings

**High-traffic production:**
```bash
RECALLBRICKS_MAX_RETRIES=5
CIRCUIT_BREAKER_THRESHOLD=10
CACHE_TTL=7200000  # 2 hours
ENABLE_METRICS=true
```

**Low-latency requirements:**
```bash
RECALLBRICKS_TIMEOUT=10000  # 10 seconds
RECALLBRICKS_BASE_DELAY=500
RECALLBRICKS_MAX_RETRIES=2
```

**Development:**
```bash
ENABLE_METRICS=false
ENABLE_HEALTH_CHECKS=false
RECALLBRICKS_MAX_RETRIES=1
```

### Monitoring

Monitor these metrics:
- Circuit breaker state transitions
- Request success rate
- Average retry attempts
- Cache hit rate
- Response times

### Alerting

Set up alerts for:
- Circuit breaker OPEN state
- High retry rates (>50% requests)
- Elevated error rates
- Cache misses during outages

---

## Troubleshooting

### Circuit Breaker Stuck OPEN

**Symptom:** All requests fail with "Circuit breaker is OPEN"

**Solution:**
1. Check API health: `get_health` tool
2. Verify API_URL and API_KEY
3. Wait for circuit breaker timeout (default 60s)
4. Check logs for underlying API errors

### Timeout Errors

**Symptom:** "Request timeout after 30000ms"

**Solution:**
1. Increase timeout: `RECALLBRICKS_TIMEOUT=60000`
2. Check network connectivity
3. Verify API performance

### Cache Not Working

**Symptom:** No fallback during API outage

**Solution:**
1. Ensure queries are identical (cache key based on URL)
2. Check cache TTL hasn't expired
3. Verify at least one successful request was cached

### High Memory Usage

**Symptom:** Server memory grows over time

**Solution:**
1. Reduce cache TTL
2. Limit concurrent requests
3. Monitor cache size with `get_health`

---

## Development

### Building
```bash
npm run build
```

### Watch Mode
```bash
npm run watch
```

### Testing Locally
```bash
# Terminal 1
npm run build && node dist/index.js

# Terminal 2
# Use with Claude Desktop or MCP client
```

---

## Changelog

### v2.0.0 - Production Ready
- Added circuit breaker pattern
- Implemented request deduplication
- Added graceful degradation with caching
- Enhanced retry logic with Retry-After support
- Added comprehensive input validation
- Implemented structured metrics logging
- Added health check system
- Full TypeScript type safety
- Request timeout protection
- Better error messages with context
- Environment-based configuration

### v1.0.0 - Initial Release
- Basic retry logic
- Simple axios integration

---

## License

MIT

---

## Support

For issues, feature requests, or questions:
- GitHub Issues: [your-repo/issues]
- Documentation: This README
- Health Check: Use `get_health` tool

---

**Built with ❤️ for reliability and user experience.**
