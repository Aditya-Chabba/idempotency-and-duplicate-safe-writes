CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (tenant, operation, client key). The UNIQUE constraint is the
-- real duplicate guard: concurrent requests race on INSERT and exactly one wins.
CREATE TABLE idempotency_keys (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  operation        TEXT NOT NULL,
  key              TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash     TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('processing','completed','failed')),
  response_status  INTEGER,
  response_body    JSONB,
  incident_id      UUID REFERENCES incidents(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  CONSTRAINT idempotency_keys_scope_key UNIQUE (tenant_id, operation, key),
  -- a completed record must carry everything needed to replay it
  CONSTRAINT idempotency_keys_completed_has_response CHECK (
    state <> 'completed'
    OR (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

-- Lets a cleanup job find expired rows without scanning the whole table.
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- Durable outbox row. It is written in the same transaction as the incident;
-- a separate worker (not part of this exercise) pages the provider later.
CREATE TABLE paging_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  incident_id  UUID NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);

CREATE INDEX paging_jobs_pending_idx ON paging_jobs (created_at) WHERE status = 'pending';
