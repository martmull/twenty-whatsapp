import { useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { AppPath, enqueueSnackbar, navigate, t, useColorScheme, type UploadedFrontComponentFile } from 'twenty-sdk/front-component';
import { getPublicAssetUrl } from 'twenty-sdk/utils';
import { Callout } from 'twenty-ui/components';
import { Button } from 'twenty-ui/primitives/input';
import { themeCssVariables } from 'twenty-ui/theme';
import 'twenty-ui/style.css';

import { callApp, showError } from 'src/front-components/components/app-api';
import { ConversationList } from 'src/front-components/components/ConversationList';
import { createRequestId } from 'src/front-components/components/createRequestId';
import type { InboxData, Message } from 'src/front-components/components/inbox-types';
import { MessageBubble } from 'src/front-components/components/MessageBubble';
import { MessageComposer, type PendingFile } from 'src/front-components/components/MessageComposer';
import { uploadWhatsAppAttachment } from 'src/front-components/components/uploadWhatsAppAttachment';

const POLL_INTERVAL_MS = 5_000;
// Every Nth poll reloads anyway, to pick up connection changes.
const FULL_RELOAD_EVERY = 12;

type SendResult = { state: 'sent' | 'unknown' };

// Cheap check through the REST API: the newest conversation activity visible to this member.
const fetchLatestActivity = async (personId?: string): Promise<string | undefined> => {
  const response = await new RestApiClient().get<{ data?: { whatsappConversations?: { lastMessageAt?: string }[] } }>('/rest/whatsappConversations', {
    query: { order_by: 'lastMessageAt[DescNullsLast]', limit: 1, ...(personId ? { filter: `personId[eq]:"${personId}"` } : {}) },
  });
  return response.data?.whatsappConversations?.[0]?.lastMessageAt;
};

export const WhatsAppThread = ({ personId }: { personId?: string }) => {
  const isDark = useColorScheme() === 'dark';
  const [data, setData] = useState<InboxData>();
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const selectedIdRef = useRef<string | undefined>(undefined);
  const threadIdRef = useRef<string | undefined>(undefined);
  const searchRef = useRef('');
  // Kept across retries so a failed send is never delivered twice.
  const textRequestRef = useRef<{ text: string; requestId: string } | undefined>(undefined);
  const uploadedRef = useRef(new Map<string, UploadedFrontComponentFile>());

  const markRead = async (next: InboxData) => {
    const conversation = next.conversations.find((item) => item.id === next.selectedConversationId);

    if (!conversation?.unread || !conversation.lastInboundAt) return;

    const { lastReadAt } = await callApp<{ lastReadAt: string }>('messages/read', {
      conversationId: conversation.id,
      readThroughAt: conversation.lastInboundAt,
    }).catch(() => ({ lastReadAt: undefined }));

    if (lastReadAt) {
      setData((previous) => previous && {
        ...previous,
        conversations: previous.conversations.map((item) => item.id === conversation.id ? { ...item, lastReadAt, unread: false } : item),
      });
    }
  };

  const load = async () => {
    const requestedId = selectedIdRef.current;

    try {
      const next = await callApp<InboxData>('messages/list', {
        ...(personId ? { personId } : {}),
        ...(requestedId ? { conversationId: requestedId } : {}),
        ...(searchRef.current ? { search: searchRef.current } : {}),
      });

      // The member picked another conversation while this was loading.
      if (requestedId !== selectedIdRef.current) return;

      // A different thread: forget the older pages loaded for the previous one.
      if (next.selectedConversationId !== threadIdRef.current) {
        threadIdRef.current = next.selectedConversationId;
        setOlderMessages([]);
        setHasOlderMessages(next.hasMoreMessages);
      }

      selectedIdRef.current = next.selectedConversationId;
      setData(next);
      void markRead(next);
    } catch (error) {
      showError(error, t('Could not load WhatsApp messages'));
    }
  };

  useEffect(() => {
    let active = true;
    let lastActivity: string | undefined;
    let polls = 0;

    void load();
    const timer = setInterval(async () => {
      polls += 1;
      const activity = await fetchLatestActivity(personId).catch(() => lastActivity);

      if (active && (activity !== lastActivity || polls % FULL_RELOAD_EVERY === 0)) {
        lastActivity = activity;
        await load();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [personId]);

  // Search as the member types, after a short pause.
  useEffect(() => {
    if (searchRef.current === search) return;
    const timer = setTimeout(() => {
      searchRef.current = search;
      void load();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const selectConversation = (conversationId: string) => {
    selectedIdRef.current = conversationId;
    textRequestRef.current = undefined;
    setData((previous) => previous && { ...previous, selectedConversationId: conversationId, messages: [], groupMembers: undefined });
    void load();
  };

  const loadOlderMessages = async () => {
    const conversationId = selectedIdRef.current;
    const oldest = olderMessages[0] ?? data?.messages[0];
    if (!conversationId || !oldest) return;

    try {
      const page = await callApp<{ messages: Message[]; hasMoreMessages: boolean }>('messages/list', { conversationId, before: oldest.sentAt });
      if (conversationId !== selectedIdRef.current) return;
      setOlderMessages((previous) => [...page.messages, ...previous]);
      setHasOlderMessages(page.hasMoreMessages);
    } catch (error) {
      showError(error, t('Could not load older messages'));
    }
  };

  // Sends each file as its own message (the text goes with the first one), then the text alone.
  const send = async (text: string, files: PendingFile[]): Promise<{ text: string; files: PendingFile[] }> => {
    const conversationId = selectedIdRef.current;
    if (!conversationId) return { text, files };

    setSending(true);
    let caption = text;
    let remainingFiles = files;

    try {
      for (const pending of files) {
        const uploaded = uploadedRef.current.get(pending.id) ?? await uploadWhatsAppAttachment(pending.file);
        uploadedRef.current.set(pending.id, uploaded);

        const result = await callApp<SendResult>('messages/send', {
          conversationId,
          requestId: pending.id,
          text: caption,
          attachment: { fileId: uploaded.fileId, label: pending.file.name, mimeType: uploaded.mimeType || pending.file.type || 'application/octet-stream', size: uploaded.size },
        });

        remainingFiles = remainingFiles.filter((item) => item.id !== pending.id);
        caption = '';
        if (result.state !== 'sent') throw new Error('unconfirmed');
      }

      if (caption.trim()) {
        if (textRequestRef.current?.text !== caption) {
          textRequestRef.current = { text: caption, requestId: createRequestId() };
        }
        const result = await callApp<SendResult>('messages/send', { conversationId, requestId: textRequestRef.current.requestId, text: caption });
        if (result.state !== 'sent') throw new Error('unconfirmed');
        textRequestRef.current = undefined;
        caption = '';
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'unconfirmed') {
        void enqueueSnackbar({ message: t('Delivery not confirmed. Check WhatsApp before retrying.'), variant: 'warning' });
      } else {
        showError(error, t('Could not send the message'));
      }
    } finally {
      setSending(false);
      void load();
    }

    return { text: caption, files: remainingFiles };
  };

  const selected = data?.conversations.find((conversation) => conversation.id === data.selectedConversationId);
  const connected = data?.connectionState === 'connected';
  const messages = [...olderMessages, ...(data?.messages ?? []).filter((message) => !olderMessages.some((older) => older.id === message.id))];
  const memberNames = new Map<string, string>();
  for (const member of data?.groupMembers ?? []) {
    if (!member.displayName) continue;
    memberNames.set(member.id, member.displayName);
    if (member.phoneNumber) memberNames.set(`${member.phoneNumber.slice(1)}@s.whatsapp.net`, member.displayName);
  }
  const isGroup = selected?.chatId.endsWith('@g.us');
  // On a Person page the list only shows when they have several conversations.
  const showList = !personId || (data?.conversations.length ?? 0) > 1;

  return (
    <section style={{
      boxSizing: 'border-box',
      color: themeCssVariables.font.color.primary,
      display: 'grid',
      fontFamily: themeCssVariables.font.family,
      gap: themeCssVariables.spacing[2],
      gridTemplateRows: 'auto minmax(0, 1fr)',
      height: personId ? 'calc(100dvh - 140px)' : '100%',
      minHeight: personId ? 420 : 560,
      padding: personId ? 0 : themeCssVariables.spacing[3],
    }}>
      <div>
        {data && !connected && (
          <Callout
            variant="warning"
            title={t('WhatsApp is not connected')}
            action={{ label: t('Open settings'), onClick: () => void navigate(AppPath.SettingsCatchAll, { '*': 'applications' }) }}
          />
        )}
      </div>
      <div style={{
        border: `1px solid ${themeCssVariables.border.color.medium}`,
        borderRadius: themeCssVariables.border.radius.md,
        display: 'grid',
        gridTemplateColumns: showList ? 'minmax(220px, 30%) minmax(0, 1fr)' : 'minmax(0, 1fr)',
        minHeight: 0,
        overflow: 'hidden',
      }}>
        {showList && (
          <ConversationList
            conversations={data?.conversations ?? []}
            selectedId={data?.selectedConversationId}
            search={search}
            onSearchChange={personId ? undefined : setSearch}
            onSelect={selectConversation}
          />
        )}
        <div style={{ display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto', minHeight: 0, minWidth: 0 }}>
          {/* column-reverse keeps the view pinned to the newest message (the sandbox cannot scroll programmatically). */}
          <div key={data?.selectedConversationId} style={{
            backgroundColor: themeCssVariables.background.secondary,
            backgroundImage: `url("${getPublicAssetUrl(isDark ? 'whatsapp-wallpaper-dark.png' : 'whatsapp-wallpaper.png')}")`,
            backgroundSize: '485px auto',
            display: 'flex',
            flexDirection: 'column-reverse',
            gap: themeCssVariables.spacing[2],
            overflowY: 'auto',
            padding: themeCssVariables.spacing[3],
          }}>
            {messages.slice().reverse().map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                senderName={isGroup && message.direction === 'INBOUND' ? memberNames.get(message.senderId ?? '') || message.senderName || message.senderId?.split('@')[0] : undefined}
                highlighted={Boolean(selected?.unread && message.direction === 'INBOUND' && (!selected.lastReadAt || message.sentAt > selected.lastReadAt))}
              />
            ))}
            {hasOlderMessages && (
              <div style={{ alignSelf: 'center' }}>
                <Button variant="soft" size="sm" onClick={() => void loadOlderMessages()}>{t('Load older messages')}</Button>
              </div>
            )}
          </div>
          <MessageComposer key={data?.selectedConversationId} disabled={!selected || !connected} sending={sending} onSend={send} />
        </div>
      </div>
    </section>
  );
};
