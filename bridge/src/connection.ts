import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import makeWASocket, { DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { toDataURL } from 'qrcode';

import { createEncryptedAuthState } from './encrypted-auth-state.js';
import { EncryptedJsonStore } from './encrypted-json-store.js';
import { toInboundMessageEvent, type InboundMessageEvent } from './message-event.js';

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
};

export class WhatsAppConnection {
  private socket: WASocket | undefined;
  private status: ConnectionStatus = { state: 'disconnected' };
  private generation = 0;
  private intentionallyDisconnected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly events: EncryptedJsonStore<InboundMessageEvent>;
  private readonly sends: EncryptedJsonStore<SendReceipt>;
  private readonly sendingRequests = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.events = new EncryptedJsonStore(join(directory, 'events'), encryptionKey);
    this.sends = new EncryptedJsonStore(join(directory, 'sends'), encryptionKey);
  }

  async getEvents(): Promise<InboundMessageEvent[]> {
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
      !/^\d{7,15}@s\.whatsapp\.net$/.test(chatId) ||
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
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
    });

    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (generation !== this.generation || type !== 'notify') {
        return;
      }

      for (const message of messages) {
        const event = toInboundMessageEvent(message);

        if (event) {
          await this.events.write(event.eventId, event);
        }
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

    await rm(this.directory, { recursive: true, force: true });

    return this.status;
  }
}
