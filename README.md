# WhatsApp for Twenty

A Twenty app built from the [in-product preview](docs/implementation.md). It uses a linked WhatsApp device through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.

## Current milestone

The settings component has real QR pairing, connection status, reconnect, and disconnect controls. A separate Node bridge keeps the WebSocket alive and encrypts Baileys credentials and Signal keys at rest with AES-256-GCM. Only members with Twenty's APPLICATIONS permission can start or disconnect a session.

The bridge keeps its session and queues new direct and group messages in Postgres, encrypted before they are written. A Twenty background job imports direct chats after matching the other participant to exactly one existing Person, and imports group messages once that group has been imported from history. Available images, videos, and audio up to 64 MB are downloaded by the bridge and uploaded to the WhatsApp Message Files field in Twenty; media keys stay encrypted on the bridge. The app stores accounts, conversations, and messages in Twenty objects, with unique IDs for replay safety. Direct conversations link to a Person; group conversations retain the group title and message sender. The inbox and Person widget show stored threads, image previews, playable videos and audio, and allow manual text and file replies. A stable request ID prevents retrying an uncertain send as a new message. Attachments are uploaded to WhatsApp before anything is sent, so a failed upload can be retried with the same request ID; the bridge sends one message at a time.

When a message arrives, the bridge calls a signed Twenty route (`/s/whatsapp/bridge/events`, HMAC of the body with the bridge token) that queues a background job to import it. There is no cron: the import job queues itself while messages remain (with a growing delay when a batch fails), the bridge retries a webhook call that fails, and it asks Twenty to refresh the names of the conversations whose WhatsApp contact names changed. A batch of up to 200 queued messages costs four API requests whatever the number of chats (People, conversations, then one upsert of each); files wait in the bridge's media queue (one entry per message, so a file is never queued twice) and at most three chained media jobs upload them, five per job. Twenty limits an app to 500 queued jobs per minute, so every chain spaces its steps and queues one job per step. Jobs are named after the work they cover, so repeated signals queue one job. Delivery and read receipts of outgoing messages (from Twenty or the phone) wait in the bridge's receipt queue, keeping only each message's furthest state, and the same sync job writes them in one query plus one update per state; outgoing bubbles show one tick when sent, two when delivered and two blue ones when read. Group messages stay at sent: WhatsApp reports group receipts per participant. Open inboxes check the REST API every 5 seconds for newer activity and reload only when something changed. The bridge grants one importer a short lease per queued batch, so concurrent imports never duplicate messages. Logic functions log JSON lines; read them with `yarn twenty dev:function:logs`. The bridge logs JSON lines too, including Baileys warnings such as failed decryption retries; set `WHATSAPP_LOG_LEVEL=debug` in `bridge/.env` for more detail. A health check shows a settings banner when the bridge is unreachable or disconnected.

This is a local development implementation synced to `localhost:2020`. New direct incoming and phone-sent texts have been verified in the Twenty inbox, and a message sent from Twenty was received on the contact's phone. Attachment upload and outbound sending have automated checks; a live attachment to another phone still needs verification. The app matches primary Person phone numbers, including LID messages when WhatsApp shares the sender's phone number or a contact mapping is learned from a new incoming message. It does not import calls, view-once media, or direct LID messages without a phone mapping. The inbox shows the 50 most recent conversations (searchable by name) and loads messages 100 at a time.

Once connected, the settings panel can import earlier history: pick a period (last week, month, 3 months or year) and choose **Import**. Every group chat and every direct chat with exactly one matching Person is imported in the background, so the settings page can be closed; a progress bar shows while it runs. The bridge holds the queue and Twenty imports one page of up to 200 messages, from one or more chats, per job: one API request, plus one query and one upsert per 20 finished chats for their summaries. Files are attached by media jobs. Twenty allows an app 500 API requests per minute, shared by every workspace that installed it; the bridge keeps its background jobs to `WHATSAPP_BACKGROUND_REQUESTS_PER_MINUTE` (default 200, set in `bridge/.env`), with live message sync first in line, and tells a job when to come back once that budget is spent. A rate-limited job waits as long as Twenty asks and holds the other background jobs back too; a chat that fails five times in a row is set aside and imported again on the next import. **Cancel import** stops a running import: the bridge drops the chats and files still queued, and the run's job IDs are recorded in the app's key-value store so jobs Twenty already queued stop as soon as they start (Twenty cannot remove a queued job). If a job is lost, the bridge notices the missed step and starts a new job chain. With **Create People from WhatsApp contact info** checked, direct contacts not yet in Twenty get a new Person named from the phone's saved contact or their WhatsApp profile; contacts with no name are skipped. History remains encrypted in the local bridge until imported. Existing People are matched by primary phone; new People are created through the administrator's Twenty permissions, with first and last names from WhatsApp's synced address book (kept encrypted on the bridge). Group participants are not created as People. Message IDs prevent duplicates on retries. The bridge uses a browser identity for QR pairing because WhatsApp currently rejects Baileys' Desktop identity before it can show a QR. WhatsApp may send only part of the old history. Media descriptors discarded before this feature was added cannot be recovered from the bridge cache; WhatsApp must send those old messages again before their files can be imported. The [design preview](docs/import-history-settings-preview.html) still uses sample data.

![Current WhatsApp inbox inside Twenty](docs/current-inbox.png)

One bridge still serves one workspace; multi-tenant support is the next step. Do not connect a production number. WhatsApp may restrict or disconnect unofficial clients.

## Run with a local Twenty instance

Requirements: Node 24.5+, Docker, Twenty 2.45+, a running local Twenty instance at http://localhost:2020, and the Twenty app CLI authenticated to a remote named local.

    yarn install
    yarn twenty remote:use local
    yarn twenty dev --once
    node scripts/configure-local.mjs
    cd bridge
    docker compose up --build

