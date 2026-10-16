import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import makeWASocket, { Browsers, DisconnectReason, generateMessageIDV2, proto, type AnyMediaMessageContent, type Chat, type Contact, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { toDataURL } from 'qrcode';

import { createEncryptedAuthState } from './encrypted-auth-state.js';
import { EncryptedJsonStore } from './encrypted-json-store.js';
import { describeMedia, downloadMedia, type MediaReference } from './media.js';
import { isDirectChatId, isGroupChatId, isSupportedChatId, messageChatId, messageEventId, toMessageEvent, type MessageEvent } from './message-event.js';

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
  lastMessageAt?: string;
  messages: MessageEvent[];
};

export type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
};

export type GroupMember = {
  id: string;
  phoneNumber?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  isMe?: boolean;
};

export class WhatsAppConnection {
  private socket: WASocket | undefined;
  private status: ConnectionStatus = { state: 'disconnected' };
  private generation = 0;
  private intentionallyDisconnected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly events: EncryptedJsonStore<MessageEvent>;
  private readonly sends: EncryptedJsonStore<SendReceipt>;
  private readonly sentMessages: EncryptedJsonStore<{ encodedMessage: string }>;
  private readonly phoneNumbers: EncryptedJsonStore<{ chatId: string }>;
  private readonly contactNames: EncryptedJsonStore<{ name: string }>;
  private readonly historyChats: EncryptedJsonStore<HistoryChat>;
  private readonly historyState: EncryptedJsonStore<{ receivedAt: string }>;
  private readonly mediaReferences: EncryptedJsonStore<MediaReference>;
  private readonly groupMembersCache = new Map<string, { expiresAt: number; members: GroupMember[] }>();
  private readonly pendingGroupNameLookups = new Set<string>();
  private readonly groupNameLookupQueue: string[] = [];
  private activeGroupNameLookups = 0;
  private historyWrites: Promise<void> = Promise.resolve();
  private readonly sendingRequests = new Set<string>();
  private readonly sendingMessageIds = new Set<string>();
  private ackedSinceClaim = 0;
  private syncLease: { id: string; expiresAt: number } | undefined;

  constructor(
    private readonly directory: string,
    private readonly encryptionKey: Buffer,
    // Called when Twenty should import queued events (see the bridge webhook in server.ts).
    private readonly onEventsQueued: () => void = () => undefined,
  ) {
    this.events = new EncryptedJsonStore(join(directory, 'events'), encryptionKey);
    this.sends = new EncryptedJsonStore(join(directory, 'sends'), encryptionKey);
    this.sentMessages = new EncryptedJsonStore(join(directory, 'sent-messages'), encryptionKey);
    this.phoneNumbers = new EncryptedJsonStore(join(directory, 'phone-numbers'), encryptionKey);
    this.contactNames = new EncryptedJsonStore(join(directory, 'contact-names'), encryptionKey);
    this.historyChats = new EncryptedJsonStore(join(directory, 'history-chats'), encryptionKey);
    this.historyState = new EncryptedJsonStore(join(directory, 'history-state'), encryptionKey);
    this.mediaReferences = new EncryptedJsonStore(join(directory, 'media-references'), encryptionKey);
  }

