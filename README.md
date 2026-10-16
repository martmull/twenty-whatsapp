# WhatsApp for Twenty

A Twenty app built from the [in-product preview](docs/implementation.md). It uses a linked WhatsApp device through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.

## Current milestone

The settings component has real QR pairing, connection status, reconnect, and disconnect controls. A separate Node bridge keeps the WebSocket alive and encrypts Baileys credentials and Signal keys at rest with AES-256-GCM. Only members with Twenty's APPLICATIONS permission can start or disconnect a session.

The bridge queues new direct and group messages in encrypted local files. A Twenty cron job imports direct chats after matching the other participant to exactly one existing Person, and imports group messages only after an admin selects that group. Available images, videos, and audio up to 64 MB are downloaded by the bridge and uploaded to the WhatsApp Message Files field in Twenty; media keys stay encrypted on the bridge. The app stores accounts, conversations, and messages in Twenty objects, with unique IDs for replay safety. Direct conversations link to a Person; group conversations retain the group title and message sender. The inbox and Person widget show stored threads, image previews, playable videos and audio, and allow manual text and file replies. A stable request ID prevents retrying an uncertain send as a new message.

When a message arrives, the bridge calls a signed Twenty route (`/s/whatsapp/bridge/events`, HMAC of the body with the bridge token) that imports it right away; a 5-minute cron catches anything missed. Open inboxes check the REST API every 5 seconds for newer activity and reload only when something changed. The bridge grants one importer a short lease per queued batch, so concurrent imports never duplicate messages. Logic functions log JSON lines; read them with `yarn twenty dev:function:logs`. A health check shows a settings banner when the bridge is unreachable or disconnected.

This is a local development implementation synced to `localhost:2020`. New direct incoming and phone-sent texts have been verified in the Twenty inbox, and a message sent from Twenty was received on the contact's phone. Attachment upload and outbound sending have automated checks; a live attachment to another phone still needs verification. The app matches primary Person phone numbers, including LID messages when WhatsApp shares the sender's phone number or a contact mapping is learned from a new incoming message. It does not import calls, view-once media, or direct LID messages without a phone mapping. The inbox shows the 50 most recent conversations (searchable by name) and loads messages 100 at a time.

Once connected, the settings panel can review direct and group history. Choose a 30-day, 90-day, or all-available range, filter to Groups, load more candidates, select chats, and confirm before importing. Available images and videos are imported with selected messages. History remains encrypted in the local bridge until selected. Existing People are matched by primary phone; selected unmatched direct contacts can be named and created through the administrator's Twenty permissions. Group participants are not created as People. Message IDs prevent duplicates on retries. The bridge uses a browser identity for QR pairing because WhatsApp currently rejects Baileys' Desktop identity before it can show a QR. WhatsApp may send only part of the old history. Media descriptors discarded before this feature was added cannot be recovered from the bridge cache; WhatsApp must send those old messages again before their files can be imported. The [design preview](docs/import-history-settings-preview.html) still uses sample data.

![Current WhatsApp inbox inside Twenty](docs/current-inbox.png)

This is a single-workspace local development slice. Do not deploy the bridge as a public service or connect a production number. WhatsApp may restrict or disconnect unofficial clients.

## Run with a local Twenty instance

Requirements: Node 24.5+, Twenty 2.45+, a running local Twenty instance at http://localhost:2020, and the Twenty app CLI authenticated to a remote named local.

    yarn install
    yarn twenty remote:use local
    yarn twenty dev --once
    cd bridge
    npm install
    cd ..
    node scripts/configure-local.mjs
    cd bridge
    npm run dev

The configure-local.mjs script generates bridge/.env (ignored by Git) with a random bridge token, encryption key and the Twenty webhook URL, then sets the corresponding application variables **only** on the local Twenty remote at http://localhost:2020. The script reuses an existing .env; keep that file and the encrypted bridge/data directory together or the session and queued events cannot be restored. The bridge listens on 127.0.0.1:8765; Docker Desktop's host.docker.internal lets the local Twenty container reach it.

Keep `npm run dev` running in a dedicated terminal while using the app. If the bridge stops, Twenty reports it as unavailable. Restarting the bridge resumes a saved linked-device session automatically; a new QR scan is needed only if WhatsApp has logged the device out.

The inbox attachment button uses Twenty's built-in front-component file upload. The renderer must preserve native `File` objects and forward paste/drop files to the app. Apply [the renderer patch](patches/twenty-front-component-file-transfer.patch) to current Twenty source, or [the v2.45.6 backport](patches/twenty-v2.45.6-file-transfer.patch) to that exact release, then rebuild and deploy the frontend. For the stock local v2.45.6 Docker image only, [this checked bundle patcher](scripts/patch-twenty-v2456-renderer.py) updates its renderer asset after verifying the original SHA-256. The local `localhost:2020` container runs the patched image `twentycrm/twenty-app-dev:whatsapp-v2.45.6`; the original image is retained locally as `twentycrm/twenty-app-dev:whatsapp-v2.45.6-base` for rollback. These image tags are local only. A fresh stock image needs the patch applied again. Each file is limited to 64 MB; multiple selected files are sent as separate WhatsApp messages, with the draft text on the first one.

Open **Settings → Apps → WhatsApp → WhatsApp**, read the disclosure, check both acknowledgements, and choose **Show QR code**. Scan with a test phone under **WhatsApp → Linked devices → Link a device**. Disconnect in the same settings panel to remove the local auth state.

For a transport check that does not link a phone, run node bridge/scripts/check-qr.mjs from the repository root while the bridge is running and disconnected. It verifies QR generation and then cancels the pairing attempt. It refuses to run against an active session.

Upgrading from 0.2: conversations, messages and accounts now use real relations and select fields. Uninstall the app (`yarn twenty app:uninstall`), sync it again, then re-import chats from **History**; the bridge keeps its session and history cache.

Checks (also run by CI on every pull request): `yarn lint`, `yarn format:check`, `yarn typecheck`, `yarn test`, and `npm run typecheck` and `npm test` in `bridge/`.

## Repository layout

- src/: Twenty objects, Person relation, settings and inbox front components, Person widget, and authenticated message routes.
- bridge/: persistent Baileys process with encrypted auth, event queue, selectable history cache, and send receipts.
- docs/: implementation design, interactive design previews, and screenshots from the earlier in-product preview.
- scripts/configure-local.mjs: local credential and application-variable setup.

## Remaining before production use

Add indexed phone matching for large workspaces, map LID identities without a shared phone number and additional Person numbers, add message status receipts and operational monitoring for the bridge. The full design and acceptance criteria are in [docs/implementation.md](docs/implementation.md).
