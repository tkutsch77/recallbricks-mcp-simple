# Changelog

All notable changes to RecallBricks MCP Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-01-15

### Added - Production-Grade Features

#### Reliability & Resilience
- **Circuit Breaker Pattern** - Automatically stops requests when service is degraded, with CLOSED/OPEN/HALF_OPEN states
- **Request Deduplication** - Prevents duplicate simultaneous requests using RequestCache
- **Request Timeout Protection** - AbortController-based timeouts (default 30s) prevent hanging requests
- **Retry-After Header Support** - Respects server-provided rate limit timing
- **Enhanced Exponential Backoff** - Now includes jitter to prevent thundering herd problems
- **Better Retry Logic** - Fixed off-by-one error (now correctly does 1 initial + 3 retries = 4 total attempts)

#### Graceful Degradation
- **Memory Cache System** - Caches successful query results for fallback during API outages
- **Cache TTL** - Configurable time-to-live (default 1 hour)
- **Automatic Fallback** - Serves cached data when API is unavailable with warning message

#### Observability & Monitoring
- **Structured Logging** - JSON-formatted metrics for monitoring and alerting
- **Request Metrics** - Tracks URL, method, attempts, duration, success, status codes
- **Health Check System** - Periodic health verification (configurable, default 5 minutes)
- **Circuit Breaker Stats** - Real-time visibility into circuit breaker state and failures
- **Cache Metrics** - Track cache size and usage

#### Developer Experience
- **Full TypeScript Type Safety** - Complete type definitions for Memory, API responses, metrics
- **Custom APIError Class** - Rich error context including status codes, URLs, attempts, original errors
- **Input Validation** - Comprehensive validation for all parameters:
  - Memory text (non-empty, max 10,000 characters)
  - Query strings (non-empty)
  - Limits (1-100 range)
- **Environment-based Configuration** - All settings configurable via environment variables
- **Better Error Messages** - Descriptive errors with HTTP status codes and context

#### New Tools
- **get_health** - New MCP tool to check server health, circuit breaker state, cache size, and configuration

#### Configuration
- Added 11 new environment variables for fine-tuned control:
  - `RECALLBRICKS_MAX_RETRIES` (default: 3)
  - `RECALLBRICKS_BASE_DELAY` (default: 1000ms)
  - `RECALLBRICKS_TIMEOUT` (default: 30000ms)
  - `CIRCUIT_BREAKER_THRESHOLD` (default: 5)
  - `CIRCUIT_BREAKER_TIMEOUT` (default: 60000ms)
  - `CACHE_TTL` (default: 3600000ms)
  - `HEALTH_CHECK_INTERVAL` (default: 300000ms)
  - `MAX_MEMORY_TEXT_LENGTH` (default: 10000)
  - `ENABLE_METRICS` (default: true)
  - `ENABLE_HEALTH_CHECKS` (default: true)

#### Documentation
- Comprehensive README with architecture diagrams, troubleshooting guide
- Environment variable template (`.env.example`)
- Production deployment recommendations
- Detailed API documentation for all tools

### Changed

#### Breaking Changes
- **Version bumped to 2.0.0** - Reflects major architectural improvements
- **Removed axios dependency** - Now uses native Node.js `fetch()` API
- **API responses updated** - More detailed success messages with timestamps and metadata

#### Improvements
- **Better startup validation** - Validates API key length on startup
- **Enhanced logging** - Startup banner shows all configuration settings
- **Tool descriptions** - Updated to mention new features (retry, circuit breaker, caching)
- **Error handling** - All errors now go through APIError class for consistency
- **Response formatting** - More user-friendly output with emojis and structured data

### Fixed
- Off-by-one error in retry logic (was doing 3 attempts instead of 1 initial + 3 retries)
- Missing final response handling (now returns 429/5xx responses instead of throwing)
- Axios-specific error handling replaced with fetch-compatible error handling
- Type safety issues with request arguments

### Removed
- **axios dependency** - Replaced with native fetch
- **11 axios sub-dependencies** - Lighter package footprint

### Security
- API key validation on startup
- Input validation prevents injection attacks
- Request timeout prevents resource exhaustion
- Circuit breaker prevents cascading failures

---

## [1.0.0] - 2024-10-28

### Added
- Initial release
- Basic MCP server implementation
- `create_memory` tool
- `query_memories` tool
- Simple retry logic with exponential backoff
- Basic error handling

### Dependencies
- @modelcontextprotocol/sdk
- axios
- TypeScript

---

## Upgrade Guide: v1.0 → v2.0

### Required Changes
1. Remove any direct axios imports if you forked the code
2. Review and adjust environment variables (see `.env.example`)

### Optional Changes
1. Set custom retry/timeout values via environment variables
2. Enable/disable metrics and health checks as needed
3. Adjust circuit breaker thresholds for your use case

### Testing
After upgrading:
1. Use `get_health` tool to verify server status
2. Test `create_memory` to ensure API connectivity
3. Test `query_memories` to verify caching works
4. Monitor logs for circuit breaker state changes

### Rollback
If issues occur:
1. Restore v1.0 code from git
2. Run `npm install` to restore axios
3. Rebuild with `npm run build`