  async recordHistory(contacts: Contact[], messages: WAMessage[], fromHistorySync = false, chats: Chat[] = []): Promise<void> {
    const write = async () => {
      let namesChanged = false;
      for (const contact of contacts) {
        if (contact.lid && contact.jid && /^\d{7,15}@lid$/.test(contact.lid) && /^\d{7,15}@s\.whatsapp\.net$/.test(contact.jid)) {
          await this.phoneNumbers.write(contact.lid, { chatId: contact.jid });
        }
        const name = (contact.name || contact.notify || contact.verifiedName)?.trim().slice(0, 120);
        if (name) {
          for (const id of [contact.id, contact.lid, contact.jid].filter((value): value is string => Boolean(value))) {
            if ((await this.contactNames.read(id))?.name !== name) {
              await this.contactNames.write(id, { name });
              namesChanged = true;
            }
          }
        }
      }

      const byChat = new Map<string, { name?: string; lastMessageAt?: string; messages: MessageEvent[] }>();

      for (const chat of chats) {
        if (chat.id && isSupportedChatId(chat.id)) {
          const seconds = Math.max(Number(chat.conversationTimestamp ?? 0), Number(chat.lastMessageRecvTimestamp ?? 0));
          const lastMessageAt = Number.isFinite(seconds) && seconds > 0 && seconds < 8_640_000_000_000
            ? new Date(seconds * 1000).toISOString()
            : undefined;
          byChat.set(chat.id, { name: chat.name?.slice(0, 120) || undefined, lastMessageAt, messages: [] });
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

        if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp >= 8_640_000_000_000) {
          continue;
        }

        const remoteJid = message.key.remoteJid;
        if (remoteJid && isGroupChatId(remoteJid) && message.key.participant && message.pushName?.trim()) {
          const name = message.pushName.trim().slice(0, 120);
          if ((await this.contactNames.read(message.key.participant))?.name !== name) {
            await this.contactNames.write(message.key.participant, { name });
            namesChanged = true;
          }
          if (message.key.participantPn && isDirectChatId(message.key.participantPn)) {
            if ((await this.contactNames.read(message.key.participantPn))?.name !== name) {
              await this.contactNames.write(message.key.participantPn, { name });
              namesChanged = true;
            }
            if (message.key.participant.endsWith('@lid')) {
              await this.phoneNumbers.write(message.key.participant, { chatId: message.key.participantPn });
            }
          }
        }
        const mappedChatId = remoteJid?.endsWith('@lid') ? (await this.phoneNumbers.read(remoteJid))?.chatId : undefined;
        const chatId = messageChatId(message, mappedChatId);

        if (!chatId || !isSupportedChatId(chatId) || chatId.split('@')[0] === this.status.phoneNumber?.replace(/\D/g, '')) {
          continue;
        }

        if (message.key.id) {
          const eventId = messageEventId(chatId, message.key.id);
          const media = describeMedia(message, eventId);
          if (media?.reference) {
            await this.mediaReferences.write(eventId, media.reference);
          }
        }

        const candidate = byChat.get(chatId) ?? { messages: [] };
        const sentAt = new Date(timestamp * 1000).toISOString();
        if (!candidate.lastMessageAt || sentAt > candidate.lastMessageAt) {
          candidate.lastMessageAt = sentAt;
        }
        if (isDirectChatId(chatId) && !message.key.fromMe && message.pushName && !candidate.name) {
          candidate.name = message.pushName.slice(0, 120);
        }
        const item = toMessageEvent(message, mappedChatId);
        if (item) {
          candidate.messages.push(item);
        }
        byChat.set(chatId, candidate);
      }

      for (const [chatId, candidate] of byChat) {
        const existing = await this.historyChats.read(chatId);
        if (isDirectChatId(chatId) && (!candidate.name || /^\+?\d+$/.test(candidate.name))) {
          candidate.name = (await this.contactNames.read(chatId))?.name ?? candidate.name;
        }
        const messagesById = new Map((existing?.messages ?? []).map((message) => [message.eventId, message]));

        for (const message of candidate.messages) {
          messagesById.set(message.eventId, message);
        }

        const name = candidate.name ?? existing?.name;
        if (name && name !== existing?.name) {
          namesChanged = true;
        }
        await this.historyChats.write(chatId, {
          chatId,
          name,
          lastMessageAt: [candidate.lastMessageAt, existing?.lastMessageAt, existing?.messages.at(-1)?.sentAt].filter((value): value is string => Boolean(value)).sort().at(-1),
          messages: [...messagesById.values()].sort((left, right) => left.sentAt.localeCompare(right.sentAt) || left.eventId.localeCompare(right.eventId)),
        });
      }

      if (fromHistorySync && messages.length > 0) {
        await this.historyState.write('latest', { receivedAt: new Date().toISOString() });
      }
      if (namesChanged) {
        this.groupMembersCache.clear();
      }
    };

    this.historyWrites = this.historyWrites.then(write, write);
    await this.historyWrites;
  }

  async getHistoryNames(chatIds: string[]): Promise<{ chatId: string; name: string }[]> {
    await this.historyWrites;
    const names: { chatId: string; name: string }[] = [];

    for (const chatId of chatIds) {
      if (!isSupportedChatId(chatId)) {
        throw new Error('Invalid chat ID');
      }
      const saved = await this.historyChats.read(chatId);
      if (!saved) {
        continue;
      }
      const name = saved.name || (isGroupChatId(chatId) ? chatId.split('@')[0] : `+${chatId.split('@')[0]}`);
      if (isGroupChatId(chatId) && /^\+?\d+$/.test(name)) {
        this.scheduleGroupNameLookup(chatId);
      }
      names.push({ chatId, name });
    }

    return names;
  }

