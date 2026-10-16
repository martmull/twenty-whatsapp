import { defineLogicFunction, type RoutePayload } from 'twenty-sdk/define';

import { bridgeFetch, bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { applicationClient, findMessageByRequestId, userClient } from 'src/logic-functions/message-data';

type Attachment = { fileId: string; label: string; mimeType: string; size: number };
type SendRequest = { conversationId?: string; requestId?: string; text?: string; attachment?: Attachment };
type SendReceipt = { state: 'unknown' | 'sent'; eventId?: string };
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const mediaKindForMimeType = (mimeType: string): 'image' | 'video' | 'document' =>
  ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType) ? 'image'
    : ['video/mp4', 'video/quicktime', 'video/3gpp'].includes(mimeType) ? 'video'
      : 'document';

export const downloadAttachment = async (attachment: Attachment, signedUrl: string): Promise<Buffer> => {
  const url = new URL(signedUrl);
  const validFilePath = [`/file/FilesField/${attachment.fileId}`, `/file/files-field/${attachment.fileId}`].includes(url.pathname);
  if (!validFilePath || !url.searchParams.get('token')) {
    throw new Error('Invalid attachment URL');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok || !response.body) throw new Error('Attachment is unavailable');
  const claimedSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(claimedSize) && claimedSize > MAX_MEDIA_BYTES) {
    await response.body.cancel();
    throw new Error('Attachment is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MEDIA_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Attachment is too large');
    }
    chunks.push(Buffer.from(value));
  }
  if (size !== attachment.size) throw new Error('Attachment size changed');
  return Buffer.concat(chunks, size);
};

const sendAttachment = async (requestId: string, chatId: string, accountPhoneNumber: string, caption: string, attachment: Attachment, signedUrl: string): Promise<SendReceipt> => {
  const bytes = await downloadAttachment(attachment, signedUrl);
  const kind = mediaKindForMimeType(attachment.mimeType);
  const metadata = Buffer.from(JSON.stringify({ requestId, chatId, accountPhoneNumber, kind, mimeType: attachment.mimeType, fileName: attachment.label, caption })).toString('base64');
  const response = await bridgeFetch('/send/media', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-whatsapp-media': metadata },
    body: new Uint8Array(bytes).buffer,
  }, 120_000);
  return await response.json() as SendReceipt;
};

const handler = async (event: RoutePayload<SendRequest>) => {
  if (!event.userWorkspaceId) {
    throw new Error('Authentication required');
  }

  const { conversationId, requestId, text, attachment } = event.body ?? {};

  if (!conversationId || !/^[a-f\d-]{36}$/i.test(conversationId) || !requestId || !/^[a-f\d-]{36}$/i.test(requestId) || typeof text !== 'string' || text.length > 4096 || (!attachment && !text.trim()) ||
    (attachment && (!/^[a-f\d-]{36}$/i.test(attachment.fileId) || !attachment.label || attachment.label.length > 255 || /[/\\\u0000-\u001f]/.test(attachment.label) ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX_MEDIA_BYTES))) {
    throw new Error('Invalid message');
  }
  const caption = text ?? '';
  const mediaKind = attachment ? mediaKindForMimeType(attachment.mimeType) : undefined;
  const messageText = caption.trim() || (mediaKind === 'image' ? '[Image]' : mediaKind === 'video' ? '[Video]' : mediaKind === 'document' ? '[File]' : '');

  const visible = await userClient().query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: { id: true, chatId: true, accountId: true } },
    },
  });
  const conversation = visible.whatsappConversations?.edges?.[0]?.node;
  const chatId = conversation?.chatId;

  if (!conversation || !chatId || (!/^\d{7,15}@s\.whatsapp\.net$/.test(chatId) && !/^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(chatId))) {
    throw new Error('Conversation unavailable');
  }

  const status = await getBridgeStatus();

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

  if (message && (message.conversationId !== conversationId || message.text !== messageText || (message.media?.[0]?.fileId ?? undefined) !== attachment?.fileId)) {
    throw new Error('Request ID already used');
  }

  if (!message) {
    const created = await client.mutation({
      createWhatsappMessage: {
        __args: { data: { name: messageText.slice(0, 80), conversationId, direction: 'OUTBOUND', text: messageText, sentAt: new Date().toISOString(), deliveryState: 'UNKNOWN', requestId, ...(attachment ? { mediaKind: mediaKind!.toUpperCase(), media: [{ fileId: attachment.fileId, label: attachment.label }] } : {}) } },
        id: true,
      },
    });
    const id = created.createWhatsappMessage?.id;

    if (!id) {
      throw new Error('Could not store outgoing message');
    }

    message = await findMessageByRequestId(client, requestId);
    if (!message) throw new Error('Could not load outgoing message');
  }

  if (message.deliveryState === 'SENT') {
    return { messageId: message.id, state: 'sent' as const };
  }

  if (attachment && !message.media?.[0]?.url) throw new Error('Attachment is unavailable');

  const receipt = attachment
    ? await sendAttachment(requestId, chatId, `+${connectedPhoneNumber}`, caption, attachment, message.media![0].url!)
    : await bridgePost<SendReceipt>('/send', { requestId, chatId, text: caption, accountPhoneNumber: `+${connectedPhoneNumber}` });

  if (receipt.state === 'sent') {
    await client.mutation({
      updateWhatsappMessage: {
        __args: { id: message.id, data: { deliveryState: 'SENT', externalId: receipt.eventId } },
        id: true,
      },
    });
    await client.mutation({
      updateWhatsappConversation: {
        __args: { id: conversationId, data: { lastMessageAt: new Date().toISOString(), lastPreview: messageText.slice(0, 160) } },
        id: true,
      },
    });
    await bridgePost('/events/notify').catch(() => undefined);
  }

  return { messageId: message.id, state: receipt.state };
};

export default defineLogicFunction({
  universalIdentifier: '9d76e546-352a-4cf1-bd64-92d36c653b6a',
  name: 'whatsapp-message-send',
  description: 'Send one manual text or file message with a stable request ID.',
  timeoutSeconds: 180,
  handler,
  httpRouteTriggerSettings: {
    path: '/whatsapp/messages/send',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
