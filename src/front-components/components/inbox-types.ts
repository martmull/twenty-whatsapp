export type ConnectionState = 'disconnected' | 'pairing' | 'connected' | 'reconnecting' | 'unavailable';

export type Conversation = {
  id: string;
  name: string;
  personId?: string | null;
  chatId: string;
  lastMessageAt?: string | null;
  lastInboundAt?: string | null;
  lastReadAt?: string | null;
  lastPreview?: string | null;
  unread?: boolean;
};

export type Message = {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
  sentAt: string;
  deliveryState: 'UNKNOWN' | 'SENT' | 'RECEIVED';
  senderId?: string | null;
  senderName?: string | null;
  mediaKind?: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | null;
  media?: { fileId: string; label?: string | null; url?: string | null }[] | null;
};

export type GroupMember = {
  id: string;
  phoneNumber?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  isMe?: boolean;
};

export type InboxData = {
  conversations: Conversation[];
  selectedConversationId?: string;
  messages: Message[];
  hasMoreMessages: boolean;
  groupMembers?: GroupMember[];
  connectionState: ConnectionState;
};

export const formatTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';
