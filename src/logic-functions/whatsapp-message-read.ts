import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { applicationClient, userClient } from 'src/logic-functions/message-data';

type ReadRequest = { conversationId?: string; readThroughAt?: string };

const handler = async (event: RoutePayload<ReadRequest>) => {
  const { conversationId, readThroughAt } = event.body ?? {};

  if (!event.userWorkspaceId || !conversationId || !/^[a-f\d-]{36}$/i.test(conversationId) || !readThroughAt || !Number.isFinite(Date.parse(readThroughAt))) {
    throw new Error('Invalid read request');
  }

  const visible = await userClient().query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: { id: true, lastInboundAt: true } },
    },
  });
  const latestInboundAt = visible.whatsappConversations?.edges?.[0]?.node?.lastInboundAt;

  if (!latestInboundAt || readThroughAt > latestInboundAt) {
    throw new Error('Conversation unavailable or read cursor is ahead of the conversation');
  }

  const client = applicationClient();
  const name = `${event.userWorkspaceId}:${conversationId}`;
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
        createWhatsappConversationReadState: {
          __args: { data: { name, lastReadAt: readThroughAt } },
          id: true,
        },
      });
      return { lastReadAt: readThroughAt };
    } catch {
      readState = await findReadState();
      if (!readState) throw new Error('Could not save read state');
    }
  }

  if (!readState.lastReadAt || readThroughAt > readState.lastReadAt) {
    await client.mutation({
      updateWhatsappConversationReadState: {
        __args: { id: readState.id, data: { lastReadAt: readThroughAt } },
        id: true,
      },
    });
  }

  return { lastReadAt: readThroughAt > (readState.lastReadAt ?? '') ? readThroughAt : readState.lastReadAt };
};

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
