# API Usage Guide

This document provides comprehensive documentation for the NOTAM Service JSON API.

## Base URL

- **Local Development**: `http://localhost:8080`
- **Production**: `https://notams.fly.dev` (or your deployed URL)

## Authentication

All API endpoints except `/health` require bearer token authentication.

### Adding the Authorization Header

Include your API token in the `Authorization` header:

```bash
Authorization: Bearer your-api-token-here
```

### Development Token

In development, a default token is available:

```bash
Authorization: Bearer dev-token-12345
```

### Managing API Tokens

See [README.md](./README.md#managing-api-tokens) for information on creating and managing production API tokens.

## Endpoints

### Health Check

Check the service health status.

**Endpoint:** `GET /health`

**Authentication:** None required

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "database": "connected"
}
```

**Example:**
```bash
curl http://localhost:8080/health
```

**Response Codes:**
- `200` - Service is healthy
- `503` - Service is unhealthy (database disconnected)

---

### Query NOTAMs

Retrieve NOTAMs with optional filtering and pagination.

**Endpoint:** `GET /api/notams`

**Authentication:** Required

#### Query Parameters

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `location` | string | No | ICAO location code (4 characters) | `KJFK` |
| `start` | ISO 8601 date | No | Filter NOTAMs effective on or after this date | `2025-01-15T00:00:00Z` |
| `end` | ISO 8601 date | No | Filter NOTAMs effective on or before this date | `2025-01-20T23:59:59Z` |
| `purpose` | string | No | NOTAM purpose code (single character) | `N`, `B`, `O`, `M`, `K` |
| `scope` | string | No | NOTAM scope (single character) | `A`, `E`, `W` |
| `limit` | integer | No | Number of results per page (max: 100) | `50` |
| `offset` | integer | No | Number of results to skip for pagination | `0` |

#### Response Format

```json
{
  "data": [
    {
      "id": 1,
      "notam_id": "FDC 2/1234",
      "icao_location": "KJFK",
      "effective_start": "2025-01-15T14:00:00.000Z",
      "effective_end": "2025-01-20T23:59:00.000Z",
      "schedule": "0800-1800",
      "notam_text": "RWY 04L/22R CLSD",
      "q_line": {
        "purpose": "N",
        "scope": "A",
        "traffic_type": "I",
        "lower_altitude": "000",
        "upper_altitude": "999",
        "coordinates": "4040N07346W005"
      },
      "purpose": "N",
      "scope": "A",
      "traffic_type": "I",
      "created_at": "2025-01-15T12:00:00.000Z",
      "updated_at": "2025-01-15T12:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 42,
    "limit": 100,
    "offset": 0
  }
}
```

#### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Database primary key |
| `notam_id` | string | Official NOTAM identifier (e.g., "FDC 2/1234") |
| `icao_location` | string | ICAO airport/location code |
| `effective_start` | ISO 8601 | When the NOTAM becomes effective (UTC) |
| `effective_end` | ISO 8601 or null | When the NOTAM expires (null for permanent NOTAMs) |
| `schedule` | string or null | D-field: Daily schedule if applicable (e.g., "0800-1800") |
| `notam_text` | string | E-field: Human-readable NOTAM description |
| `q_line` | object or null | Structured Q-line data (may be null for text NOTAMs) |
| `purpose` | string or null | NOTAM purpose code |
| `scope` | string or null | NOTAM scope code |
| `traffic_type` | string or null | Traffic type code |
| `created_at` | ISO 8601 | When the record was created in the database |
| `updated_at` | ISO 8601 | When the record was last updated |

#### Purpose Codes

- `N` - Immediate attention (NOTAM)
- `B` - PIB entry (pre-flight information bulletin)
- `O` - Flight operations
- `M` - Miscellaneous
- `K` - Checklist

#### Scope Codes

- `A` - Aerodrome
- `E` - En-route
- `W` - Navigation warning

#### Examples

**Get all NOTAMs for JFK airport:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?location=KJFK"
```

**Get NOTAMs effective during a specific time range:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?start=2025-01-15T00:00:00Z&end=2025-01-20T23:59:59Z"
```

**Get NOTAMs for JFK effective in January 2025:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?location=KJFK&start=2025-01-01T00:00:00Z&end=2025-01-31T23:59:59Z"
```

**Get only aerodrome NOTAMs with immediate attention:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?purpose=N&scope=A"
```

**Pagination - get second page of 50 results:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?limit=50&offset=50"
```

**Response Codes:**
- `200` - Success
- `400` - Invalid query parameters (e.g., malformed date)
- `401` - Missing or invalid authentication token

---

### Get Single NOTAM

Retrieve a specific NOTAM by its ID.

**Endpoint:** `GET /api/notams/:notam_id`

**Authentication:** Required

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `notam_id` | string | Yes | The NOTAM identifier (URL-encoded) |

#### Response Format

```json
{
  "data": {
    "id": 1,
    "notam_id": "FDC 2/1234",
    "icao_location": "KJFK",
    "effective_start": "2025-01-15T14:00:00.000Z",
    "effective_end": "2025-01-20T23:59:00.000Z",
    "schedule": null,
    "notam_text": "RWY 04L/22R CLSD",
    "q_line": {
      "purpose": "N",
      "scope": "A",
      "traffic_type": "I"
    },
    "purpose": "N",
    "scope": "A",
    "traffic_type": "I",
    "raw_message": "<AIXMBasicMessage>...</AIXMBasicMessage>",
    "created_at": "2025-01-15T12:00:00.000Z",
    "updated_at": "2025-01-15T12:00:00.000Z"
  }
}
```

**Note:** This endpoint includes the `raw_message` field containing the original AIXM XML or text NOTAM.

#### Examples

**Get a specific NOTAM (URL encoding required for spaces/slashes):**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams/FDC%202%2F1234"
```

**Using JavaScript to encode the ID:**
```javascript
const notamId = 'FDC 2/1234';
const encodedId = encodeURIComponent(notamId);
const url = `http://localhost:8080/api/notams/${encodedId}`;

fetch(url, {
  headers: {
    'Authorization': 'Bearer dev-token-12345'
  }
})
  .then(res => res.json())
  .then(data => console.log(data));
```

**Response Codes:**
- `200` - NOTAM found
- `401` - Missing or invalid authentication token
- `404` - NOTAM not found

---

## Error Responses

All endpoints return consistent error responses:

```json
{
  "error": {
    "message": "Description of the error",
    "code": "ERROR_CODE"
  }
}
```

### Common Error Codes

| Status Code | Error Code | Description |
|-------------|------------|-------------|
| `400` | `INVALID_PARAMETERS` | Query parameters are invalid or malformed |
| `401` | `UNAUTHORIZED` | Missing or invalid authentication token |
| `404` | `NOT_FOUND` | Resource not found |
| `500` | `INTERNAL_ERROR` | Server error (logged to Sentry) |
| `503` | `SERVICE_UNAVAILABLE` | Service is unhealthy (database down) |

### Example Error Response

```bash
curl -H "Authorization: Bearer invalid-token" \
  "http://localhost:8080/api/notams"
```

Response:
```json
{
  "error": {
    "message": "Invalid or inactive API token",
    "code": "UNAUTHORIZED"
  }
}
```

---

## Rate Limiting

Currently, there are no rate limits enforced. This may change in future versions.

---

## CORS

Cross-Origin Resource Sharing (CORS) is not currently enabled. If you need CORS support for browser-based clients, please contact the API administrator.

---

## Client Examples

### cURL

**Basic query:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?location=KJFK&limit=10"
```

**Pretty-print JSON response:**
```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?location=KJFK" | jq
```

### JavaScript (Fetch API)

```javascript
const API_BASE = 'http://localhost:8080';
const API_TOKEN = 'dev-token-12345';

async function getNotams(filters = {}) {
  const params = new URLSearchParams(filters);
  const url = `${API_BASE}/api/notams?${params}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

// Usage
getNotams({ location: 'KJFK', limit: 10 })
  .then(result => {
    console.log(`Found ${result.pagination.total} NOTAMs`);
    console.log(result.data);
  })
  .catch(err => console.error(err));
```

### Python (requests)

```python
import requests
from datetime import datetime, timezone

API_BASE = 'http://localhost:8080'
API_TOKEN = 'dev-token-12345'

def get_notams(location=None, start=None, end=None, limit=100, offset=0):
    """Query NOTAMs with optional filters."""
    url = f'{API_BASE}/api/notams'
    headers = {'Authorization': f'Bearer {API_TOKEN}'}
    params = {
        'limit': limit,
        'offset': offset
    }

    if location:
        params['location'] = location
    if start:
        params['start'] = start.isoformat()
    if end:
        params['end'] = end.isoformat()

    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    return response.json()

# Usage
result = get_notams(
    location='KJFK',
    start=datetime(2025, 1, 15, tzinfo=timezone.utc),
    limit=10
)

print(f"Found {result['pagination']['total']} NOTAMs")
for notam in result['data']:
    print(f"{notam['notam_id']}: {notam['notam_text']}")
```

### Go

```go
package main

import (
    "encoding/json"
    "fmt"
    "net/http"
    "net/url"
)

const (
    APIBase  = "http://localhost:8080"
    APIToken = "dev-token-12345"
)

type NotamResponse struct {
    Data       []Notam    `json:"data"`
    Pagination Pagination `json:"pagination"`
}

type Notam struct {
    ID             int     `json:"id"`
    NotamID        string  `json:"notam_id"`
    ICAOLocation   string  `json:"icao_location"`
    EffectiveStart string  `json:"effective_start"`
    EffectiveEnd   *string `json:"effective_end"`
    NotamText      string  `json:"notam_text"`
    Purpose        *string `json:"purpose"`
    Scope          *string `json:"scope"`
}

type Pagination struct {
    Total  int `json:"total"`
    Limit  int `json:"limit"`
    Offset int `json:"offset"`
}

func getNotams(location string, limit int) (*NotamResponse, error) {
    params := url.Values{}
    if location != "" {
        params.Add("location", location)
    }
    params.Add("limit", fmt.Sprintf("%d", limit))

    url := fmt.Sprintf("%s/api/notams?%s", APIBase, params.Encode())

    req, err := http.NewRequest("GET", url, nil)
    if err != nil {
        return nil, err
    }

    req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", APIToken))

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
    }

    var result NotamResponse
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, err
    }

    return &result, nil
}

func main() {
    result, err := getNotams("KJFK", 10)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Found %d NOTAMs\n", result.Pagination.Total)
    for _, notam := range result.Data {
        fmt.Printf("%s: %s\n", notam.NotamID, notam.NotamText)
    }
}
```

---

## Additional Resources

- [SETUP.md](./SETUP.md) - Local development setup
- [README.md](./README.md) - Full project documentation
- [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) - Architecture overview
- [ICAO NOTAM Format](https://www.icao.int/safety/information-management/Pages/NOTAM.aspx) - Official NOTAM specification
