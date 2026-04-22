# NOTAM Ingestion Service

![CI](https://github.com/RISCfuture/notams/workflows/CI/badge.svg)
![Deploy](https://github.com/RISCfuture/notams/workflows/Deploy/badge.svg)

A TypeScript Express.js service that ingests NOTAMs (Notices to Airmen) from the FAA NMS (NOTAM Management System) REST API and provides an HTTP JSON API for querying NOTAMs.

## Documentation

- **[SETUP.md](./SETUP.md)** - Step-by-step setup guide for local development
- **[API_USAGE.md](./API_USAGE.md)** - Comprehensive API documentation with examples
- **[PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md)** - Architecture, technology stack, and technical overview
- **This README** - Deployment, scripts, and general reference

## Features

- **NMS API Ingestion**: Polls the FAA NMS REST API for NOTAMs via OAuth2-authenticated HTTPS requests
- **PostgreSQL Storage**: Stores NOTAMs with efficient indexing for fast queries
- **HTTP JSON API**: RESTful API with bearer token authentication
- **Automatic Pruning**: Scheduled job to remove expired NOTAMs
- **Structured Logging**: JSON logs with pino
- **Error Tracking**: Sentry integration for error monitoring
- **Health Checks**: Endpoint for monitoring service health
- **TypeScript**: Type-safe codebase with strict mode enabled
- **Comprehensive Tests**: Unit and integration tests with Vitest

## Architecture

```
┌─────────────────┐
│    FAA NMS      │
│   (REST API)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Ingestion     │
│   Service       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌─────────────────┐
│   PostgreSQL    │◄─────┤   HTTP API      │
│   Database      │      │   (Express)     │
└─────────────────┘      └─────────────────┘
```

## Quick Start

For detailed local development setup, see **[SETUP.md](./SETUP.md)**.

**Prerequisites:** Node.js 24+, PostgreSQL 17+, FAA NMS API credentials (from 1Password "FAA NMS API" item)

```bash
# Quick setup
psql -U postgres -c "CREATE USER notams WITH PASSWORD 'notams';"
psql -U postgres -c "CREATE DATABASE notams_development OWNER notams;"
psql -U postgres -c "CREATE DATABASE notams_test OWNER notams;"
yarn install
cp .env.example .env  # Then edit .env with your config
yarn build
yarn migrate
yarn dev
```

The service will start on `http://localhost:8080`.

## API Usage

For comprehensive API documentation including all endpoints, parameters, response formats, and client examples, see **[API_USAGE.md](./API_USAGE.md)**.

**Quick Example:**

```bash
# Health check (no auth required)
curl http://localhost:8080/health

# Query NOTAMs (auth required)
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?location=KJFK&limit=10"
```

## Testing

### Run All Tests

```bash
yarn test
```

### Run Tests with Coverage

```bash
yarn test:coverage
```

### Run Tests in Watch Mode

```bash
yarn test:watch
```

## Scripts

- `yarn build` - Compile TypeScript to JavaScript
- `yarn start` - Start production server
- `yarn dev` - Start development server with ts-node
- `yarn test` - Run tests
- `yarn migrate` - Run database migrations
- `yarn prune` - Manually run NOTAM pruning script

## Deployment to Fly.io

### 1. Install Fly.io CLI

```bash
curl -L https://fly.io/install.sh | sh
```

### 2. Login to Fly.io

```bash
fly auth login
```

### 3. Create Fly.io App

```bash
fly apps create notam-service
```

### 4. Create PostgreSQL Database

```bash
fly postgres create --name notam-db
fly postgres attach notam-db
```

### 5. Set Secrets

Get NMS credentials from 1Password:

```bash
op item get "FAA NMS API" --format json
```

Set secrets:

```bash
fly secrets set \
  NMS_BASE_URL=https://api-nms.aim.faa.gov \
  NMS_CLIENT_ID=$(op read "op://Private/FAA NMS API/client_id") \
  NMS_CLIENT_SECRET=$(op read "op://Private/FAA NMS API/client_secret") \
  NMS_POLL_INTERVAL_MS=300000 \
  SENTRY_DSN=your_sentry_dsn
```

### 6. Deploy

```bash
fly deploy
```

### 7. Run Migrations

```bash
fly ssh console
cd /app
node dist/scripts/migrate.js
exit
```

### 8. Set Up Pruning Cron Job

```bash
fly machines run . \
  --schedule="0 2 * * *" \
  --entrypoint="node" \
  --arg="dist/scripts/prune-notams.js"
```

This runs the pruning script daily at 2 AM UTC.

## Managing API Tokens

API tokens are stored in the `api_tokens` table. To add a new token:

```bash
fly postgres connect -a notam-db
```

```sql
INSERT INTO api_tokens (token, name, is_active)
VALUES ('your-secure-token-here', 'Production API Client', TRUE);
```

## Monitoring

### View Logs

```bash
fly logs
```

### Check Health

```bash
curl https://notam-service.fly.dev/health
```

### Sentry

If `SENTRY_DSN` is configured, errors will be automatically reported to Sentry for monitoring and alerting.

## Troubleshooting

### Database Connection Errors

Check your `DATABASE_URL` is correct and PostgreSQL is running:

```bash
psql $DATABASE_URL -c "SELECT NOW();"
```

### NMS API Connection Errors

Verify NMS credentials are correct:

```bash
op item get "FAA NMS API"
```

Check NMS API endpoint is reachable:

```bash
curl -s -o /dev/null -w "%{http_code}" https://api-nms.aim.faa.gov/nmsapi/v1/notams
```

### Test Failures

Ensure test database is clean:

```bash
psql $TEST_DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
yarn migrate
```

## GitHub Actions CI/CD

**CI Workflow:** Runs tests and linters on every push and pull request.

**Deploy Workflow:** Automatically deploys to Fly.io when CI passes on `main` branch, and creates a Sentry release.

**Required GitHub Secrets:**

- `FLY_API_TOKEN` - Get with `fly tokens create deploy`
- `SENTRY_AUTH_TOKEN` - From Sentry Settings → API → Auth Tokens

## License

MIT