  private scheduleGroupNameLookup(chatId: string): void {
    if (this.status.state !== 'connected' || !this.socket || this.pendingGroupNameLookups.has(chatId)) {
      return;
    }
    this.pendingGroupNameLookups.add(chatId);
    this.groupNameLookupQueue.push(chatId);
    this.drainGroupNameLookups();
  }

  private drainGroupNameLookups(): void {
    while (this.activeGroupNameLookups < 3 && this.groupNameLookupQueue.length > 0) {
      const chatId = this.groupNameLookupQueue.shift()!;
      const socket = this.socket;
      const generation = this.generation;
      if (!socket) {
        this.pendingGroupNameLookups.delete(chatId);
        continue;
      }
      this.activeGroupNameLookups += 1;
      void socket.groupMetadata(chatId).then(async (metadata) => {
        if (generation === this.generation && metadata.subject?.trim()) {
          await this.recordHistory([{ id: chatId, name: metadata.subject }], []);
        }
      }).catch(() => undefined).finally(() => {
        this.pendingGroupNameLookups.delete(chatId);
        this.activeGroupNameLookups -= 1;
        this.drainGroupNameLookups();
      });
    }
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
      const lastMessageAt = chat.lastMessageAt ?? chat.messages.at(-1)?.sentAt;

      if (lastMessageAt && Date.parse(lastMessageAt) < since) {
        return [];
      }

      return [{
        chatId: chat.chatId,
        kind: isGroupChatId(chat.chatId) ? 'group' as const : 'direct' as const,
        name: chat.name || (isGroupChatId(chat.chatId) ? chat.chatId.split('@')[0] : `+${chat.chatId.split('@')[0]}`),
        messageCount: messages.length,
        lastMessageAt,
      }];
    }).sort((left, right) => (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? '') || left.name.localeCompare(right.name) || left.chatId.localeCompare(right.chatId));

    const items = await Promise.all(candidates.slice(offset, offset + limit).map(async (candidate) => ({
      ...candidate,
      name: await this.resolveHistoryName(candidate.chatId, candidate.name),
    })));

    return {
      items,
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
    const page: MessageEvent[] = [];
    for (const message of messages.slice(offset, offset + limit)) {
      page.push(message);
      if (message.media) {
        break;
      }
    }
    const nextOffset = offset + page.length < messages.length ? offset + page.length : undefined;

    return {
      name: await this.resolveHistoryName(chatId, chat.name),
      messages: page,
      total: messages.length,
      nextOffset,
    };
  }

  async getMedia(eventId: string): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
    if (!/^[a-f\d]{64}$/.test(eventId)) {
      throw new Error('Invalid media ID');
    }

    await this.historyWrites;
    const reference = await this.mediaReferences.read(eventId);
    if (!reference) {
      throw new Error('Media is unavailable');
    }

    return { bytes: await downloadMedia(reference), mimeType: reference.mimeType, fileName: reference.fileName };
  }

  private async resolveHistoryName(chatId: string, savedName?: string): Promise<string> {
    const fallback = isGroupChatId(chatId) ? chatId.split('@')[0] : `+${chatId.split('@')[0]}`;
    if (savedName && !/^\+?\d+$/.test(savedName)) {
      return savedName;
    }

    const name = isGroupChatId(chatId)
      ? this.status.state === 'connected' ? (await this.socket?.groupMetadata(chatId).catch(() => undefined))?.subject : undefined
      : (await this.contactNames.read(chatId))?.name;
    const resolved = name?.trim().slice(0, 120);
    if (!resolved || /^\+?\d+$/.test(resolved)) {
      return savedName || fallback;
    }

    await this.recordHistory([{ id: chatId, name: resolved }], []);
    return resolved;
  }

  async getGroupMembers(chatId: string): Promise<GroupMember[]> {
    if (!isGroupChatId(chatId) || !this.socket || this.status.state !== 'connected') {
      throw new Error('Group unavailable');
    }

    const cached = this.groupMembersCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.members;
    }

    await this.historyWrites;
    const metadata = await this.socket.groupMetadata(chatId);
    if (metadata.subject?.trim()) {
      await this.recordHistory([{ id: chatId, name: metadata.subject }], []);
    }
    const history = await this.historyChats.read(chatId);
    const namesFromMessages = new Map(history?.messages.filter((message) => message.senderId && message.senderName).map((message) => [message.senderId!, message.senderName!]) ?? []);
    const members = await Promise.all(metadata.participants.map(async (participant): Promise<GroupMember> => {
      const mappedPhoneId = participant.id.endsWith('@lid') ? (await this.phoneNumbers.read(participant.id))?.chatId : undefined;
      const phoneId = [participant.jid, mappedPhoneId, participant.id].find((id) => id && isDirectChatId(id));
      const savedName = (await this.contactNames.read(participant.id))?.name
        ?? (participant.jid ? (await this.contactNames.read(participant.jid))?.name : undefined);
      const displayName = (participant.name || savedName || participant.notify || participant.verifiedName || namesFromMessages.get(participant.id))?.trim().slice(0, 120);
      const [firstName, ...lastNameParts] = displayName?.split(/\s+/) ?? [];
      const isMe = Boolean(
        (this.socket?.user?.lid && participant.id === this.socket.user.lid) ||
        (this.status.phoneNumber && phoneId?.split('@')[0] === this.status.phoneNumber),
      );

      return {
        id: participant.id,
        ...(phoneId ? { phoneNumber: `+${phoneId.split('@')[0]}` } : {}),
        ...(displayName ? { displayName, firstName, lastName: lastNameParts.join(' ') } : {}),
        ...(isMe ? { isMe: true } : {}),
      };
    }));

    members.sort((left, right) => Number(Boolean(right.displayName)) - Number(Boolean(left.displayName)) || (left.displayName || left.phoneNumber || left.id).localeCompare(right.displayName || right.phoneNumber || right.id));
    this.groupMembersCache.set(chatId, { expiresAt: Date.now() + 60_000, members });
    return members;
  }

  // Oldest first, so Twenty imports messages in the order they were received.
  async getEvents(): Promise<MessageEvent[]> {
    const events = await this.events.list();
    return events.sort((left, right) => left.sentAt.localeCompare(right.sentAt)).slice(0, 100);
  }

  async claimEvents(): Promise<{ leaseId?: string; events: MessageEvent[] }> {
    if (this.syncLease && this.syncLease.expiresAt > Date.now()) {
      return { events: [] };
    }

    const leaseId = randomUUID();
    this.syncLease = { id: leaseId, expiresAt: Date.now() + 180_000 };
    this.ackedSinceClaim = 0;
    try {
      const events = await this.getEvents();
      if (events.length === 0) {
        if (this.syncLease?.id === leaseId) this.syncLease = undefined;
        return { events };
      }
      return { leaseId, events };
    } catch (error) {
      if (this.syncLease?.id === leaseId) this.syncLease = undefined;
      throw error;
    }
  }

  async releaseEvents(leaseId: string, completed: boolean): Promise<{ released: boolean }> {
    if (this.syncLease?.id !== leaseId) {
      return { released: false };
    }

    this.syncLease = undefined;
    // A sync handles a limited batch: ask for another one while it makes progress.
    if (completed && this.ackedSinceClaim > 0 && (await this.events.list(1)).length > 0) {
      this.onEventsQueued();
    }
    return { released: true };
  }

  async ackEvents(eventIds: string[]): Promise<{ acknowledged: number }> {
    for (const eventId of eventIds) {
      if (!/^[a-f\d]{64}$/.test(eventId)) {
        throw new Error('Invalid event ID');
      }

      await this.events.delete(eventId);
      this.ackedSinceClaim += 1;
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
      const messageId = generateMessageIDV2(this.socket.user?.id);
      // A recipient can request a retry before sendMessage resolves.
      await this.sentMessages.write(messageId, {
        encodedMessage: Buffer.from(proto.Message.encode({ conversation: text }).finish()).toString('base64'),
      });
      const sent = await this.socket.sendMessage(chatId, { text }, { messageId });
      if (!sent?.key.id || !sent.message) {
        throw new Error('WhatsApp did not confirm the outgoing message');
      }
      await this.sentMessages.write(sent.key.id, {
        encodedMessage: Buffer.from(proto.Message.encode(sent.message).finish()).toString('base64'),
      });
      const receipt: SendReceipt = {
        requestId,
        state: 'sent',
        providerMessageId: sent.key.id,
        eventId: messageEventId(chatId, sent.key.id),
      };
      await this.sends.write(requestId, receipt);
      return receipt;
    } finally {
      this.sendingRequests.delete(requestId);
    }
  }

  async sendMedia(requestId: string, chatId: string, accountPhoneNumber: string, kind: 'image' | 'video' | 'document', mimeType: string, fileName: string, caption: string, bytes: Buffer): Promise<SendReceipt> {
    if (!/^[a-f\d-]{36}$/i.test(requestId) || !isSupportedChatId(chatId) || !/^\+\d{7,15}$/.test(accountPhoneNumber) ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType) || !fileName || fileName.length > 255 || /[/\\\u0000-\u001f]/.test(fileName) ||
      caption.length > 4096 || bytes.length === 0 || bytes.length > 64 * 1024 * 1024 ||
      (kind === 'image' && !mimeType.startsWith('image/')) || (kind === 'video' && !mimeType.startsWith('video/'))) {
      throw new Error('Invalid media send request');
    }
    if (this.sendingRequests.has(requestId)) {
      return { requestId, state: 'unknown' };
    }
    this.sendingRequests.add(requestId);
    try {
      const existing = await this.sends.read(requestId);
      if (existing) return existing;
      if (!this.socket || this.status.state !== 'connected') throw new Error('WhatsApp is disconnected');
      if (`+${this.status.phoneNumber?.replace(/\D/g, '')}` !== accountPhoneNumber) throw new Error('WhatsApp account changed');

      await this.sends.write(requestId, { requestId, state: 'unknown' });
      const messageId = generateMessageIDV2(this.socket.user?.id);
      const content: AnyMediaMessageContent = kind === 'image'
        ? { image: bytes, mimetype: mimeType, ...(caption ? { caption } : {}) }
        : kind === 'video'
          ? { video: bytes, mimetype: mimeType, ...(caption ? { caption } : {}) }
          : { document: bytes, mimetype: mimeType, fileName, ...(caption ? { caption } : {}) };
      this.sendingMessageIds.add(messageId);
      let sent: WAMessage | undefined;
      try {
        sent = await this.socket.sendMessage(chatId, content, { messageId });
        if (!sent?.key.id || !sent.message) throw new Error('WhatsApp did not confirm the outgoing attachment');
        await this.sentMessages.write(sent.key.id, { encodedMessage: Buffer.from(proto.Message.encode(sent.message).finish()).toString('base64') });
      } finally {
        this.sendingMessageIds.delete(messageId);
      }
      if (!sent?.key.id) throw new Error('WhatsApp did not confirm the outgoing attachment');
      const receipt: SendReceipt = { requestId, state: 'sent', providerMessageId: sent.key.id, eventId: messageEventId(chatId, sent.key.id) };
      await this.sends.write(requestId, receipt);
      return receipt;
    } finally {
      this.sendingRequests.delete(requestId);
    }
  }

  async getSentMessage(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id || key.id.length > 128) {
      return undefined;
    }
    // Media is encrypted and uploaded inside sendMessage; wait for its stored payload during an early recipient retry.
    for (let attempt = 0; this.sendingMessageIds.has(key.id) && attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const saved = await this.sentMessages.read(key.id);
    return saved ? proto.Message.decode(Buffer.from(saved.encodedMessage, 'base64')) : undefined;
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
      // Baileys needs the original payload when a recipient requests a decryption retry.
      getMessage: (key) => this.getSentMessage(key),
    });

    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('messages.upsert', async ({ messages }) => {
      if (generation !== this.generation) {
        return;
      }

      await this.recordHistory([], messages);

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
          this.onEventsQueued();
        }
      }
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
    socket.ev.on('chats.update', async (chats) => {
      if (generation === this.generation) {
        await this.recordHistory([], [], false, chats.filter((chat) => chat.id && chat.name).map((chat) => ({ id: chat.id!, name: chat.name ?? undefined })));
      }
    });
    socket.ev.on('groups.update', async (groups) => {
      if (generation === this.generation) {
        await this.recordHistory(groups.filter((group) => group.id && group.subject).map((group) => ({ id: group.id!, name: group.subject })), []);
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
    socket.ev.on('contacts.update', async (contacts) => {
      if (generation === this.generation) {
        await this.recordHistory(contacts.filter((contact) => contact.id).map((contact) => ({ ...contact, id: contact.id! })), []);
      }
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
        this.onEventsQueued();
        void socket.groupFetchAllParticipating().then((groups) => {
          if (generation === this.generation) {
            return this.recordHistory(Object.values(groups).map((group) => ({ id: group.id, name: group.subject })), []);
          }
        }).catch(() => undefined);
      }

      if (connection === 'close') {
        this.socket = undefined;
        this.groupMembersCache.clear();
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
    this.groupMembersCache.clear();
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
