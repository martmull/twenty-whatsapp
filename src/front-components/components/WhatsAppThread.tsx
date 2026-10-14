import { useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { t, useColorScheme } from 'twenty-sdk/front-component';
import { getPublicAssetUrl } from 'twenty-sdk/utils';
import { themeCssVariables } from 'twenty-ui/theme';

import { PreviewBadge, PreviewButton, getPreviewStyles } from 'src/front-components/components/PreviewUi';
import { createRequestId } from 'src/front-components/components/createRequestId';

type Conversation = {
  id: string;
  name: string;
  personId: string;
  chatId: string;
  lastMessageAt?: string | null;
  lastInboundAt?: string | null;
  lastReadAt?: string | null;
  lastPreview?: string | null;
  unread?: boolean;
};

type Message = {
  id: string;
  direction: string;
  text: string;
  sentAt: string;
  deliveryState: string;
  senderId?: string | null;
  senderName?: string | null;
  mediaKind?: string | null;
  media?: { fileId: string; label?: string | null; url?: string | null }[] | null;
};

type GroupMember = {
  id: string;
  phoneNumber?: string;
  displayName?: string;
  isMe?: boolean;
};

type InboxData = {
  conversations: Conversation[];
  selectedConversationId?: string;
  messages: Message[];
  groupMembers?: GroupMember[];
  connectionState: 'disconnected' | 'pairing' | 'connected' | 'reconnecting' | 'unavailable';
};

type WhatsAppThreadProps = { personId?: string };

const formatTime = (value?: string | null) => value
  ? new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  : '';

export const WhatsAppThread = ({ personId }: WhatsAppThreadProps) => {
  const styles = getPreviewStyles();
  const isDark = useColorScheme() === 'dark';
  const [data, setData] = useState<InboxData>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [requestId, setRequestId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showGroupMembers, setShowGroupMembers] = useState(false);

  const markSelectedRead = async (next: InboxData) => {
    const conversation = next.conversations.find((item) => item.id === next.selectedConversationId);

    if (!conversation?.unread || !conversation.lastInboundAt || !next.messages.some((message) => message.direction === 'inbound' && message.sentAt === conversation.lastInboundAt)) {
      return;
    }

    try {
      const result = await new RestApiClient().post<{ lastReadAt: string }>('/s/whatsapp/messages/read', {
        conversationId: conversation.id,
        readThroughAt: conversation.lastInboundAt,
      });

      setData((previous) => previous ? {
        ...previous,
        conversations: previous.conversations.map((item) => item.id === conversation.id && item.lastInboundAt && item.lastInboundAt <= result.lastReadAt
          ? { ...item, lastReadAt: result.lastReadAt, unread: false }
          : item),
      } : previous);
    } catch {
      // Keep the unread state so the next refresh can retry.
    }
  };

  const load = async (conversationId?: string, silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const next = await new RestApiClient().post<InboxData>('/s/whatsapp/messages/list', {
        ...(personId ? { personId } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      if (conversationId !== selectedIdRef.current) return;
      setData(next);
      setSelectedId(next.selectedConversationId);
      selectedIdRef.current = next.selectedConversationId;
      setError('');
      void markSelectedRead(next);
    } catch {
      setError(t('Could not load WhatsApp messages. Check your access and connection.'));
    } finally {
      setLoading(false);
    }
  };

  const refreshNow = async () => {
    if (refreshing) {
      return;
    }

    setRefreshing(true);
    let syncFailed = false;

    try {
      await new RestApiClient().post('/s/whatsapp/messages/sync', {});
    } catch {
      syncFailed = true;
    }

    await load(selectedIdRef.current, true);
    if (syncFailed) {
      setError(t('Could not sync new WhatsApp messages. Check the bridge connection and try again.'));
    }
    setRefreshing(false);
  };

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async (sync = false) => {
      if (refreshing) return;
      refreshing = true;

      try {
        if (sync) {
          await new RestApiClient().post('/s/whatsapp/messages/sync', {}).catch(() => undefined);
        }
        const requestedId = selectedIdRef.current;
        const next = await new RestApiClient().post<InboxData>('/s/whatsapp/messages/list', {
          ...(personId ? { personId } : {}),
          ...(requestedId ? { conversationId: requestedId } : {}),
        });

        if (active && requestedId === selectedIdRef.current) {
          selectedIdRef.current = next.selectedConversationId;
          setData(next);
          setSelectedId(next.selectedConversationId);
          setLoading(false);
          setError('');
          void markSelectedRead(next);
        }
      } catch {
        if (active) {
          setLoading(false);
          setError(t('Could not load WhatsApp messages. Check your access and connection.'));
        }
      } finally {
        refreshing = false;
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(true), 15_000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [personId]);

  const selectConversation = (conversationId: string) => {
    setDraft('');
    setRequestId(undefined);
    setNotice('');
    setShowGroupMembers(false);
    setSelectedId(conversationId);
    setData((previous) => previous ? { ...previous, groupMembers: undefined } : previous);
    selectedIdRef.current = conversationId;
    void load(conversationId, true);
  };

  const send = async () => {
    if (!selectedId || !draft.trim() || sending || data?.connectionState !== 'connected') {
      return;
    }

    setSending(true);
    setError('');
    setNotice('');

    try {
      const stableRequestId = requestId ?? createRequestId();
      setRequestId(stableRequestId);
      const result = await new RestApiClient().post<{ state: 'sent' | 'unknown' }>('/s/whatsapp/messages/send', {
        conversationId: selectedId,
        requestId: stableRequestId,
        text: draft,
      });

      if (result.state === 'sent') {
        setDraft('');
        setRequestId(undefined);
        setNotice(t('Message sent.'));
      } else {
        setNotice(t('Delivery is uncertain. Check WhatsApp before trying again.'));
      }

      await load(selectedId, true);
    } catch {
      setError(t('Could not confirm delivery. Your draft is saved here; retry uses the same request ID.'));
    } finally {
      setSending(false);
    }
  };

  const selected = data?.conversations.find((conversation) => conversation.id === selectedId);
  const connected = data?.connectionState === 'connected';
  const connectionLabel = data?.connectionState === 'connected' ? t('Connected')
    : data?.connectionState === 'reconnecting' ? t('Reconnecting')
    : data?.connectionState === 'unavailable' ? t('Bridge unavailable')
    : data?.connectionState === 'pairing' ? t('Pairing') : t('Disconnected');
  const isGroup = selected?.chatId.endsWith('@g.us');
  const memberNameById = new Map<string, string>();
  for (const member of data?.groupMembers ?? []) {
    if (member.displayName) {
      memberNameById.set(member.id, member.displayName);
      if (member.phoneNumber) {
        memberNameById.set(`${member.phoneNumber.slice(1)}@s.whatsapp.net`, member.displayName);
      }
    }
  }
  // The sandbox does not forward imperative scrolling, so remount at the newest message.
  const latestMessageId = data?.messages[data.messages.length - 1]?.id;

  return (
    <section style={{
      ...styles.root,
      display: 'grid',
      gridTemplateRows: data?.connectionState === 'unavailable' ? 'auto auto minmax(0, 1fr)' : 'auto minmax(0, 1fr)',
      gap: themeCssVariables.spacing[3],
      height: personId ? 'calc(100dvh - 140px)' : '100%',
      minHeight: personId ? 420 : 560,
      padding: personId ? 0 : themeCssVariables.spacing[3],
    }}>
      <header style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: themeCssVariables.spacing[2] }}>
        <div>
          <h2 style={{ margin: 0, fontSize: personId ? 16 : 20 }}>{personId ? t('WhatsApp') : t('WhatsApp inbox')}</h2>
          {!personId && <p style={styles.muted}>{t('Shared direct and group conversations in this workspace.')}</p>}
        </div>
        <div style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[2] }}>
          <PreviewBadge tone={connected ? 'green' : data?.connectionState === 'unavailable' ? 'red' : 'neutral'}>{connectionLabel}</PreviewBadge>
          <PreviewButton disabled={refreshing} onClick={() => void refreshNow()}>{refreshing ? t('Refreshing…') : t('Refresh')}</PreviewButton>
        </div>
      </header>
      {data?.connectionState === 'unavailable' && <p role="alert" style={{ color: themeCssVariables.color.red, margin: 0 }}>{t('The WhatsApp bridge is unavailable. Check the bridge process in app settings, then refresh.')}</p>}
      <div style={{ ...styles.card, display: 'grid', gridTemplateColumns: personId ? 'minmax(0, 1fr)' : 'minmax(200px, 30%) minmax(0, 1fr)', minHeight: 0, overflow: 'hidden' }}>
        {!personId && <aside aria-label={t('Conversations')} style={{ borderRight: `1px solid ${themeCssVariables.border.color.medium}`, overflowY: 'auto' }}>
          {loading && !data && <p style={{ ...styles.muted, padding: themeCssVariables.spacing[3] }}>{t('Loading conversations…')}</p>}
          {!loading && data?.conversations.length === 0 && <p style={{ ...styles.muted, padding: themeCssVariables.spacing[3] }}>{t('No conversations yet.')}</p>}
          {data?.conversations.map((conversation) => (
            <button key={conversation.id} type="button" onClick={() => selectConversation(conversation.id)} style={{
              background: conversation.id === selectedId ? themeCssVariables.background.secondary : themeCssVariables.background.primary,
              border: 0,
              borderBottom: `1px solid ${themeCssVariables.border.color.medium}`,
              color: themeCssVariables.font.color.primary,
              cursor: 'pointer',
              display: 'grid',
              fontFamily: themeCssVariables.font.family,
              gap: 4,
              padding: themeCssVariables.spacing[3],
              textAlign: 'left',
              width: '100%',
            }}>
              <span style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[2], justifyContent: 'space-between' }}>
                <strong style={{ fontWeight: conversation.unread ? 700 : 600 }}>{conversation.name}</strong>
                {conversation.unread && <span aria-label={t('Unread messages')} title={t('Unread messages')} style={{ background: themeCssVariables.color.blue, borderRadius: '50%', flexShrink: 0, height: 8, width: 8 }} />}
              </span>
              <span style={{ ...styles.muted, color: conversation.unread ? themeCssVariables.font.color.primary : styles.muted.color, fontWeight: conversation.unread ? 600 : undefined }}>{conversation.lastPreview ?? t('No messages yet')}</span>
              <small style={styles.label}>{formatTime(conversation.lastMessageAt)}</small>
            </button>
          ))}
        </aside>}
        <div style={{ display: 'grid', gridTemplateRows: personId ? 'minmax(0, 1fr) auto' : 'auto minmax(0, 1fr) auto', minWidth: 0, minHeight: 0 }}>
          {!personId && <div style={{ borderBottom: `1px solid ${themeCssVariables.border.color.medium}`, display: 'grid', gap: themeCssVariables.spacing[2], padding: themeCssVariables.spacing[3] }}>
            <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: themeCssVariables.spacing[2] }}>
              <strong>{selected?.name ?? t('Select a conversation')}</strong>
              {isGroup && data?.groupMembers && <PreviewButton onClick={() => setShowGroupMembers((previous) => !previous)}>{showGroupMembers ? t('Hide members') : `${t('Members')} (${data.groupMembers.length})`}</PreviewButton>}
            </div>
            {isGroup && showGroupMembers && data?.groupMembers && (
              <div aria-label={t('Group members')} style={{ display: 'flex', flexWrap: 'wrap', gap: themeCssVariables.spacing[2], maxHeight: 120, overflowY: 'auto' }}>
                {data.groupMembers.map((member) => <span key={member.id} style={{ ...styles.label, background: themeCssVariables.background.secondary, borderRadius: themeCssVariables.border.radius.sm, padding: themeCssVariables.spacing[1] }}>{member.isMe ? `${t('You')}${member.displayName ? ` · ${member.displayName}` : ''}` : member.displayName || member.phoneNumber || member.id}</span>)}
              </div>
            )}
          </div>}
          <div key={`${selectedId}:${latestMessageId}`} aria-label={t('Message thread')} style={{ backgroundColor: isDark ? '#0b141a' : '#faf7f2', backgroundImage: `url("${getPublicAssetUrl(isDark ? 'whatsapp-wallpaper-dark.png' : 'whatsapp-wallpaper.png')}")`, backgroundRepeat: 'repeat', backgroundSize: '485px auto', display: 'flex', flexDirection: 'column-reverse', gap: themeCssVariables.spacing[2], overflowY: 'auto', padding: themeCssVariables.spacing[3] }}>
            {personId && loading && !data && <p style={{ color: isDark ? '#8696a0' : '#667781' }}>{t('Loading conversation…')}</p>}
            {personId && !loading && !selected && <p style={{ color: isDark ? '#8696a0' : '#667781' }}>{t('No WhatsApp conversation for this Person yet.')}</p>}
            {selected && data?.messages.length === 0 && <p style={styles.muted}>{t('No messages yet.')}</p>}
            {data?.messages.slice().reverse().map((message) => (
              <div key={message.id} style={{ alignSelf: message.direction === 'outbound' ? 'flex-end' : 'flex-start', background: message.direction === 'outbound' ? isDark ? '#005c4b' : '#d9fdd3' : isDark ? '#202c33' : '#fff', border: selected?.unread && message.direction === 'inbound' && (!selected.lastReadAt || message.sentAt > selected.lastReadAt) ? `2px solid ${themeCssVariables.color.blue}` : isDark ? '1px solid #26343d' : '1px solid #e9e7e3', borderRadius: themeCssVariables.border.radius.md, color: isDark ? '#e9edef' : '#202c33', maxWidth: '78%', padding: `${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]}` }}>
                {isGroup && message.direction === 'inbound' && <strong style={{ color: isDark ? '#53bdeb' : '#075e54', display: 'block', fontSize: themeCssVariables.font.size.sm, marginBottom: 4 }}>{memberNameById.get(message.senderId ?? '') || message.senderName || message.senderId?.split('@')[0] || t('Group participant')}</strong>}
                {message.media?.[0]?.url && message.mediaKind === 'image' && <a href={message.media[0].url} target="_blank" rel="noopener noreferrer" aria-label={t('Open image')}><img src={message.media[0].url} alt={message.text === '[Image]' ? t('WhatsApp image') : message.text} loading="lazy" style={{ display: 'block', maxHeight: 360, maxWidth: '100%', borderRadius: themeCssVariables.border.radius.sm, objectFit: 'contain' }} /></a>}
                {message.media?.[0]?.url && message.mediaKind === 'video' && <video controls preload="metadata" aria-label={t('WhatsApp video')} style={{ display: 'block', maxHeight: 360, maxWidth: '100%', borderRadius: themeCssVariables.border.radius.sm }} src={message.media[0].url} />}
                {message.mediaKind && !message.media?.[0]?.url && <div style={{ color: isDark ? '#8696a0' : '#667781' }}>{message.mediaKind === 'image' ? t('Image unavailable') : t('Video unavailable')}</div>}
                {(!message.mediaKind || !['[Image]', '[Video]'].includes(message.text)) && <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message.text}</div>}
                <small style={{ ...styles.label, color: isDark ? '#aebac1' : '#667781', display: 'block', marginTop: 6 }}>{formatTime(message.sentAt)}{message.direction === 'outbound' ? ` · ${message.deliveryState}` : ''}</small>
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${themeCssVariables.border.color.medium}`, display: 'grid', gap: themeCssVariables.spacing[2], padding: themeCssVariables.spacing[3] }}>
            {error && <p role="alert" style={{ color: themeCssVariables.color.red, margin: 0 }}>{error}</p>}
            {notice && <p role="status" style={{ ...styles.muted, margin: 0 }}>{notice}</p>}
            <textarea
              aria-label={t('Write a WhatsApp message')}
              placeholder={selected ? t('Write a message…') : personId ? t('No conversation yet') : t('Select a conversation first')}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setRequestId(undefined); setNotice(''); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat && !('isComposing' in event && event.isComposing)) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={!selected || !connected || sending}
              rows={personId ? 2 : 3}
              maxLength={4096}
              style={{ background: themeCssVariables.background.primary, border: `1px solid ${themeCssVariables.border.color.medium}`, borderRadius: themeCssVariables.border.radius.sm, color: themeCssVariables.font.color.primary, fontFamily: themeCssVariables.font.family, fontSize: themeCssVariables.font.size.md, padding: themeCssVariables.spacing[2], resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'flex-end' }}>
              <PreviewButton primary disabled={!selected || !connected || !draft.trim() || sending} onClick={() => void send()}>{sending ? t('Sending…') : t('Send')}</PreviewButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
