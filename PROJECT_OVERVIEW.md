# NOTAM Service - Project Overview

## What Is This?

A production-ready TypeScript Express.js service that:

- **Ingests** NOTAMs from the FAA NMS (NOTAM Management System) REST API
- **Stores** them in PostgreSQL with efficient indexing
- **Serves** them via a RESTful HTTP JSON API with bearer token authentication
- **Prunes** expired NOTAMs on a schedule

## Key Features

✅ **Always-On Service**: Designed for Fly.io with no auto-stop for continuous NMS polling
✅ **Type-Safe**: Full TypeScript with strict mode enabled
✅ **Well-Tested**: Comprehensive unit and integration tests (Vitest + Supertest)
✅ **Production-Ready**: Error tracking (Sentry), structured logging (Pino), health checks
✅ **Small & Efficient**: Multi-stage Docker build, optimized for small memory footprint
✅ **Code Quality**: ESLint + Prettier configured and working

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   FAA NMS (REST API)                    │
│           HTTPS + OAuth2 client_credentials             │
└────────────────────────┬────────────────────────────────┘
                         │
                         │ Credentials from 1Password
                         │ ("FAA NMS API" item)
                         ▼
┌─────────────────────────────────────────────────────────┐
│              NMS Ingestion Service                      │
│  - HTTP polling via native fetch                        │
│  - Parses GeoJSON NOTAMs                                │
│  - Upserts to PostgreSQL                                │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  PostgreSQL Database                    │
│  Tables: notams, api_tokens                             │
│  Indexes: location, dates, purpose, scope               │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    HTTP JSON API                        │
│  - Express.js server                                    │
│  - Bearer token auth (database-stored)                  │
│  - Query endpoints with filters                         │
│  - Health check for monitoring                          │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                API Consumers (Clients)                  │
│  Query NOTAMs by location, date, type, etc.             │
└─────────────────────────────────────────────────────────┘

Scheduled Job:
┌─────────────────────────────────────────────────────────┐
│           Pruning Script (Fly.io Cron)                  │
│  Runs daily at 2 AM UTC to delete NOTAMs                │
│  expired > 30 days ago                                  │
└─────────────────────────────────────────────────────────┘
```

## Technology Stack

| Layer              | Technology         | Purpose                     |
| ------------------ | ------------------ | --------------------------- |
| **Language**       | TypeScript 5.3     | Type safety, better DX      |
| **Runtime**        | Node.js 24         | JavaScript runtime          |
| **Framework**      | Express.js 4       | HTTP server                 |
| **Database**       | PostgreSQL 17      | Relational data storage     |
| **HTTP Client**    | Native fetch       | NMS REST API polling        |
| **Validation**     | zod                | Runtime type validation     |
| **Logging**        | pino + pino-pretty | Structured JSON logs        |
| **Error Tracking** | Sentry             | Production error monitoring |
| **Testing**        | Vitest + Supertest | Unit & integration tests    |
| **Code Quality**   | ESLint + Prettier  | Linting and formatting      |
| **Deployment**     | Fly.io + Docker    | Container orchestration     |

## Project Structure

```
notams/
├── src/
│   ├── config/           # Configuration modules
│   │   ├── database.ts   # PostgreSQL connection pool
│   │   ├── nms.ts        # NMS API configuration
│   │   └── logger.ts     # Pino logger setup
│   │
│   ├── middleware/       # Express middleware
│   │   ├── auth.ts       # Bearer token authentication
│   │   └── error-handler.ts  # Global error handling
│   │
│   ├── models/           # Data models & DB queries
│   │   └── notam.ts      # NOTAM model with CRUD operations
│   │
│   ├── routes/           # API route handlers
│   │   ├── health.ts     # Health check endpoint
│   │   └── notams.ts     # NOTAM query endpoints
│   │
│   ├── services/         # Business logic
│   │   ├── notam-ingestion.ts  # NMS API polling service
│   │   └── notam-parser.ts     # GeoJSON NOTAM parser
│   │
│   ├── scripts/          # Standalone scripts
│   │   ├── migrate.ts    # Database migrations
│   │   └── prune-notams.ts    # Pruning job
│   │
│   ├── index.ts          # Main entry point
│   └── server.ts         # Express app setup
│
├── tests/
│   ├── fixtures/         # Test data
│   │   ├── sample-notams.json
│   │   └── nms-geojson-response.json
│   │
│   ├── integration/      # Integration tests
│   │   ├── nms-ingestion.test.ts
│   │   ├── notam-api.test.ts
│   │   └── prune-notams.test.ts
│   │
│   ├── unit/             # Unit tests
│   │   ├── auth.test.ts
│   │   ├── notam-parser.test.ts
│   │   └── models/notam.test.ts
│   │
│   └── setup.ts          # Test setup & teardown
│
├── migrations/           # SQL migration files
│   ├── 001_create_notams.sql
│   └── 002_create_tokens.sql
│
├── Dockerfile            # Multi-stage Docker build
├── fly.toml              # Fly.io deployment config
├── package.json          # Dependencies & scripts
├── tsconfig.json         # TypeScript config
├── vitest.config.ts      # Vitest test config
├── .eslintrc.json        # ESLint rules
├── .prettierrc.json      # Prettier formatting
├── .nvmrc                # Node version (24)
├── .env.example          # Environment template
├── README.md             # Full documentation
├── SETUP.md              # Detailed setup guide
├── API_USAGE.md          # API documentation
└── PROJECT_OVERVIEW.md   # This file
```

## Database Schema

### `notams` Table

```sql
- id (SERIAL PRIMARY KEY)
- notam_id (VARCHAR UNIQUE) -- e.g., "FDC 2/1234"
- icao_location (VARCHAR)    -- e.g., "KJFK"
- effective_start (TIMESTAMPTZ)
- effective_end (TIMESTAMPTZ)
- schedule (TEXT)            -- D field (optional)
- notam_text (TEXT)          -- E field
- q_line (JSONB)             -- Q-line parsed data
- purpose (VARCHAR)          -- N, B, O, M, K
- scope (VARCHAR)            -- A, E, W
- traffic_type (VARCHAR)     -- I, V, etc.
- raw_message (TEXT)         -- Original GeoJSON
- created_at (TIMESTAMPTZ)
- updated_at (TIMESTAMPTZ)

