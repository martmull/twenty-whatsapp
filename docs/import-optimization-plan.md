# Import jobs optimization plan

**Status:** Implemented in 0.4 (bridge 0.2) · **Scope:** contact (People), message, conversation and media (files) import jobs · **Updated:** 17 October 2026

This plan covers four paths: the live sync (`whatsapp-message-sync`), the history import chain (`whatsapp-history-import-job`), the import request (`whatsapp-history`, which creates People and conversations), and the conversation name refresh. Every Twenty limit cited below was read in the twentyhq/twenty source, not taken from the docs.

## 1. What Twenty actually enforces

| Fact | Value | Source (twentyhq/twenty) | Consequence |
| --- | --- | --- | --- |
| API budget for an app | **500 calls / 60 s, burst 500, shared by every workspace that installed the app** (key = app universal identifier) | `usage-limit-definitions.constant.ts`, `build-default-speed-bucket.util.ts` | The "100 per minute per workspace" in `history-import.ts` is the API-key limit. App tokens get 500, but on Cloud that budget is shared by every customer. |
| Who pays | `runAs: 'application'` **and** `runAs: 'user'` calls made through the app (`viaApplication`) | `build-usage-spenders-from-auth-context.util.ts` | The inbox polling, sends and imports all draw from one bucket. |
| Unit of cost | **1 per root operation**, whatever the number of records | `common-base-query-runner.service.ts` (`consumeApiSpeedLimit` when `isRootOperation`) | One `createMany` of 200 records costs the same as one `updateOne`. Several aliased mutations in one HTTP request still cost 1 each; they only save round trips. |
| Batch size | `createMany` / upsert: **200 records** (`QUERY_MAX_RECORDS`) | `common-create-many-query-runner.service.ts` | Pages of 200, not 100. |
| `createMany(upsert: true)` | Matches on `id` **or any unique index** (composite included), then inserts or partially updates. Only the fields sent are written. | `get-conflicting-fields.util.ts`, `categorize-records.util.ts` | `externalId` (message), `(accountId, chatId)` (conversation) and `phoneNumber` (account) are already unique indexes here, so you can upsert without querying first. Per-record updates become **one** upsert with ids, not N `updateOne`. |
| Ids | Any valid UUID v1–v5 is accepted on create | `isValidUuid.ts` | Deterministic UUID v5 ids are allowed. |
| Rate-limit error | GraphQL `RATE_LIMITED` with `extensions.retryAfterMs` | `usage-limit-to-graphql-api-exception-handler.util.ts` | Retry after exactly that delay instead of a fixed 60 s. |
| File upload | `createFileUpload` / `completeFileUpload` are metadata resolvers: **not counted** in the API bucket | `file-upload.resolver.ts` | `REQUESTS_PER_MEDIA_UPLOAD = 2` charges media against a budget it does not use. |
| `enqueueJobs` | ≤ 200 jobs per call, **500 jobs/min per installation**, 2,000/min per app; `delayMs` ≤ 7 days; `retryLimit` 0–10 (default **0**); platform retry backoff is exponential from **1 s** with 50 % jitter | `application-job.service.ts`, `application-job/constants/*`, `logic-function-queue-retry-backoff.constant.ts` | Platform retries suit network blips. A 60 s rate-limit window or a bridge outage needs our own `delayMs`. |
| `jobId` | Caller-supplied, `[\w.-]{1,128}`, prefixed with the workspace. BullMQ ignores an add whose id still exists in any state. Completed jobs are kept 4 h or up to **1,000 per queue across all workspaces**. | `build-queue-job-id.util.ts`, `bullmq.driver.ts`, `queue-retention.constants.ts` | A deterministic `jobId` makes self-enqueue idempotent. Dedup is best effort once a job has been purged, so correctness must still come from the upserts. |
| SDK | `twenty-sdk@2.45.0` (the version pinned here) already types `jobId` and `retryLimit` | `dist/logic-function/index.d.ts` | No SDK bump needed. |

## 2. Today: where the requests go

