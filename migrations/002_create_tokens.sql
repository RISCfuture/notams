-- Create API tokens table
CREATE TABLE IF NOT EXISTS api_tokens (
    id SERIAL PRIMARY KEY,
    token VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE
);

-- Create index on token for fast lookups
CREATE INDEX IF NOT EXISTS idx_api_tokens_token ON api_tokens(token) WHERE is_active = TRUE;

-- Insert a default test token for development
INSERT INTO api_tokens (token, name, is_active)
VALUES ('dev-token-12345', 'Development Token', TRUE)
ON CONFLICT (token) DO NOTHING;
