# WhatsApp for Twenty

A Twenty app built from the [in-product preview](docs/implementation.md). It uses a linked WhatsApp device through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.

## Current milestone

The settings component has real QR pairing, connection status, reconnect, and disconnect controls. A separate Node bridge keeps the WebSocket alive and encrypts Baileys credentials and Signal keys at rest with AES-256-GCM. Only members with Twenty's APPLICATIONS permission can start or disconnect a session.

The bridge now queues new one-to-one incoming and phone-sent text messages in encrypted local files. A Twenty cron job imports them every minute after matching the other participant to exactly one existing Person. The app stores accounts, conversations, and messages in Twenty objects, with unique IDs for replay safety and a Person relation. The inbox and Person widget show stored threads and allow manual text replies. A stable request ID prevents retrying an uncertain send as a new message.

This is a local development implementation synced to `localhost:2020`. New incoming and phone-sent texts have been verified in the Twenty inbox, and a message sent from Twenty was received on the contact's phone. The app matches primary Person phone numbers, including LID messages when WhatsApp shares the sender's phone number or a contact mapping is learned from a new incoming message. It does not import group chats, media, calls, or LID messages without a phone mapping. The inbox currently loads the 50 most recent conversations and 200 most recent messages in a thread.

Once connected, the settings panel can review available one-to-one text history and contacts. Choose a 30-day, 90-day, or all-available range, load more candidates, select chats or contacts, and confirm before importing. History remains encrypted in the local bridge until selected. Existing People are matched by primary phone; selected unmatched contacts are created through the administrator's Twenty permissions. Message IDs prevent duplicates on retries. The bridge uses a browser identity for QR pairing because WhatsApp currently rejects Baileys' Desktop identity before it can show a QR. WhatsApp may send only part of the old history, and an already-linked device may need a fresh QR pairing before older chats become available. The [design preview](docs/import-history-settings-preview.html) still uses sample data.

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

The configure-local.mjs script generates bridge/.env (ignored by Git) with a random bridge token and encryption key, then sets the corresponding application variables **only** on the local Twenty remote at http://localhost:2020. The script reuses an existing .env; keep that file and the encrypted bridge/data directory together or the session and queued events cannot be restored. The bridge listens on 127.0.0.1:8765; Docker Desktop's host.docker.internal lets the local Twenty container reach it.

Keep `npm run dev` running in a dedicated terminal while using the app. If the bridge stops, Twenty reports it as unavailable. Restarting the bridge resumes a saved linked-device session automatically; a new QR scan is needed only if WhatsApp has logged the device out.

Open **Settings → Apps → WhatsApp → WhatsApp**, read the disclosure, check both acknowledgements, and choose **Show QR code**. Scan with a test phone under **WhatsApp → Linked devices → Link a device**. Disconnect in the same settings panel to remove the local auth state.

For a transport check that does not link a phone, run node bridge/scripts/check-qr.mjs from the repository root while the bridge is running and disconnected. It verifies QR generation and then cancels the pairing attempt. It refuses to run against an active session.

## Repository layout

- src/: Twenty objects, Person relation, settings and inbox front components, Person widget, and authenticated message routes.
- bridge/: persistent Baileys process with encrypted auth, event queue, selectable history cache, and send receipts.
- docs/: implementation design, interactive design previews, and screenshots from the earlier in-product preview.
- scripts/configure-local.mjs: local credential and application-variable setup.

## Remaining before production use

Add indexed phone matching for large workspaces, map LID identities without a shared phone number and additional Person numbers, add message status receipts and media placeholders, and implement operational monitoring for the bridge. The full design and acceptance criteria are in [docs/implementation.md](docs/implementation.md).
