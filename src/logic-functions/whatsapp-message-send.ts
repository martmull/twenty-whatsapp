import { defineLogicFunction } from 'twenty-sdk/define';

import { bridgeFetch, bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import { applicationClient, findMessageByRequestId, MESSAGE_FIELDS, userClient, type Message } from 'src/logic-functions/message-data';
import { HttpError, requireUser, route } from 'src/logic-functions/utils/route';
import { digits, isChatId, isUuid } from 'src/logic-functions/utils/validators';

type Attachment = { fileId: string; label: string; mimeType: string; size: number };
type SendRequest = { conversationId?: string; requestId?: string; text?: string; attachment?: Attachment };
type SendReceipt = { state: 'unknown' | 'sent'; eventId?: string };

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

const mediaKindForMimeType = (mimeType: string): 'image' | 'video' | 'document' =>
  ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType) ? 'image'
    : ['video/mp4', 'video/quicktime', 'video/3gpp'].includes(mimeType) ? 'video'
      : 'document';

const PLACEHOLDER_TEXT = { image: '[Image]', video: '[Video]', document: '[File]' } as const;

const isValidAttachment = (attachment: Attachment) =>
  isUuid(attachment.fileId) &&
  Boolean(attachment.label) && attachment.label.length <= 255 && !/[/\\\u0000-\u001f]/.test(attachment.label) &&
  /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) &&
  Number.isSafeInteger(attachment.size) && attachment.size >= 1 && attachment.size <= MAX_MEDIA_BYTES;

// Downloads a file the user uploaded to the message Media field, from the signed URL Twenty returned.
export const downloadAttachment = async (attachment: Attachment, signedUrl: string): Promise<Buffer> => {
  const url = new URL(signedUrl);
  const validFilePath = [`/file/FilesField/${attachment.fileId}`, `/file/files-field/${attachment.fileId}`].includes(url.pathname);

  if (!validFilePath || !url.searchParams.get('token')) {
    throw new Error('Invalid attachment URL');
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });

  if (!response.ok || !response.body) throw new Error('Attachment is unavailable');

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

const sendToBridge = async (message: Message, chatId: string, accountPhoneNumber: string, caption: string, attachment?: Attachment): Promise<SendReceipt> => {
  if (!attachment) {
    return bridgePost<SendReceipt>('/send', { requestId: message.requestId, chatId, text: caption, accountPhoneNumber });
  }

  const signedUrl = message.media?.[0]?.url;
  if (!signedUrl) throw new HttpError(409, 'Attachment is unavailable');

  const bytes = await downloadAttachment(attachment, signedUrl);
  const metadata = { requestId: message.requestId, chatId, accountPhoneNumber, kind: mediaKindForMimeType(attachment.mimeType), mimeType: attachment.mimeType, fileName: attachment.label, caption };
  const response = await bridgeFetch('/send/media', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-whatsapp-media': Buffer.from(JSON.stringify(metadata)).toString('base64') },
    body: new Uint8Array(bytes).buffer,
  }, 120_000);

  return (await response.json()) as SendReceipt;
};

// Sends one text or file. The request ID makes retries safe: a message is never sent twice.
const handler = route<SendRequest>('whatsapp-message-send', async (event, logger) => {
  requireUser(event);
  const { conversationId, requestId, text, attachment } = event.body ?? {};

  if (!isUuid(conversationId) || !isUuid(requestId) || typeof text !== 'string' || text.length > 4096 ||
    (!attachment && !text.trim()) || (attachment && !isValidAttachment(attachment))) {
    throw new HttpError(400, 'Invalid message');
  }

  const mediaKind = attachment ? mediaKindForMimeType(attachment.mimeType) : undefined;
  const messageText = text.trim() || (mediaKind ? PLACEHOLDER_TEXT[mediaKind] : '');

  // Reading as the user checks they may see this conversation.
  const visible = await userClient().query({
    whatsappConversations: {
      __args: { filter: { id: { eq: conversationId } }, first: 1 },
      edges: { node: { id: true, chatId: true, accountId: true } },
    },
  });
  const conversation = visible.whatsappConversations?.edges?.[0]?.node;

  if (!conversation || !isChatId(conversation.chatId)) {
    throw new HttpError(404, 'Conversation not found');
  }

  const client = applicationClient();
  const [status, account] = await Promise.all([
    getBridgeStatus(),
    client.query({
      whatsappAccounts: {
        __args: { filter: { id: { eq: conversation.accountId ?? '' } }, first: 1 },
        edges: { node: { phoneNumber: true } },
      },
    }),
  ]);
  const accountPhoneNumber = status.phoneNumber ? `+${digits(status.phoneNumber)}` : undefined;

  if (status.state !== 'connected' || !accountPhoneNumber) {
    throw new HttpError(409, 'WhatsApp is disconnected');
  }

  if (account.whatsappAccounts?.edges?.[0]?.node?.phoneNumber !== accountPhoneNumber) {
    throw new HttpError(409, 'This conversation belongs to a different WhatsApp account');
  }

  let message = await findMessageByRequestId(client, requestId);

  if (message && (message.conversationId !== conversationId || message.text !== messageText || message.media?.[0]?.fileId !== attachment?.fileId)) {
    throw new HttpError(409, 'Request ID already used');
  }

  if (!message) {
    const created = await client.mutation({
      createWhatsappMessage: {
        __args: {
          data: {
            name: messageText.slice(0, 80),
            conversationId,
            direction: 'OUTBOUND',
            text: messageText,
            sentAt: new Date().toISOString(),
            deliveryState: 'UNKNOWN',
            requestId,
            ...(attachment ? { mediaKind: mediaKind!.toUpperCase(), media: [{ fileId: attachment.fileId, label: attachment.label }] } : {}),
          },
        },
        ...MESSAGE_FIELDS,
      },
    });
    message = created.createWhatsappMessage as Message | undefined;
    if (!message) throw new Error('Could not store outgoing message');
  }

  if (message.deliveryState === 'SENT') {
    return { messageId: message.id, state: 'sent' as const };
  }

  const receipt = await sendToBridge(message, conversation.chatId, accountPhoneNumber, text, attachment);
  logger.info('Message sent to bridge', { messageId: message.id, state: receipt.state, hasAttachment: Boolean(attachment) });

  if (receipt.state === 'sent') {
    await client.mutation({
      updateWhatsappMessage: { __args: { id: message.id, data: { deliveryState: 'SENT', externalId: receipt.eventId } }, id: true },
    });
    await client.mutation({
      updateWhatsappConversation: { __args: { id: conversationId, data: { lastMessageAt: new Date().toISOString(), lastPreview: messageText.slice(0, 160) } }, id: true },
    });
    await bridgePost('/events/notify').catch(() => undefined);
  }

  return { messageId: message.id, state: receipt.state };
});

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
