import { useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { t } from 'twenty-sdk/front-component';
import { themeCssVariables } from 'twenty-ui/theme';

import { PreviewBadge, PreviewButton, getPreviewStyles } from 'src/front-components/components/PreviewUi';
import { createRequestId } from 'src/front-components/components/createRequestId';

type Conversation = {
  id: string;
  name: string;
  personId: string;
  lastMessageAt?: string | null;
  lastPreview?: string | null;
};

type Message = {
  id: string;
  direction: string;
  text: string;
  sentAt: string;
  deliveryState: string;
};

type InboxData = {
  conversations: Conversation[];
  selectedConversationId?: string;
  messages: Message[];
  connectionState: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
};

type WhatsAppThreadProps = { personId?: string; compact?: boolean };

const formatTime = (value?: string | null) => value
  ? new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  : '';

export const WhatsAppThread = ({ personId, compact = false }: WhatsAppThreadProps) => {
  const styles = getPreviewStyles();
  const [data, setData] = useState<InboxData>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [requestId, setRequestId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async (conversationId?: string, silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const next = await new RestApiClient().post<InboxData>('/s/whatsapp/messages/list', {
        ...(personId ? { personId } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
      setData(next);
      setSelectedId(next.selectedConversationId);
      selectedIdRef.current = next.selectedConversationId;
      setError('');
    } catch {
      setError(t('Could not load WhatsApp messages. Check your access and connection.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await new RestApiClient().post<InboxData>('/s/whatsapp/messages/list', {
          ...(personId ? { personId } : {}),
          ...(selectedIdRef.current ? { conversationId: selectedIdRef.current } : {}),
        });

        if (active) {
          selectedIdRef.current = next.selectedConversationId;
          setData(next);
          setSelectedId(next.selectedConversationId);
          setLoading(false);
          setError('');
        }
      } catch {
        if (active) {
          setLoading(false);
          setError(t('Could not load WhatsApp messages. Check your access and connection.'));
        }
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [personId]);

  const selectConversation = (conversationId: string) => {
    setDraft('');
    setRequestId(undefined);
    setNotice('');
    setSelectedId(conversationId);
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
  // The sandbox does not forward imperative scrolling, so remount at the newest message.
  const latestMessageId = data?.messages[data.messages.length - 1]?.id;

  return (
    <section style={{
      ...styles.root,
      display: 'grid',
      gridTemplateRows: 'auto minmax(0, 1fr)',
      gap: themeCssVariables.spacing[3],
      height: compact ? 420 : '100%',
      minHeight: compact ? 420 : 560,
      padding: compact ? 0 : themeCssVariables.spacing[3],
    }}>
      <header style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: themeCssVariables.spacing[2] }}>
        <div>
          <h2 style={{ margin: 0, fontSize: compact ? 16 : 20 }}>{compact ? t('WhatsApp conversations') : t('WhatsApp inbox')}</h2>
          {!compact && <p style={styles.muted}>{t('Shared conversations with People in this workspace.')}</p>}
        </div>
        <div style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[2] }}>
          <PreviewBadge tone={connected ? 'green' : 'neutral'}>{connected ? t('Connected') : t('Offline')}</PreviewBadge>
          <PreviewButton onClick={() => void load(selectedId)}>{t('Refresh')}</PreviewButton>
        </div>
      </header>
      <div style={{ ...styles.card, display: 'grid', gridTemplateColumns: compact ? 'minmax(130px, 36%) minmax(0, 1fr)' : 'minmax(200px, 30%) minmax(0, 1fr)', minHeight: 0, overflow: 'hidden' }}>
        <aside aria-label={t('Conversations')} style={{ borderRight: `1px solid ${themeCssVariables.border.color.medium}`, overflowY: 'auto' }}>
          {loading && !data && <p style={{ ...styles.muted, padding: themeCssVariables.spacing[3] }}>{t('Loading conversations…')}</p>}
          {!loading && data?.conversations.length === 0 && <p style={{ ...styles.muted, padding: themeCssVariables.spacing[3] }}>{t('No conversations with matched People yet.')}</p>}
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
              <strong>{conversation.name}</strong>
              <span style={styles.muted}>{conversation.lastPreview ?? t('No messages yet')}</span>
              <small style={styles.label}>{formatTime(conversation.lastMessageAt)}</small>
            </button>
          ))}
        </aside>
        <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', minWidth: 0, minHeight: 0 }}>
          <div style={{ borderBottom: `1px solid ${themeCssVariables.border.color.medium}`, padding: themeCssVariables.spacing[3] }}>
            <strong>{selected?.name ?? t('Select a conversation')}</strong>
          </div>
          <div key={`${selectedId}:${latestMessageId}`} aria-label={t('Message thread')} style={{ background: themeCssVariables.background.secondary, display: 'flex', flexDirection: 'column-reverse', gap: themeCssVariables.spacing[2], overflowY: 'auto', padding: themeCssVariables.spacing[3] }}>
            {selected && data?.messages.length === 0 && <p style={styles.muted}>{t('No messages yet.')}</p>}
            {data?.messages.slice().reverse().map((message) => (
              <div key={message.id} style={{ alignSelf: message.direction === 'outbound' ? 'flex-end' : 'flex-start', background: message.direction === 'outbound' ? 'rgba(37, 187, 85, 0.13)' : themeCssVariables.background.primary, border: `1px solid ${themeCssVariables.border.color.medium}`, borderRadius: themeCssVariables.border.radius.md, maxWidth: '78%', padding: `${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]}` }}>
                <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message.text}</div>
                <small style={{ ...styles.label, display: 'block', marginTop: 6 }}>{formatTime(message.sentAt)}{message.direction === 'outbound' ? ` · ${message.deliveryState}` : ''}</small>
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${themeCssVariables.border.color.medium}`, display: 'grid', gap: themeCssVariables.spacing[2], padding: themeCssVariables.spacing[3] }}>
            {error && <p role="alert" style={{ color: themeCssVariables.color.red, margin: 0 }}>{error}</p>}
            {notice && <p role="status" style={{ ...styles.muted, margin: 0 }}>{notice}</p>}
            <textarea
              aria-label={t('Write a WhatsApp message')}
              placeholder={selected ? t('Write a message…') : t('Select a conversation first')}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setRequestId(undefined); setNotice(''); }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat && !('isComposing' in event && event.isComposing)) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={!selected || !connected || sending}
              rows={compact ? 2 : 3}
              maxLength={4096}
              style={{ background: themeCssVariables.background.primary, border: `1px solid ${themeCssVariables.border.color.medium}`, borderRadius: themeCssVariables.border.radius.sm, color: themeCssVariables.font.color.primary, fontFamily: themeCssVariables.font.family, fontSize: themeCssVariables.font.size.md, padding: themeCssVariables.spacing[2], resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between', gap: themeCssVariables.spacing[2] }}>
              <small style={styles.label}>{connected ? t('Send ⌘↵') : t('Connect WhatsApp to send')}</small>
              <PreviewButton primary disabled={!selected || !connected || !draft.trim() || sending} onClick={() => void send()}>{sending ? t('Sending…') : t('Send')}</PreviewButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
