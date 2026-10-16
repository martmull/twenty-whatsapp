import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgePost } from 'src/logic-functions/bridge-request';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { isUuid } from 'src/logic-functions/utils/validators';

type UpdatesRequest = { cursor?: string };
type UpdatesResponse = { cursor: string; changed: boolean };

const handler = route<UpdatesRequest>('whatsapp-message-updates', async (event): Promise<UpdatesResponse> => {
  requireUser(event);

  const cursor = event.body?.cursor;
  if (typeof cursor !== 'string' || (cursor !== '' && !isUuid(cursor))) {
    throw new HttpError(400, 'Invalid update cursor');
  }

  return bridgePost<UpdatesResponse>('/events/wait', { cursor }, 25_000);
});

export default defineLogicFunction({
  universalIdentifier: 'cea0f97f-a00a-445d-b99a-22e477503ba8',
  name: 'whatsapp-message-updates',
  description: 'Wait for a bridge change without exposing its token to the browser.',
  timeoutSeconds: 30,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/updates',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
