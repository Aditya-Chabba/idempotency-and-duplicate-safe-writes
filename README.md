# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.




## Design Decisions

### Summary of approach

`POST /incidents` now requires an `Idempotency-Key` header, one key per logical incident. A single `INSERT ... ON CONFLICT` claims the key. The claim, the incident, the paging job and the stored response are written in one database transaction. Retrying with the same key and the same body replays the original response instead of creating a second incident.

| Situation | Response |
|---|---|
| No `Idempotency-Key` (or empty, or over 255 characters) | `400 idempotency_key_required` |
| Invalid body (`title`, `severity`, `serviceId`) | `400 validation_error`; no key is stored |
| New key | `201`; incident and paging job created |
| Same key, same body, already completed | original `201` replayed with `Idempotent-Replayed: true` |
| Same key, different body | `409 idempotency_key_conflict` |
| Existing record in `processing` state | `409 operation_in_progress` with `Retry-After: 1` |
| Existing record in `failed` state | `409 prior_operation_failed`; retry with a new key |
| Key older than 24 hours | treated as a new key |

The key is scoped by the authenticated tenant (`X-Tenant-Id`, never taken from the body) and the operation (`POST:/incidents`), so the same string used by two tenants never collides.

### 1. Why database uniqueness is needed

A check in application code ("look for the key, insert if missing") is a race: two requests can both look, both find nothing, and both create an incident. The same happens across several server processes, where an in-memory lock or cache cannot help. Only the database sees every request, so it must be the referee.

`UNIQUE (tenant_id, operation, key)` makes the claim atomic. Of any number of concurrent requests with the same key, exactly one insert succeeds. The others wait for the winner's transaction to finish, then read its completed record and replay it. As a result, concurrent duplicates normally receive the same `201` with the replay header, not an in-progress error. The supplied 20-concurrent-duplicates test checks this.

### 2. How request contents are canonicalized and compared

Only the business fields (`title`, `severity`, `serviceId`) are hashed, so unknown extra properties neither change the hash nor reach the database. The payload is turned into canonical JSON: object keys are sorted at every depth, array order is kept, and no whitespace is added. The result is hashed with SHA-256 and stored as hex in `request_hash`.

Consequences:

- `{title, severity}` and `{severity, title}` are the same request, because key order does not matter.
- Values are compared exactly. `"x"` and `"x "` differ, and `"1"` and `1` differ, because the server cannot know that a client meant them to be the same.
- Tenant and operation are not part of the hash; they are already part of the scope key.
- On every reuse of a key the stored hash is compared with the new request's hash. A mismatch returns `409 idempotency_key_conflict`, and this check runs before the state check, so a changed body is never replayed or treated as in progress.
- Only the hash is stored, not the request body, which keeps the table small and avoids a second copy of user text.

### 3. What the 24-hour expiry means

When a key is first claimed, `expires_at` is set to the claim time plus 24 hours. It is not extended by replays. Within the window, the same key and body always replay the same result. After it, the key may be used again: the claim statement updates an expired record in place (`DO UPDATE ... WHERE expires_at <= now()`), and the request is processed as a brand-new one, so a new incident is created. Clients must therefore not retry the same key after 24 hours and expect the old result.

Expiry also makes stuck records self-heal: a record left in `processing` or `failed` becomes reusable once it expires. Correctness does not depend on a cleanup job. Deleting expired rows is still worthwhile to keep the table small, and `idempotency_keys_expires_at_idx` exists for that. 24 hours is the exercise value; a real service should choose a window that covers its longest realistic client retry period.

### 4. Why the paging job is stored in the same transaction

Creating an incident and notifying someone are two writes. If they are in different transactions, a crash between them leaves one without the other: an incident that nobody is ever paged for, or a page for an incident that does not exist. Putting the incident, the `paging_jobs` row, the key record and the stored response in one transaction means they all commit or all roll back. After a rollback the key does not exist either, so the client's retry with the same key simply succeeds.

The external pager or queue is deliberately not called inside the transaction. A network call cannot be rolled back, it holds the transaction open while it waits, and a retry would page twice. Instead the `paging_jobs` row is a durable outbox entry, and a separate worker (not part of this exercise) reads pending jobs and calls the provider. `paging_jobs.incident_id` is `UNIQUE`, so one incident can never have two jobs. Delivery to the provider is at-least-once, so the worker should pass the job or incident id to the provider as its own deduplication key.

### 5. Privacy and size risks of stored responses

- **Duplicated data.** The full incident response is stored as JSON in `idempotency_keys.response_body`. Incident titles can contain sensitive text, so this table needs the same access controls, backups and log hygiene as `incidents`, and its contents must not be written to logs.
- **Retention.** The copy lives at least 24 hours and longer if expired rows are not cleaned up. A deletion or erasure request for an incident must also remove its idempotency record. Note that `idempotency_keys.incident_id` references `incidents`, so the key row must be deleted first.
- **Stale snapshot.** A replay returns what the incident looked like at creation, even if it was edited afterwards. That is intended: a retry must get the original answer.
- **Scope.** Replays are scoped to the tenant, not the individual user. Any caller in the same tenant who knows a key and sends the same body gets the stored response. Keys should be random (for example UUIDs) and not guessable.
- **Size.** Keys are limited to 255 characters, only a hash of the request is stored, and rows are short-lived. The response size is bounded by the incident fields, but `title` has no length limit in this exercise. A production version should cap it, and for large responses should store only `incident_id` and rebuild the response instead of copying it.

### Known limitations

- No paging worker is included; `paging_jobs` rows stay `pending`.
- `failed` is never written by this code, because a failure rolls everything back and leaves no record. The state exists for records created by other means, and the handler answers it with `409 prior_operation_failed`. The same applies to `processing`: because the claim and the work share one transaction, other sessions never see an uncommitted `processing` row.
- Expired rows are only reclaimed when the same key is reused; there is no scheduled cleanup.
