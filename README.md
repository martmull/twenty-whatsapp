# WhatsApp for Twenty

A Twenty app built from the [in-product preview](docs/implementation.md). It uses a linked WhatsApp device through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.

## Current milestone

The settings component has real QR pairing, connection status, reconnect, and disconnect controls. A separate Node bridge keeps the WebSocket alive and encrypts Baileys credentials and Signal keys at rest with AES-256-GCM. Only members with Twenty's APPLICATIONS permission can start or disconnect a session.

The inbox and Person widget retain the preview's Twenty layout but show honest empty states. **Message receive, CRM matching, record storage, and send are not implemented yet.** No phone has been linked by the repository or local setup scripts.

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

The configure-local.mjs script generates bridge/.env (ignored by Git) with a random bridge token and encryption key, then sets the corresponding application variables **only** on the local Twenty remote at http://localhost:2020. The script reuses an existing .env; keep that file and the encrypted bridge/data directory together or the session cannot be restored. The bridge listens on 127.0.0.1:8765; Docker Desktop's host.docker.internal lets the local Twenty container reach it.

Open **Settings → Apps → WhatsApp → WhatsApp**, read the disclosure, check both acknowledgements, and choose **Show QR code**. Scan with a test phone under **WhatsApp → Linked devices → Link a device**. Disconnect in the same settings panel to remove the local auth state.

For a transport check that does not link a phone, run node bridge/scripts/check-qr.mjs from the repository root while the bridge is running and disconnected. It verifies QR generation and then cancels the pairing attempt. It refuses to run against an active session.

## Repository layout

- src/: Twenty application manifest, settings and inbox front components, Person widget, and authenticated connection routes.
- bridge/: persistent Baileys process and encrypted auth store.
- docs/: implementation design, interactive design preview, and screenshots from the earlier in-product preview.
- scripts/configure-local.mjs: local credential and application-variable setup.

## Next implementation slice

Add WhatsAppAccount, WhatsAppConversation, and WhatsAppMessage app objects and unique provider IDs; match incoming phone identities to existing People; ingest and deduplicate text messages; expose real inbox and Person threads; then add idempotent manual replies. The full design and acceptance criteria are in [docs/implementation.md](docs/implementation.md).
