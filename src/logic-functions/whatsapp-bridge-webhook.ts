import { createHmac, timingSafeEqual } from 'node:crypto';

import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { enqueueHistoryImport } from 'src/logic-functions/history-import';
import { HttpError, route } from 'src/logic-functions/utils/route';
import { isUuid } from 'src/logic-functions/utils/validators';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

type BridgeSignal = { sentAt?: string; events?: boolean; names?: boolean; historyRunToken?: string };

// The bridge's only way to start work in Twenty: there is no cron. The bridge retries a signal that
// fails or is not acted on, and replaces a lost history import chain. The body is HMAC-signed.
const handler = route<BridgeSignal>('whatsapp-bridge-webhook', async (event, logger) => {
  const token = process.env.WHATSAPP_BRIDGE_TOKEN;
  const signature = event.headers['x-whatsapp-signature'] ?? '';
  const expected = token && event.rawBody ? createHmac('sha256', token).update(event.rawBody).digest('hex') : '';

  if (
    !expected ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    throw new HttpError(401, 'Invalid signature');
  }

  if (!(Math.abs(Date.now() - Date.parse(event.body?.sentAt ?? '')) < MAX_CLOCK_SKEW_MS)) {
    throw new HttpError(401, 'Expired request');
  }

  const { names, historyRunToken } = event.body ?? {};
  // A bridge from before signals carried flags only ever meant "events are queued".
  const events = event.body?.events ?? (!names && !historyRunToken);

  if (events || names) {
    await enqueueJobs({
      logicFunctionUniversalIdentifier: MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER,
      jobs: [{ payload: { events: Boolean(events), names: Boolean(names) } }],
    });
  }

  if (isUuid(historyRunToken)) {
    await enqueueHistoryImport(historyRunToken, 0);
  }

  logger.info('Handled bridge signal', { events, names: Boolean(names), history: isUuid(historyRunToken) });
  return { queued: true };
});

export default defineLogicFunction({
  universalIdentifier: 'c65015f4-111b-47fb-92f0-263985d8523e',
  name: 'whatsapp-bridge-webhook',
  description: 'Queue WhatsApp message, name or history import jobs when the bridge signals them.',
  timeoutSeconds: 30,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/bridge/events',
    httpMethod: 'POST',
    isAuthRequired: false,
    forwardedRequestHeaders: ['x-whatsapp-signature'],
  },
});
