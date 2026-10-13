import { createHash } from 'node:crypto';

import type { WAMessage } from '@whiskeysockets/baileys';

export type InboundMessageEvent = {
  eventId: string;
  chatId: string;
  providerMessageId: string;
  text: string;
  sentAt: string;
};

export const toInboundMessageEvent = (message: WAMessage): InboundMessageEvent | undefined => {
  const chatId = message.key.remoteJid;
  const providerMessageId = message.key.id;
  const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;

  if (
    message.key.fromMe ||
    !chatId || !/^\d{7,15}@s\.whatsapp\.net$/.test(chatId) ||
    !providerMessageId || !text || text.length > 4096
  ) {
    return undefined;
  }

  const seconds = Number(message.messageTimestamp ?? 0);

  return {
    eventId: createHash('sha256').update(`${chatId}:${providerMessageId}`).digest('hex'),
    chatId,
    providerMessageId,
    text,
    sentAt: new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now()).toISOString(),
  };
};