| Path | Requests (application bucket) | Bottleneck |
| --- | --- | --- |
| Live sync, per batch | `ensureAccount` 1–2 + People 1 + conversations 1, then **per chat**: existence query 1 + `createMany` 1 + summary `updateOne` 1 (+ `createOne` for a new conversation) | Cost grows with the number of chats in the batch. A batch stops after its **first media** (`firstMediaIndex`), so a burst of N photos means N sequential jobs. Re-enqueue on progress has **0 delay** and no pacing. |
| History, per page (≤ 100 messages, ≤ 5 media) | existence query 1 + `createMany` 1, + 2 for the summary on a chat's last page | Pacing at a hard-coded 40/min that also counts media as 2 requests each (they cost 0). Media upload runs serially inside the page job. One job at a time. |
| Import request (`queueImport`) | account 1–2 + People 1 + conversations 1 + **`createPerson` × new** + **`updatePerson` × renamed** + `createMany` conversations 1 + **`updateOne` × renamed conversations** | Up to ~100 calls in a 60 s HTTP route. A double click can create duplicate People. |
| Name refresh | 1 query per 100 conversations + **`updateOne` per renamed conversation** | Bursts hundreds of calls after a history sync. |
| Media | Serial download → PUT → complete inside the message job | Blocks text messages behind binaries and limits throughput. |

## 3. New strategy

### 3.1 Principles

1. **Write with upserts, never read before writing.** `createMany(upsert: true)` on the unique indexes replaces every "existence query + create" and every loop of `updateOne`. Send only the fields this path owns, so an upsert never overwrites state another path maintains.
2. **Batch across chats, not per chat.** One sync batch makes the same fixed number of calls for 1 chat or 80.
3. **Deterministic ids for anything this app creates.** `uuidv5(APP_NAMESPACE, kind + ':' + naturalKey)`: Person `person:+E164`, conversation `conversation:<accountId>:<chatId>`. A retry, a double click or a duplicated job writes the same row.
4. **Every self-enqueue carries a deterministic `jobId`**, so a retried job never starts a second chain.
5. **The bridge holds the budget.** It already leases every page and batch, so it also grants API budget (token bucket) in the same claim response. No extra round trip.
6. **Retry by error type.** Network blips use platform `retryLimit` (fast, now safe because the work is idempotent). `RATE_LIMITED` reschedules after `retryAfterMs` + jitter. Bridge down gets exponential self-reschedule (30 s → 15 min).
7. **Media is decoupled.** Messages land first with `mediaKind` set; a separate media job uploads files in parallel and attaches them with one upsert.

### 3.2 Per path

**Live sync (`whatsapp-message-sync`)**

- The bridge returns up to **200** events per claim, with media inline (no more slicing at the first media) and a budget grant.
- Per batch: People query 1 + conversations query 1 (needed for group gating and summaries) + **one conversations upsert** (new conversations with deterministic id, name and Person; existing ones with `lastMessageAt` / `lastPreview` / `lastInboundAt`, moved forward only, computed from the query) + **one messages upsert** on `externalId` = **4 calls per batch**, whatever the chat count.
- The upsert selects `id externalId media { fileId }`. Messages with `mediaKind` but no file are handed to the media job.
- `ensureAccount` runs only on `connection.changed`. The bridge caches the Twenty `accountId` and returns it in `/status`, which saves 1–2 calls per batch.
- One `/events/ack` per batch instead of one per chat.
- Chain: `jobId = sync.<bridgeOutboxSeq>`. Every webhook signal for the same pending state maps to the same job, so bursts of signals collapse into one run.

**History import (`whatsapp-history-import-job`)**

- The bridge packs pages of **up to 200 messages across several chats**, in queue order, ignoring media count.
- Per page: **one messages upsert**. The bridge is the source of truth for each chat's latest message, so it sends the final summary and Twenty writes it without reading first. Finished chats' summaries are flushed in one conversations upsert every few pages and on the last one.
- Pacing: drop `HISTORY_IMPORT_REQUESTS_PER_MINUTE` and the media surcharge. The page job asks the bridge's bucket (default background budget **200/min**, an app variable) and gets back `nextRunInMs`.
- Chain: `jobId = history.<runToken>.<pageSeq>`, `retryLimit: 2`. The "never throw" rule goes away, because a retried page is an idempotent upsert and its next-enqueue is deduplicated. The run token and lease stay as the safety net for a lost chain.

