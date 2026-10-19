export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d-]{36}$/i.test(value);

export const isEventId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{64}$/.test(value);

export const isDirectChatId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{7,15}@s\.whatsapp\.net$/.test(value);

export const isGroupChatId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{7,20}(?:-\d{1,20})?@g\.us$/.test(value);

// A person's WhatsApp identity: a phone-number ID or a LID, as a group message sender may have.
export const isContactId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{7,15}@(?:s\.whatsapp\.net|lid)$/.test(value);

export const isChatId = (value: unknown): value is string => isDirectChatId(value) || isGroupChatId(value);

export const digits = (value: string) => value.replace(/\D/g, '');

// The phone number part of a direct chat ID, e.g. 33612345678 for 33612345678@s.whatsapp.net.
export const chatNumber = (chatId: string) => chatId.split('@')[0];

export const isPhoneLikeName = (name: string) => /^\+?\d+$/.test(name.trim());
