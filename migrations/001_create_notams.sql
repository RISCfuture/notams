-- Create NOTAMs table
CREATE TABLE IF NOT EXISTS notams (
    id SERIAL PRIMARY KEY,
    notam_id VARCHAR(255) UNIQUE NOT NULL,
    icao_location VARCHAR(10) NOT NULL,
    effective_start TIMESTAMPTZ NOT NULL,
    effective_end TIMESTAMPTZ,
    schedule TEXT,
    notam_text TEXT NOT NULL,
    q_line JSONB,
    purpose VARCHAR(10),
    scope VARCHAR(10),
    traffic_type VARCHAR(10),
    raw_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_notams_icao_location ON notams(icao_location);
CREATE INDEX IF NOT EXISTS idx_notams_effective_start ON notams(effective_start);
CREATE INDEX IF NOT EXISTS idx_notams_effective_end ON notams(effective_end);
CREATE INDEX IF NOT EXISTS idx_notams_created_at ON notams(created_at);
CREATE INDEX IF NOT EXISTS idx_notams_purpose ON notams(purpose);
CREATE INDEX IF NOT EXISTS idx_notams_scope ON notams(scope);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_notams_updated_at
    BEFORE UPDATE ON notams
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
