import { defineLogicFunction } from 'twenty-sdk/define';

import { CONVERSATION_FIELDS, nodesOf, userClient, type Conversation } from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { isUuid } from 'src/logic-functions/utils/validators';

type UpdateRequest = { conversationId?: string; status?: string; assigneeId?: string | null };

const STATUSES = ['OPEN', 'CLOSED'];

// Assigns a conversation to a member (or nobody), or opens or closes it. Runs as the member, so
// only members who can edit the conversation can triage it.
const handler = route<UpdateRequest>('whatsapp-conversation-update', async (event) => {
  requireUser(event);
  const { conversationId, status, assigneeId } = event.body ?? {};

  if (
    !isUuid(conversationId) ||
    (status !== undefined && !STATUSES.includes(status)) ||
    (assigneeId !== undefined && assigneeId !== null && !isUuid(assigneeId)) ||
    (status === undefined && assigneeId === undefined)
  ) {
    throw new HttpError(400, 'Invalid request');
  }

  const client = userClient();
  const visible = await client.query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: { id: true } },
    },
  });
  if (nodesOf(visible.whatsappConversations).length === 0) {
    throw new HttpError(404, 'Conversation not found');
  }

  if (assigneeId) {
    const member = await client.query({
      workspaceMembers: { __args: { filter: { id: { eq: assigneeId } }, first: 1 }, edges: { node: { id: true } } },
    });
    if (nodesOf(member.workspaceMembers).length === 0) {
      throw new HttpError(400, 'Unknown workspace member');
    }
  }

  const result = await client.mutation({
    updateWhatsappConversation: {
      __args: {
        id: conversationId,
        data: {
          ...(status !== undefined ? { status } : {}),
          ...(assigneeId !== undefined ? { assigneeId } : {}),
        },
      },
      ...CONVERSATION_FIELDS,
    },
  });

  return { conversation: result.updateWhatsappConversation as Conversation };
});

export default defineLogicFunction({
  universalIdentifier: '35bcb929-2131-4e52-96d8-9eb92ca06d88',
  name: 'whatsapp-conversation-update',
  description: 'Assign a WhatsApp conversation to a workspace member, or open or close it.',
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/conversations/update',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
