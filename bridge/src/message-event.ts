import { createHash } from 'node:crypto';

import type { WAMessage } from '@whiskeysockets/baileys';

export type MessageEvent = {
  eventId: string;
  chatId: string;
  providerMessageId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  sentAt: string;
  senderId?: string;
  senderName?: string;
};

export const isGroupChatId = (chatId: string): boolean => /^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(chatId);
export const isDirectChatId = (chatId: string): boolean => /^\d{7,15}@s\.whatsapp\.net$/.test(chatId);
export const isSupportedChatId = (chatId: string): boolean => isDirectChatId(chatId) || isGroupChatId(chatId);

export const messageEventId = (chatId: string, providerMessageId: string): string =>
  createHash('sha256').update(`${chatId}:${providerMessageId}`).digest('hex');

export const toMessageEvent = (message: WAMessage, mappedChatId?: string): MessageEvent | undefined => {
  const remoteJid = message.key.remoteJid;
  const chatId = remoteJid?.endsWith('@lid')
    ? message.key.fromMe ? mappedChatId : message.key.senderPn ?? mappedChatId
    : remoteJid;
  const providerMessageId = message.key.id;
  const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;

  if (
    !chatId || !isSupportedChatId(chatId) ||
    !providerMessageId || !text || text.length > 4096
  ) {
    return undefined;
  }

  const seconds = Number(message.messageTimestamp ?? 0);

  return {
    eventId: messageEventId(chatId, providerMessageId),
    chatId,
    providerMessageId,
    direction: message.key.fromMe ? 'outbound' : 'inbound',
    text,
    sentAt: new Date(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now()).toISOString(),
    ...(isGroupChatId(chatId) && !message.key.fromMe && message.key.participant ? { senderId: message.key.participant } : {}),
    ...(isGroupChatId(chatId) && !message.key.fromMe && message.pushName ? { senderName: message.pushName.slice(0, 120) } : {}),
  };
};
