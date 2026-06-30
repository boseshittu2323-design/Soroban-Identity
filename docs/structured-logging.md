# Structured Logging

## Overview

The Soroban Identity server uses structured JSON logging via [pino](https://getpino.io/) for all log output. This enables efficient log aggregation, filtering, and alerting in tools like Datadog, CloudWatch, Splunk, and ELK stack.

## Log Format

All logs are emitted as single-line JSON objects with the following standard fields:

```json
{
  "level": "info",
  "time": "2024-01-15T10:30:45.123Z",
  "msg": "Soroban Identity server listening",
  "port": 3001
}
```

### Standard Fields

- **`level`** - Log level (trace, debug, info, warn, error, fatal)
- **`time`** - ISO 8601 timestamp
- **`msg`** - Human-readable message
- **`requestId`** - Request ID (included in all request-scoped logs)

### Context Fields

Additional context is included as structured fields:

```json
{
  "level": "warn",
  "time": "2024-01-15T10:31:12.456Z",
  "requestId": "abc-123-def",
  "attempt": 2,
  "maxRetries": 3,
  "method": "get_issuers",
  "delayMs": 1000,
  "error": "Connection timeout",
  "msg": "Retrying Soroban RPC call"
}
```

## Configuration

### LOG_LEVEL Environment Variable

Control log verbosity with the `LOG_LEVEL` environment variable:

```bash
LOG_LEVEL=info npm start
```

Available levels (from most to least verbose):
- **`trace`** - Extremely detailed tracing information
- **`debug`** - Detailed debugging information
- **`info`** - General informational messages (default)
- **`warn`** - Warning messages
- **`error`** - Error messages
- **`fatal`** - Fatal errors that cause the application to exit

Default: `info`

### Examples

```bash
# Development: Show all logs including debug
LOG_LEVEL=debug npm start

# Production: Only warnings and errors
LOG_LEVEL=warn npm start

# Troubleshooting: Maximum verbosity
LOG_LEVEL=trace npm start
```

## Request Context

All logs within a request handler automatically include the `requestId` from the `X-Request-ID` header:

```json
{
  "level": "info",
  "time": "2024-01-15T10:32:00.789Z",
  "requestId": "req-xyz-789",
  "msg": "Processing credential verification"
}
```

This allows you to trace all logs related to a specific request.

## Log Aggregation

### Datadog

Filter logs by request:
```
@requestId:req-xyz-789
```

Filter errors:
```
@level:error
```

Filter by custom fields:
```
@method:get_issuers @attempt:>1
```

### CloudWatch Insights

Query logs by request:
```
fields @timestamp, msg, requestId, level
| filter requestId = "req-xyz-789"
| sort @timestamp desc
```

Count errors by method:
```
fields @timestamp, method
| filter level = "error"
| stats count() by method
```

### ELK Stack (Elasticsearch)

Search logs:
```json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "requestId": "req-xyz-789" } },
        { "match": { "level": "error" } }
      ]
    }
  }
}
```

### Splunk

Search by request:
```
requestId="req-xyz-789"
```

Count errors:
```
level="error" | stats count by method
```

## Common Log Patterns

### Server Startup

```json
{
  "level": "info",
  "time": "2024-01-15T10:30:45.123Z",
  "port": 3001,
  "msg": "Soroban Identity server listening"
}
```

### Request Processing

```json
{
  "level": "info",
  "time": "2024-01-15T10:31:00.456Z",
  "requestId": "abc-123-def",
  "msg": "Processing request"
}
```

### RPC Retry

```json
{
  "level": "warn",
  "time": "2024-01-15T10:31:12.789Z",
  "requestId": "abc-123-def",
  "attempt": 2,
  "maxRetries": 3,
  "method": "get_issuers",
  "delayMs": 1000,
  "error": "Connection timeout",
  "msg": "Retrying Soroban RPC call"
}
```

### Errors

```json
{
  "level": "error",
  "time": "2024-01-15T10:32:00.012Z",
  "requestId": "abc-123-def",
  "error": "Contract execution failed",
  "stack": "Error: Contract execution failed\n    at ...",
  "msg": "Soroban error occurred"
}
```

### Circuit Breaker State Change

```json
{
  "level": "info",
  "time": "2024-01-15T10:33:00.345Z",
  "from": "CLOSED",
  "to": "OPEN",
  "failures": 5,
  "msg": "Circuit breaker state transition"
}
```

### Graceful Shutdown

```json
{
  "level": "info",
  "time": "2024-01-15T10:34:00.678Z",
  "signal": "SIGTERM",
  "msg": "Shutting down"
}
```

## Alerting Examples

### Datadog Monitor

Alert on high error rate:
```
sum(last_5m):sum:logs.count{level:error}.as_count() > 10
```

Alert on circuit breaker opening:
```
logs("msg:\"Circuit breaker state transition\" to:OPEN")
```

### CloudWatch Alarm

Alert on errors:
```
MetricFilter: level = "error"
Alarm: Sum >= 5 for 1 evaluation period
```

### Prometheus/Loki

Query error rate:
```
rate({job="soroban-identity"} |= "level\":\"error\"" [5m])
```

## Best Practices

1. **Always include context fields** - Add relevant data as structured fields, not in the message string
2. **Use consistent field names** - Stick to camelCase for field names
3. **Include requestId** - Use the request context store for automatic inclusion
4. **Log errors with stack traces** - Include both `error` (message) and `stack` fields
5. **Use appropriate log levels** - Reserve `error` for actual errors, use `warn` for warnings
6. **Avoid logging sensitive data** - Don't log API keys, passwords, or PII
7. **Keep messages concise** - Use fields for details, keep `msg` brief and searchable

## Migration from console.log

Old (unstructured):
```javascript
console.log(`[soroban] retry ${attempt}/${maxRetries} for ${method}`);
```

New (structured):
```javascript
logger.warn({ 
  attempt, 
  maxRetries, 
  method,
  error: error.message 
}, 'Retrying Soroban RPC call');
```

Benefits:
- Filterable by any field
- No string parsing required
- Automatic timestamp formatting
- Request context included
- Machine-readable format
