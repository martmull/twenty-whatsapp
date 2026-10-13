import { rm } from 'node:fs/promises';

import makeWASocket, { DisconnectReason, type WASocket } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { toDataURL } from 'qrcode';

import { createEncryptedAuthState } from './encrypted-auth-state.js';

export type ConnectionStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

export class WhatsAppConnection {
  private socket: WASocket | undefined;
  private status: ConnectionStatus = { state: 'disconnected' };
  private generation = 0;
  private intentionallyDisconnected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly directory: string,
    private readonly encryptionKey: Buffer,
  ) {}

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