Indexes: icao_location, effective_start, effective_end, created_at, purpose, scope
```

### `api_tokens` Table

```sql
- id (SERIAL PRIMARY KEY)
- token (VARCHAR UNIQUE)
- name (VARCHAR)
- created_at (TIMESTAMPTZ)
- last_used_at (TIMESTAMPTZ)
- is_active (BOOLEAN)
```

## API Endpoints

See [API_USAGE.md](./API_USAGE.md) for comprehensive API documentation including all endpoints, parameters, response formats, and client examples.

**Summary:**

- `GET /health` - Health check (no auth)
- `GET /api/notams` - Query NOTAMs with filters (auth required)
- `GET /api/notams/:id` - Get single NOTAM (auth required)

## Environment Variables

See [SETUP.md](./SETUP.md#step-3-environment-configuration) for detailed environment configuration including how to get NMS credentials from 1Password.

## Yarn Scripts

See [README.md](./README.md#scripts) for the complete list of available yarn scripts.

## Development Workflow

1. **Make changes** to TypeScript files in `src/`
2. **Format code**: `yarn format`
3. **Lint code**: `yarn lint:fix`
4. **Run tests**: `yarn test`
5. **Test locally**: `yarn dev`
6. **Build**: `yarn build`
7. **Deploy**: `fly deploy`

## Testing Strategy

- **Unit Tests**: Pure functions (parser, utilities)
- **Integration Tests**: API endpoints, database operations, NMS ingestion
- **Test Database**: Isolated `notams_test` database
- **Mock Data**: Sample GeoJSON and JSON fixtures
- **Coverage Target**: >80%

## Security Considerations

- ✅ Bearer tokens stored in database (not hardcoded)
- ✅ NMS credentials from 1Password, stored as env vars
- ✅ Database connection pooling with timeouts
- ✅ Input validation with zod
- ✅ SQL injection protection (parameterized queries)
- ✅ Error details hidden in production
- ✅ HTTPS enforced on Fly.io

## Performance Optimizations

- ✅ Database indexes on common query fields
- ✅ Connection pooling for PostgreSQL
- ✅ Multi-stage Docker build (smaller image)
- ✅ Efficient GeoJSON parsing
- ✅ Upsert logic (ON CONFLICT) for duplicate NOTAMs
- ✅ Resilient polling with exponential backoff on errors

## Deployment Checklist

See [README.md](./README.md#deployment-to-flyio) for complete deployment instructions to Fly.io.

## Getting Help

- **Setup Instructions**: See [SETUP.md](./SETUP.md)
- **Full Documentation**: See [README.md](./README.md)
- **FAA NMS Support**: 7-AWA-NAIMES@faa.gov or 866-466-1336
- **NOTAM Format**: See ICAO Annex 15

## License

MIT
