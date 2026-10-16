import { createHmac, timingSafeEqual } from 'node:crypto';

import { defineLogicFunction } from 'twenty-sdk/define';
import { enqueueJobs } from 'twenty-sdk/logic-function';

import { MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { HttpError, route } from 'src/logic-functions/utils/route';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

// Called by the bridge when new messages are queued. The body is signed with the bridge token.
const handler = route<{ sentAt?: string }>('whatsapp-bridge-webhook', async (event, logger) => {
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

  // Imported in a job so the bridge is answered at once; the 5-minute cron covers a lost job.
  await enqueueJobs({ logicFunctionUniversalIdentifier: MESSAGE_SYNC_JOB_UNIVERSAL_IDENTIFIER, jobs: [{}] });
  logger.info('Queued message sync');
  return { queued: true };
});

export default defineLogicFunction({
  universalIdentifier: 'c65015f4-111b-47fb-92f0-263985d8523e',
  name: 'whatsapp-bridge-webhook',
  description: 'Queue a WhatsApp message import when the bridge signals new messages.',
  timeoutSeconds: 30,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/bridge/events',
    httpMethod: 'POST',
    isAuthRequired: false,
    forwardedRequestHeaders: ['x-whatsapp-signature'],
  },
});