The configure-local.mjs script generates bridge/.env (ignored by Git) with a random bridge token, encryption key, the Twenty webhook URL and the local database URL, then sets the corresponding application variables **only** on the local Twenty remote at http://localhost:2020. The script reuses an existing .env; keep that file with the `postgres` Docker volume, since the key in it is the only way to read the stored session and queued events. [bridge/compose.yaml](bridge/compose.yaml) runs Postgres (published on 127.0.0.1:5433) and the bridge (on 127.0.0.1:8765); Docker Desktop's host.docker.internal lets the local Twenty container reach it, and the bridge reach Twenty.

To work on the bridge itself, run only the database in Docker and the bridge from source: `docker compose up -d postgres`, `npm install`, then `npm run dev` in `bridge/`.

Keep the bridge running while using the app. If the bridge stops, Twenty reports it as unavailable. Restarting the bridge resumes a saved linked-device session automatically; a new QR scan is needed only if WhatsApp has logged the device out. To pick up bridge changes, run `docker compose up --build` again, or `npm run restart` in `bridge/` when running from source: it stops the bridge already listening on its port (from any terminal) and starts a new one in the current terminal. It needs `lsof` (macOS and Linux).

The inbox attachment button uses Twenty's built-in front-component file upload. The renderer must preserve native `File` objects and forward paste/drop files to the app. Apply [the renderer patch](patches/twenty-front-component-file-transfer.patch) to current Twenty source, or [the v2.45.6 backport](patches/twenty-v2.45.6-file-transfer.patch) to that exact release, then rebuild and deploy the frontend. For the stock local v2.45.6 Docker image only, [this checked bundle patcher](scripts/patch-twenty-v2456-renderer.py) updates its renderer asset after verifying the original SHA-256. The local `localhost:2020` container runs the patched image `twentycrm/twenty-app-dev:whatsapp-v2.45.6`; the original image is retained locally as `twentycrm/twenty-app-dev:whatsapp-v2.45.6-base` for rollback. These image tags are local only. A fresh stock image needs the patch applied again. Each file is limited to 64 MB; multiple selected files are sent as separate WhatsApp messages, with the draft text on the first one.

Open **Settings → Apps → WhatsApp → WhatsApp**, read the disclosure, check both acknowledgements, and choose **Show QR code**. Scan with a test phone under **WhatsApp → Linked devices → Link a device**. Disconnect in the same settings panel to delete the bridge's auth state and queues.

For a transport check that does not link a phone, run node bridge/scripts/check-qr.mjs from the repository root while the bridge is running and disconnected. It verifies QR generation and then cancels the pairing attempt. It refuses to run against an active session.

Moving the bridge to Postgres: the bridge no longer reads `bridge/data`. Run `node scripts/configure-local.mjs` to add `DATABASE_URL` to `bridge/.env`, start the bridge as above and scan a new QR code; history WhatsApp sends again can be imported again from **History**, and conversations already in Twenty are kept. Delete `bridge/data` afterwards.

Upgrading to 0.4: the bridge and the app must be updated together, since history pages changed format; restart the bridge with `npm run restart` in `bridge/`. Until it is, history import answers "Update and restart the WhatsApp bridge" instead of starting. Let a running history import finish first, or import it again afterwards.

Upgrading from 0.2: conversations, messages and accounts now use real relations and select fields. Uninstall the app (`yarn twenty app:uninstall`), sync it again, then re-import chats from **History**; the bridge keeps its session and history cache.

Checks (also run by CI on every pull request): `yarn lint`, `yarn format:check`, `yarn typecheck`, `yarn test`, and `npm run typecheck`, `npm run build` and `npm test` in `bridge/`. The bridge storage tests also run against Postgres when `TEST_DATABASE_URL` is set, as in CI.

## Host the bridge

Every push to `main` and every `v*` tag publishes the bridge image to `ghcr.io/martmull/twenty-whatsapp-bridge` (tags `main`, the version, and `sha-…`). Run one container per workspace, next to a Postgres database it owns:

| Variable                | Value                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | Postgres connection string, for example `postgres://bridge:…@db:5432/bridge?sslmode=require`. Tables are created at startup.         |
| `WHATSAPP_SESSION_KEY`  | 32 random bytes in hex (`openssl rand -hex 32`). Everything in the database is encrypted with it; keep it with the database backups. |
| `WHATSAPP_BRIDGE_TOKEN` | Shared with the app's **Bridge token** variable in Twenty.                                                                           |
| `TWENTY_WEBHOOK_URL`    | `https://<your Twenty>/s/whatsapp/bridge/events`                                                                                     |
| `WHATSAPP_BRIDGE_PORT`  | Optional, default `8765`.                                                                                                            |

Serve it over HTTPS (the platform's TLS or a reverse proxy) and set the app's **Bridge URL** to that address. `GET /healthz` answers without a token and reports whether the database is reachable. Run exactly one container per database: two bridges on the same WhatsApp session disconnect each other, so do not scale it out or let deploys overlap.

## Repository layout

- src/: Twenty objects, Person relation, settings and inbox front components, Person widget, and authenticated message routes.
- bridge/: persistent Baileys process with encrypted auth, event queue, selectable history cache, and send receipts, stored in Postgres; its Dockerfile and a local compose file.
- docs/: implementation design, interactive design previews, and screenshots from the earlier in-product preview.
- scripts/configure-local.mjs: local credential and application-variable setup.

## Remaining before production use

Add indexed phone matching for large workspaces, map LID identities without a shared phone number and additional Person numbers, track read receipts per participant in groups, and add operational monitoring for the bridge. The full design and acceptance criteria are in [docs/implementation.md](docs/implementation.md).