**Import request (`whatsapp-history` → `queueImport`), the contacts path**

- **One People upsert** as the admin (`userClient`, so their permissions apply). New People get deterministic `person:+E164` ids with name and phone; renamed People get `{ id, name }`.
- **One conversations upsert**: new conversations with deterministic ids, existing ones still named after a phone number with `{ id, name }`.
- **5 calls** for 50 chats (account, People and conversations lookups, then the two upserts) instead of up to ~100. A double submit creates nothing twice.

**Name refresh**

- The bridge keeps a names version and returns only chats renamed since the last run.
- 1 conversations query (`chatId in …`) + **1 upsert** of `{ id, name }` per 200. `jobId = names.<namesVersion>`.

**Media (files), new `whatsapp-media-import` job**

- Fan out after each message write: one job per group of up to 5 media, `jobId = media.<sha256(sorted eventIds) first 40 hex>`, so history and live sync never upload the same file twice. All groups go in one `enqueueJobs` call (≤ 200 jobs).
- The bridge limits concurrent media leases (default 3), protecting its bandwidth and the worker's memory.
- Each job downloads, PUTs and completes the uploads (0 API budget), then makes **one messages upsert** `{ id, media: [file] }` for the group.
- `retryLimit: 3` for transient errors. Expired media is final: the message keeps `mediaKind` with no file, as today.

### 3.3 Budget and retry rules

| Signal | Action |
| --- | --- |
| Claim returns `{ waitMs }` (bucket empty) | Re-enqueue self with `delayMs = waitMs`, same `jobId` lineage |
| `RATE_LIMITED` from Twenty | Report `retryAfterMs` to the bridge (it freezes the bucket until then), re-enqueue with `retryAfterMs` + 0–20 % jitter. Does not count as a chat failure (kept from today). |
| Network / 5xx on a Twenty call | Throw → platform retry (1 s, 2 s, 4 s), at most `retryLimit` |
| Bridge unavailable | Re-enqueue at 30 s × 2ⁿ, capped at 15 min. After 8 tries, stop; the bridge's next signal restarts the chain (kept from today). |
| Invalid event / permanent 4xx | Ack and skip (kept from today) |

Budget defaults: background jobs **≤ 200/min** (40 % of the bucket), leaving ~300/min for the inbox (≈ 12 calls/min per open thread from the 5 s poll), sends and other installs. Self-hosted admins can change it with `WHATSAPP_BACKGROUND_REQUESTS_PER_MINUTE` in `bridge/.env`. Live sync may borrow up to a quarter of a minute's budget; history and media leave a tenth of it for live sync. Waiting background jobs, and media jobs waiting for a lease, get successive wake-up times instead of all retrying at once, which keeps re-enqueues far below the 500 jobs/min limit.

## 4. Before / after

Scenarios use the request formulas from sections 2 and 3. Latency assumptions: ~100 ms per Twenty call, ~2 s per media upload.

| Scenario | Before: Twenty calls | After: Twenty calls | Before: wall clock | After: wall clock | Gain |
| --- | --- | --- | --- | --- | --- |
| **A. History, 50 chats, 10,000 messages, 300 media** | ~300 (100 pages × 2 + 50 summaries × 2); pacing counts ~1,000 | ~120 (50 page upserts + ~10 summary flushes + 60 media upserts) | **~25 min** (1,000 ÷ 40/min floor; serial media overlaps) | **~3–5 min** (API floor < 1 min at 200/min; media 300 × 2 s ÷ 3 parallel) | 2.5× fewer calls, **5–8× faster**, 100 serial jobs → 50 page jobs + 60 parallel media jobs |
| **B. Reconnect burst, 1,000 queued events, 80 chats, 40 media** | ~2,000 (≈ 41 batches cut at each media × ~48 calls) | ~28 (5 batches × 4 + 8 media upserts) | ~4–5 min, and **likely `RATE_LIMITED`** (~575 calls/min with no pacing) | **< 1 min**, never above budget | **~70× fewer calls**, no throttling of the inbox |
| **C. Import request, 50 chats, 30 new People, 10 People renames, 10 conversation renames** | ~55 calls in one 60 s route (~6–11 s) | 5 (account 1 + People 1 + conversations 1 + People upsert 1 + conversations upsert 1) | 6–11 s, duplicates on double submit | **< 1 s**, idempotent | **~11× fewer calls**, no duplicate People |
| **D. Name refresh, 500 conversations, 200 renamed** | ~205 (5 pages + 200 `updateOne`) | 2 (delta query + 1 upsert) | ~20 s burst, 40 % of the app budget | < 1 s | **~100× fewer calls** |
| **Steady state, 1 message/min on 10 chats** | ~6 per message (account, People, conversations, existence, create, summary) | 4 per batch, and the 1 s signal merge plus `jobId` dedup fold close messages into one batch | n/a | n/a | ~1.5–5× depending on burstiness |

