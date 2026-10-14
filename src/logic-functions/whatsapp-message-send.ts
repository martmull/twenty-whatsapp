import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeJsonRequest, bridgeRequest } from 'src/logic-functions/bridge-request';
import { applicationClient, findMessageByRequestId, userClient } from 'src/logic-functions/message-data';

type SendRequest = { conversationId?: string; requestId?: string; text?: string };
type SendReceipt = { state: 'unknown' | 'sent'; eventId?: string };

const handler = async (event: RoutePayload<SendRequest>) => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  const { conversationId, requestId, text } = event.body ?? {};

  if (!conversationId || !/^[a-f\d-]{36}$/i.test(conversationId) || !requestId || !/^[a-f\d-]{36}$/i.test(requestId) || !text || !text.trim() || text.length > 4096) {
    throw new Error('Invalid message');
  }

  const visible = await userClient().query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: { id: true, chatId: true, accountId: true } },
    },
  });
  const conversation = visible.whatsappConversations?.edges?.[0]?.node;

  if (!conversation || (!/^\d{7,15}@s\.whatsapp\.net$/.test(conversation.chatId ?? '') && !/^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(conversation.chatId ?? ''))) {
    throw new Error('Conversation unavailable');
  }

  const status = await bridgeRequest('/status');

  if (status.state !== 'connected') {
    throw new Error('WhatsApp is disconnected');
  }

  const connectedPhoneNumber = status.phoneNumber?.replace(/\D/g, '');
  const account = await applicationClient().query({
    whatsappAccounts: {
      __args: { filter: { id: { eq: conversation.accountId ?? '' } }, first: 1 },
      edges: { node: { phoneNumber: true } },
    },
  });

  if (!connectedPhoneNumber || account.whatsappAccounts?.edges?.[0]?.node?.phoneNumber !== `+${connectedPhoneNumber}`) {
    throw new Error('This conversation belongs to a different WhatsApp account');
  }

  const client = applicationClient();
  let message = await findMessageByRequestId(client, requestId);

  if (message && (message.conversationId !== conversationId || message.text !== text)) {
    throw new Error('Request ID already used');
  }

  if (!message) {
    const created = await client.mutation({
      createWhatsappMessage: {
        __args: { data: { name: text.slice(0, 80), conversationId, direction: 'outbound', text, sentAt: new Date().toISOString(), deliveryState: 'unknown', requestId } },
        id: true,
      },
    });
    const id = created.createWhatsappMessage?.id;

    if (!id) {
      throw new Error('Could not store outgoing message');
    }

    message = { id, conversationId, direction: 'outbound', text, sentAt: new Date().toISOString(), deliveryState: 'unknown', requestId };
  }

  if (message.deliveryState === 'sent') {
    return { messageId: message.id, state: 'sent' as const };
  }

  const receipt = await bridgeJsonRequest<SendReceipt>('/send', { requestId, chatId: conversation.chatId, text, accountPhoneNumber: `+${connectedPhoneNumber}` });

  if (receipt.state === 'sent') {
    await client.mutation({
      updateWhatsappMessage: {
        __args: { id: message.id, data: { deliveryState: 'sent', externalId: receipt.eventId } },
        id: true,
      },
    });
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversationId, data: { lastMessageAt: new Date().toISOString(), lastPreview: text.slice(0, 160) } },
        id: true,
      },
    });
  }

  return { messageId: message.id, state: receipt.state };
};

export default defineLogicFunction({
  universalIdentifier: '9d76e546-352a-4cf1-bd64-92d36c653b6a',
  name: 'whatsapp-message-send',
  description: 'Send one manual text message with a stable request ID.',
  timeoutSeconds: 30,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/send',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
