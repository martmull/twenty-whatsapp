import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import makeWASocket, { Browsers, DisconnectReason, type Chat, type Contact, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { toDataURL } from 'qrcode';

import { createEncryptedAuthState } from './encrypted-auth-state.js';
import { EncryptedJsonStore } from './encrypted-json-store.js';
import { isDirectChatId, isGroupChatId, isSupportedChatId, messageEventId, toMessageEvent, type MessageEvent } from './message-event.js';

export type ConnectionStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

export type SendReceipt = {
  requestId: string;
  state: 'unknown' | 'sent';
  providerMessageId?: string;
  eventId?: string;
};

export type HistoryChat = {
  chatId: string;
  name?: string;
  messages: MessageEvent[];
};

export type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
};

export class WhatsAppConnection {
  private socket: WASocket | undefined;
  private status: ConnectionStatus = { state: 'disconnected' };
  private generation = 0;
  private intentionallyDisconnected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly events: EncryptedJsonStore<MessageEvent>;
  private readonly sends: EncryptedJsonStore<SendReceipt>;
  private readonly phoneNumbers: EncryptedJsonStore<{ chatId: string }>;
  private readonly historyChats: EncryptedJsonStore<HistoryChat>;
  private readonly historyState: EncryptedJsonStore<{ receivedAt: string }>;
  private historyWrites: Promise<void> = Promise.resolve();
  private readonly sendingRequests = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.events = new EncryptedJsonStore(join(directory, 'events'), encryptionKey);
    this.sends = new EncryptedJsonStore(join(directory, 'sends'), encryptionKey);
    this.phoneNumbers = new EncryptedJsonStore(join(directory, 'phone-numbers'), encryptionKey);
    this.historyChats = new EncryptedJsonStore(join(directory, 'history-chats'), encryptionKey);
    this.historyState = new EncryptedJsonStore(join(directory, 'history-state'), encryptionKey);
  }

  async recordHistory(contacts: Contact[], messages: WAMessage[], fromHistorySync = false, chats: Chat[] = []): Promise<void> {
    const write = async () => {
      for (const contact of contacts) {
        if (contact.lid && contact.jid && /^\d{7,15}@lid$/.test(contact.lid) && /^\d{7,15}@s\.whatsapp\.net$/.test(contact.jid)) {
          await this.phoneNumbers.write(contact.lid, { chatId: contact.jid });
        }
      }

      const byChat = new Map<string, { name?: string; messages: MessageEvent[] }>();

      for (const chat of chats) {
        if (chat.id && isSupportedChatId(chat.id)) {
          byChat.set(chat.id, { name: chat.name?.slice(0, 120) || undefined, messages: [] });
        }
      }

      for (const contact of contacts) {
        const chatId = contact.jid ?? (contact.id.endsWith('@lid') ? (await this.phoneNumbers.read(contact.id))?.chatId : contact.id);

        if (chatId && isSupportedChatId(chatId)) {
          const candidate = byChat.get(chatId!) ?? { messages: [] };
          candidate.name = (contact.name || contact.notify || contact.verifiedName || candidate.name)?.slice(0, 120);
          byChat.set(chatId!, candidate);
        }
      }

      for (const message of messages) {
        const timestamp = Number(message.messageTimestamp ?? 0);

        if (!Number.isFinite(timestamp) || timestamp <= 0) {
          continue;
        }

        const remoteJid = message.key.remoteJid;
        const mappedChatId = remoteJid?.endsWith('@lid') ? (await this.phoneNumbers.read(remoteJid))?.chatId : undefined;
        const item = toMessageEvent(message, mappedChatId);

        if (!item || item.chatId.split('@')[0] === this.status.phoneNumber?.replace(/\D/g, '')) {
          continue;
        }

        const candidate = byChat.get(item.chatId) ?? { messages: [] };
        if (isDirectChatId(item.chatId) && !message.key.fromMe && message.pushName && !candidate.name) {
          candidate.name = message.pushName.slice(0, 120);
        }
        candidate.messages.push(item);
        byChat.set(item.chatId, candidate);
      }

      for (const [chatId, candidate] of byChat) {
        const existing = await this.historyChats.read(chatId);
        const messagesById = new Map((existing?.messages ?? []).map((message) => [message.eventId, message]));

        for (const message of candidate.messages) {
          messagesById.set(message.eventId, message);
        }

        await this.historyChats.write(chatId, {
          chatId,
          name: candidate.name ?? existing?.name,
          messages: [...messagesById.values()].sort((left, right) => left.sentAt.localeCompare(right.sentAt) || left.eventId.localeCompare(right.eventId)),
        });
      }

      if (fromHistorySync && messages.length > 0) {
        await this.historyState.write('latest', { receivedAt: new Date().toISOString() });
      }
    };

    this.historyWrites = this.historyWrites.then(write, write);
    await this.historyWrites;
  }

  async getHistoryCandidates(rangeDays: 0 | 30 | 90, offset: number, limit: number, kind: 'all' | 'direct' | 'group' = 'all'): Promise<{ items: HistoryCandidate[]; total: number; historyReceivedAt?: string }> {
    await this.historyWrites;
    const since = rangeDays ? Date.now() - rangeDays * 86_400_000 : 0;
    const chats = await this.historyChats.list();
    const candidates = chats.flatMap((chat) => {
      if (kind !== 'all' && (isGroupChatId(chat.chatId) ? 'group' : 'direct') !== kind) {
        return [];
      }
      if (chat.chatId.split('@')[0] === this.status.phoneNumber?.replace(/\D/g, '')) {
        return [];
      }

      const messages = chat.messages.filter((message) => Date.parse(message.sentAt) >= since);

      if (chat.messages.length > 0 && messages.length === 0) {
        return [];
      }

      return [{
        chatId: chat.chatId,
        kind: isGroupChatId(chat.chatId) ? 'group' as const : 'direct' as const,
        name: chat.name || (isGroupChatId(chat.chatId) ? chat.chatId.split('@')[0] : `+${chat.chatId.split('@')[0]}`),
        messageCount: messages.length,
        lastMessageAt: messages.at(-1)?.sentAt,
      }];
    }).sort((left, right) => (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? '') || left.chatId.localeCompare(right.chatId));

    return {
      items: candidates.slice(offset, offset + limit),
      total: candidates.length,
      historyReceivedAt: (await this.historyState.read('latest'))?.receivedAt,
    };
  }

  async getHistoryMessages(chatId: string, rangeDays: 0 | 30 | 90, offset: number, limit: number): Promise<{ name: string; messages: MessageEvent[]; total: number; nextOffset?: number }> {
    if (!isSupportedChatId(chatId)) {
      throw new Error('Invalid chat ID');
    }

    await this.historyWrites;
    const chat = await this.historyChats.read(chatId);

    if (!chat) {
      throw new Error('History chat unavailable');
    }

    const since = rangeDays ? Date.now() - rangeDays * 86_400_000 : 0;
    const messages = chat.messages.filter((message) => Date.parse(message.sentAt) >= since);
    const nextOffset = offset + limit < messages.length ? offset + limit : undefined;

    return {
      name: chat.name || (isGroupChatId(chatId) ? chatId.split('@')[0] : `+${chatId.split('@')[0]}`),
      messages: messages.slice(offset, offset + limit),
      total: messages.length,
      nextOffset,
    };
  }

  async getEvents(): Promise<MessageEvent[]> {
    return this.events.list(100);
  }

  async ackEvents(eventIds: string[]): Promise<{ acknowledged: number }> {
    for (const eventId of eventIds) {
      if (!/^[a-f\d]{64}$/.test(eventId)) {
        throw new Error('Invalid event ID');
      }

      await this.events.delete(eventId);
    }

    return { acknowledged: eventIds.length };
  }

  async sendText(requestId: string, chatId: string, text: string, accountPhoneNumber: string): Promise<SendReceipt> {
    if (
      !/^[a-f\d-]{36}$/i.test(requestId) ||
      !isSupportedChatId(chatId) ||
      !/^\+\d{7,15}$/.test(accountPhoneNumber) ||
      text.trim().length === 0 || text.length > 4096
    ) {
      throw new Error('Invalid send request');
    }

    if (this.sendingRequests.has(requestId)) {
      return { requestId, state: 'unknown' };
    }

    this.sendingRequests.add(requestId);

    try {
      const existing = await this.sends.read(requestId);

      if (existing) {
        return existing;
      }

      if (!this.socket || this.status.state !== 'connected') {
        throw new Error('WhatsApp is disconnected');
      }

      if (`+${this.status.phoneNumber?.replace(/\D/g, '')}` !== accountPhoneNumber) {
        throw new Error('WhatsApp account changed');
      }

      const pending: SendReceipt = { requestId, state: 'unknown' };
      await this.sends.write(requestId, pending);
      const sent = await this.socket.sendMessage(chatId, { text });
      const receipt: SendReceipt = {
        requestId,
        state: 'sent',
        providerMessageId: sent?.key.id ?? undefined,
        eventId: sent?.key.id ? messageEventId(chatId, sent.key.id) : undefined,
      };
      await this.sends.write(requestId, receipt);
      return receipt;
    } finally {
      this.sendingRequests.delete(requestId);
    }
  }

  getStatus(): ConnectionStatus {
    if (this.status.qrExpiresAt && this.status.qrExpiresAt < Date.now()) {
      return { state: 'pairing' };
    }

    return this.status;
  }

  async resume(): Promise<void> {
    const { state } = await createEncryptedAuthState(this.directory, this.encryptionKey);

    if (state.creds.me?.id) {
      await this.connect();
    }
  }

  async connect(): Promise<ConnectionStatus> {
    if (this.socket) {
      return this.getStatus();
    }

    this.intentionallyDisconnected = false;
    this.status = { state: 'pairing' };
    const generation = ++this.generation;
    const { state, saveCreds } = await createEncryptedAuthState(
      this.directory,
      this.encryptionKey,
    );
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      // WhatsApp rejects Baileys' Desktop identity before it can emit a pairing QR.
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      emitOwnEvents: false,
    });

    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('messages.upsert', async ({ messages }) => {
      if (generation !== this.generation) {
        return;
      }

      for (const message of messages) {
        const remoteJid = message.key.remoteJid;
        const mappedChatId = remoteJid?.endsWith('@lid')
          ? (await this.phoneNumbers.read(remoteJid))?.chatId
          : undefined;
        const event = toMessageEvent(message, mappedChatId);

        if (event) {
          if (remoteJid?.endsWith('@lid') && !message.key.fromMe) {
            await this.phoneNumbers.write(remoteJid, { chatId: event.chatId });
          }
          await this.events.write(event.eventId, event);
        }
      }
      await this.recordHistory([], messages);
    });
    socket.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
      if (generation === this.generation) {
        await this.recordHistory(contacts, messages, true, chats);
      }
    });
    socket.ev.on('chats.upsert', async (chats) => {
      if (generation === this.generation) {
        await this.recordHistory([], [], false, chats);
      }
    });
    socket.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
      if (generation === this.generation && /^\d{7,15}@lid$/.test(lid) && /^\d{7,15}@s\.whatsapp\.net$/.test(jid)) {
        await this.phoneNumbers.write(lid, { chatId: jid });
      }
    });
    socket.ev.on('contacts.upsert', async (contacts) => {
      if (generation !== this.generation) {
        return;
      }

      for (const contact of contacts) {
        if (contact.lid && contact.jid && /^\d{7,15}@lid$/.test(contact.lid) && /^\d{7,15}@s\.whatsapp\.net$/.test(contact.jid)) {
          await this.phoneNumbers.write(contact.lid, { chatId: contact.jid });
        }
      }
      await this.recordHistory(contacts, []);
    });
    socket.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (generation !== this.generation) {
        return;
      }

      if (qr) {
        this.status = {
          state: 'pairing',
          qrDataUrl: await toDataURL(qr, { margin: 1, width: 248 }),
          qrExpiresAt: Date.now() + 60_000,
        };
      }

      if (connection === 'open') {
        this.status = {
          state: 'connected',
          phoneNumber: socket.user?.id?.split(':')[0],
        };
        void socket.groupFetchAllParticipating().then((groups) => {
          if (generation === this.generation) {
            return this.recordHistory(Object.values(groups).map((group) => ({ id: group.id, name: group.subject })), []);
          }
        }).catch(() => undefined);
      }

      if (connection === 'close') {
        this.socket = undefined;
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;

        if (this.intentionallyDisconnected || statusCode === DisconnectReason.loggedOut) {
          this.status = { state: 'disconnected' };
          return;
        }

        this.status = { state: 'reconnecting' };
        this.reconnectTimer = setTimeout(() => void this.connect(), 5_000);
      }
    });

    return this.getStatus();
  }

  async disconnect(): Promise<ConnectionStatus> {
    this.intentionallyDisconnected = true;
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.status = { state: 'disconnected' };

    try {
      await socket?.logout();
    } catch {
      // Local credentials still need deletion when the remote logout fails.
    }

    await this.historyWrites.catch(() => undefined);
    await rm(this.directory, { recursive: true, force: true });

    return this.status;
  }
}
