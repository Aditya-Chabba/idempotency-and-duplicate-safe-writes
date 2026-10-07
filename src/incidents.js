const crypto = require('crypto');
const { db } = require('./db');

/**
 * Canonical JSON: object keys are sorted at every depth, array order is kept,
 * and no whitespace is added. Two payloads with the same contents therefore
 * serialize to the same string no matter how the client ordered its keys.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(v => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 (hex) of the canonical form of the request payload. */
function hashRequest(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

const OPERATION = 'POST:/incidents';
const KEY_MAX_LENGTH = 255;
const SEVERITIES = ['P1', 'P2', 'P3', 'P4'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claim the (tenant, operation, key) slot. Exactly one concurrent caller gets a
// row back. The DO UPDATE branch only fires for an EXPIRED record, which lets a
// key be reused after the 24-hour window without a separate cleanup step.
const CLAIM_SQL = `
  INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
  VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
  ON CONFLICT (tenant_id, operation, key) DO UPDATE
    SET request_hash    = EXCLUDED.request_hash,
        state           = 'processing',
        response_status = NULL,
        response_body   = NULL,
        incident_id     = NULL,
        created_at      = now(),
        completed_at    = NULL,
        expires_at      = EXCLUDED.expires_at
    WHERE idempotency_keys.expires_at <= now()
  RETURNING id`;

function validKey(key) {
  return typeof key === 'string' && key.trim().length > 0 && key.length <= KEY_MAX_LENGTH;
}

// Only the business fields are hashed and stored, so unknown extra properties
// can neither change the hash nor reach the database.
function validatePayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const problems = [];
  if (typeof b.title !== 'string' || b.title.trim() === '') problems.push('title must be a non-empty string');
  if (!SEVERITIES.includes(b.severity)) problems.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (typeof b.serviceId !== 'string' || !UUID_RE.test(b.serviceId)) problems.push('serviceId must be a UUID');
  if (problems.length) return { problems };
  return { payload: { title: b.title, severity: b.severity, serviceId: b.serviceId } };
}

/**
 * POST /incidents, safe to retry.
 *
 * One database transaction claims the key, creates the incident and its paging
 * job, and stores the response. If anything fails, everything rolls back, so the
 * client can retry with the same key and nothing half-finished is left behind.
 * No external call (queue, pager provider) happens inside the transaction; a
 * worker reads paging_jobs afterwards.
 */
async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!validKey(key)) {
    return res.status(400).json({
      error: 'idempotency_key_required',
      message: `Send an Idempotency-Key header of 1-${KEY_MAX_LENGTH} characters, unique per logical incident.`,
    });
  }

  const { payload, problems } = validatePayload(req.body);
  if (problems) return res.status(400).json({ error: 'validation_error', details: problems });

  const tenantId = req.user.tenantId; // from authentication, never from the body
  const requestHash = hashRequest(payload);

  // A few attempts only matter if an expired record is deleted between our
  // failed claim and our read of it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await db.tx(async t => {
      const claimed = await t.oneOrNone(CLAIM_SQL, [tenantId, OPERATION, key, requestHash]);

      if (claimed) {
        const incident = await t.one(
          `INSERT INTO incidents (tenant_id, service_id, title, severity)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [tenantId, payload.serviceId, payload.title, payload.severity]
        );
        await t.none(
          `INSERT INTO paging_jobs (tenant_id, incident_id) VALUES ($1, $2)`,
          [tenantId, incident.id]
        );
        const done = await t.one(
          `UPDATE idempotency_keys
              SET state = 'completed', response_status = 201, response_body = $2::jsonb,
                  incident_id = $3, completed_at = now()
            WHERE id = $1
        RETURNING response_status, response_body`,
          [claimed.id, JSON.stringify(incident), incident.id]
        );
        return { kind: 'created', status: done.response_status, body: done.response_body };
      }

      const existing = await t.oneOrNone(
        `SELECT request_hash, state, response_status, response_body
           FROM idempotency_keys
          WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, OPERATION, key]
      );
      return existing ? { kind: 'existing', existing } : { kind: 'gone' };
    });

    if (outcome.kind === 'gone') continue;

    if (outcome.kind === 'created') return res.status(outcome.status).json(outcome.body);

    const { existing } = outcome;
    if (existing.request_hash !== requestHash) {
      return res.status(409).json({
        error: 'idempotency_key_conflict',
        message: 'This Idempotency-Key was already used with a different request body.',
      });
    }
    if (existing.state === 'completed') {
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.response_status).json(existing.response_body);
    }
    if (existing.state === 'processing') {
      res.set('Retry-After', '1');
      return res.status(409).json({
        error: 'operation_in_progress',
        message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
      });
    }
    return res.status(409).json({
      error: 'prior_operation_failed',
      message: 'A request with this Idempotency-Key failed earlier. Retry with a new key.',
    });
  }

  return res.status(503).json({ error: 'try_again', message: 'Could not settle the request; retry.' });
}

module.exports = { createIncident, hashRequest };