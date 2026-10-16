import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgePost } from 'src/logic-functions/bridge-request';

type UpdatesRequest = { cursor?: string };
type UpdatesResponse = { cursor: string; changed: boolean };

const handler = async (event: RoutePayload<UpdatesRequest>): Promise<UpdatesResponse> => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  const cursor = event.body?.cursor;
  if (typeof cursor !== 'string' || (cursor !== '' && !/^[a-f\d-]{36}$/i.test(cursor))) {
    throw new Error('Invalid update cursor');
  }

  return bridgePost<UpdatesResponse>('/events/wait', { cursor }, 25_000);
};

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
