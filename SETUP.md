# NOTAM Service Setup Guide

This guide will walk you through setting up the NOTAM ingestion service locally.

## Prerequisites

Make sure you have the following installed:

- **Node.js 22+**: `node --version`
- **PostgreSQL 17+**: `psql --version`
- **1Password CLI** (for JMS credentials): `op --version`

## Step 1: Database Setup

Create the PostgreSQL user and databases:

```bash
# Connect to PostgreSQL as superuser
psql -U postgres

# Run these SQL commands:
CREATE USER notams WITH PASSWORD 'notams';
CREATE DATABASE notams_development OWNER notams;
CREATE DATABASE notams_test OWNER notams;

# Grant necessary permissions
GRANT ALL PRIVILEGES ON DATABASE notams_development TO notams;
GRANT ALL PRIVILEGES ON DATABASE notams_test TO notams;

# Exit psql
\q
```

Verify the databases were created:

```bash
psql -U notams -d notams_development -c "SELECT NOW();"
psql -U notams -d notams_test -c "SELECT NOW();"
```

## Step 2: Install Dependencies

```bash
yarn install
```

## Step 3: Environment Configuration

Create your `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your preferred editor:

```bash
# For development
NODE_ENV=development
PORT=8080

# Database (local PostgreSQL)
DATABASE_URL=postgresql://notams@localhost/notams_development
TEST_DATABASE_URL=postgresql://notams@localhost/notams_test

# JMS Configuration (get from 1Password)
JMS_HOST=swim.faa.gov
JMS_PORT=61614
JMS_USERNAME=<from-1password>
JMS_PASSWORD=<from-1password>
JMS_DESTINATION=/topic/faa.notam.all

# Optional (for production)
SENTRY_DSN=
LOG_LEVEL=info
```

### Get JMS Credentials from 1Password

If you have 1Password CLI configured:

```bash
# View the credentials
op item get "FAA SWIFT" --format json | jq

# Or directly set in .env:
echo "JMS_USERNAME=$(op read 'op://Private/FAA SWIFT/username')" >> .env
echo "JMS_PASSWORD=$(op read 'op://Private/FAA SWIFT/password')" >> .env
```

## Step 4: Build the Project

```bash
yarn build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

## Step 5: Run Database Migrations

```bash
yarn migrate
```

This will:
- Create the `notams` table
- Create the `api_tokens` table
- Insert a default development API token: `dev-token-12345`

## Step 6: Verify Setup

### Check Database

```bash
psql -U notams -d notams_development -c "\dt"
```

You should see:
```
           List of relations
 Schema |    Name     | Type  | Owner
--------+-------------+-------+--------
 public | api_tokens  | table | notams
 public | notams      | table | notams
```

### Check API Token

```bash
psql -U notams -d notams_development -c "SELECT token, name FROM api_tokens;"
```

You should see:
```
      token       |       name
------------------+-------------------
 dev-token-12345  | Development Token
```

## Step 7: Run Tests

Before starting the service, run tests to ensure everything works:

```bash
# Run all tests
yarn test

# Run with coverage
yarn test:coverage

# Watch mode (for development)
yarn test:watch
```

## Step 8: Start the Development Server

```bash
yarn dev
```

The service should start on `http://localhost:8080`.

## Step 9: Test the API

### Health Check

```bash
curl http://localhost:8080/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2025-01-15T12:00:00.000Z",
  "database": "connected"
}
```

### Query NOTAMs (with authentication)

```bash
curl -H "Authorization: Bearer dev-token-12345" \
  http://localhost:8080/api/notams
```

Expected response (initially empty):
```json
{
  "data": [],
  "pagination": {
    "total": 0,
    "limit": 100,
    "offset": 0
  }
}
```

## Step 10: Insert Test Data (Optional)

If you want to test with sample data:

```bash
psql -U notams -d notams_development
```

```sql
INSERT INTO notams (
  notam_id, icao_location, effective_start, effective_end,
  notam_text, purpose, scope, traffic_type
) VALUES (
  'TEST 1/2025',
  'KJFK',
  NOW(),
  NOW() + INTERVAL '7 days',
  'TEST NOTAM - RWY 04L/22R CLSD',
  'N',
  'A',
  'I'
);
```

Now query again:

```bash
curl -H "Authorization: Bearer dev-token-12345" \
  "http://localhost:8080/api/notams?location=KJFK"
```

## Troubleshooting

See [README.md](./README.md#troubleshooting) for detailed troubleshooting guide.

## Next Steps

- Configure JMS credentials from 1Password for real data ingestion (see step 3 above)
- Set up Sentry for error tracking (optional, see [README.md](./README.md#monitoring))
- Deploy to Fly.io (see [README.md](./README.md#deployment-to-flyio))
- Set up monitoring and alerts

## Additional Resources

- [README.md](./README.md) - Full documentation including API usage and deployment
- [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md) - Architecture and technical overview
