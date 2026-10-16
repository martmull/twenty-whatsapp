import { defineLogicFunction } from 'twenty-sdk/define';

import { applicationClient, userClient } from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { isUuid } from 'src/logic-functions/utils/validators';

type ReadRequest = { conversationId?: string; readThroughAt?: string };

// Advances the current member's read cursor. One read-state record per member and conversation.
const handler = route<ReadRequest>('whatsapp-message-read', async (event) => {
  const userWorkspaceId = requireUser(event);
  const { conversationId, readThroughAt } = event.body ?? {};

  if (!isUuid(conversationId) || !readThroughAt || !Number.isFinite(Date.parse(readThroughAt))) {
    throw new HttpError(400, 'Invalid request');
  }

  const visible = await userClient().query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: { id: true, lastInboundAt: true } },
    },
  });
  const lastInboundAt = visible.whatsappConversations?.edges?.[0]?.node?.lastInboundAt;

  if (!lastInboundAt || readThroughAt > lastInboundAt) {
    throw new HttpError(404, 'Conversation not found');
  }

  const client = applicationClient();
  const name = `${userWorkspaceId}:${conversationId}`;
  const findReadState = async () => {
    const result = await client.query({
      whatsappConversationReadStates: {
        __args: { filter: { name: { eq: name } }, first: 1 },
        edges: { node: { id: true, lastReadAt: true } },
      },
    });
    return result.whatsappConversationReadStates?.edges?.[0]?.node;
  };

  let readState = await findReadState();

  if (!readState) {
    try {
      await client.mutation({
        createWhatsappConversationReadState: { __args: { data: { name, lastReadAt: readThroughAt } }, id: true },
      });
      return { lastReadAt: readThroughAt };
    } catch {
      // Another tab created it at the same time.
      readState = await findReadState();
      if (!readState) throw new Error('Could not save read state');
    }
  }

  if (readState.lastReadAt && readState.lastReadAt >= readThroughAt) {
    return { lastReadAt: readState.lastReadAt };
  }

  await client.mutation({
    updateWhatsappConversationReadState: {
      __args: { id: readState.id, data: { lastReadAt: readThroughAt } },
      id: true,
    },
  });

  return { lastReadAt: readThroughAt };
});

export default defineLogicFunction({
  universalIdentifier: 'cda74c82-3608-4721-8221-d1a96f84c3d1',
  name: 'whatsapp-message-read',
  description: 'Advance one workspace member’s read cursor for a visible WhatsApp conversation.',
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/read',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