Effects beyond the numbers:

- The inbox UI stays responsive during imports: background work is capped at 40 % of a shared bucket instead of being uncapped (sync) or mis-measured (history).
- Fewer Twenty write transactions (one 200-row upsert instead of ~150 single-row statements) cut DB load and timeline-activity fan-out.
- Every write is replay-safe: platform retries, duplicated signals and double submits converge to the same rows.

## 5. Rollout (one PR each, in order)

1. **Upsert helpers + deterministic ids** (`message-data.ts`): `upsertMessages`, `upsertConversations`, `upsertPeople`, `deterministicId(kind, key)`, `retryAfterMs(error)`. Unit tests cover the field sets per path and summaries that never move backward.
2. **Contacts and names** (`whatsapp-history.ts`, `syncConversationNames`): batch People and conversation writes, bridge names delta. This is the lowest-risk, user-visible win.
3. **Live sync**: 200-event batches, 4 calls per batch, single ack, cached `accountId`, `jobId = sync.<seq>`.
4. **Media job**: new logic function plus universal identifier, bridge media lease semaphore, fan-out from sync and history. Remove inline media from both paths.
5. **History chain**: multi-chat 200-message pages, bridge-sent summaries, `jobId` per page, `retryLimit: 2`. Remove `HISTORY_IMPORT_REQUESTS_PER_MINUTE` and `REQUESTS_PER_MEDIA_UPLOAD`.
6. **Bridge budget**: token bucket (`WHATSAPP_BACKGROUND_REQUESTS_PER_MINUTE`, default 200), granted in `/events/claim`, `/history/imports/claim` and `/media/claim`, frozen on a reported `retryAfterMs`.

Each step keeps the existing tests (`test/history-import-job.test.ts`, `test/message-sync-job.test.ts`, `bridge/test/history-import-queue.test.ts`) green. A request-counting proxy (like `countRequests` today) asserts the call counts above per scenario.

## 6. Risks and caveats

- **Upsert overwrites the fields it sends.** Message upserts send only the fields an import owns (`conversationId`, `externalId`, `direction`, `text`, `sentAt`, `deliveryState`, `senderId`, `senderName`, `mediaKind`). `deliveryState` is always `SENT` or `RECEIVED` for an event seen on WhatsApp, so rewriting it on a replay is correct. `media` is written only by the media job, and `requestId` only by the send route.
- **Upsert restores soft-deleted rows.** Twenty matches deleted records too and clears `deletedAt`. A Person or conversation deleted in Twenty comes back if the same chat is imported again, instead of failing on its unique index. Pre-existing records keep their random ids; they are found through the unique indexes, so no migration is needed.
- **`jobId` dedup is best effort.** BullMQ only remembers a completed job for 4 h or 1,000 jobs queue-wide. Idempotent upserts and the bridge leases remain the real guarantee.
- **Request size.** 200 messages × 4,096 characters is about 0.8 MB. Cap pages by bytes too (~512 KB).
- **Cross-workspace budget.** On Twenty Cloud the 500/min is shared by every workspace using this app. The bridge budget only sees its own installation, so `RATE_LIMITED` handling with `retryAfterMs` stays essential.
- **Media placeholder.** Imported media messages show their kind before the file arrives (seconds to minutes). The thread UI already renders a message without a file; a "loading" hint is optional.
