import { useEffect, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { t, useColorScheme, type UploadedFrontComponentFile } from 'twenty-sdk/front-component';
import { getPublicAssetUrl } from 'twenty-sdk/utils';
import { themeCssVariables } from 'twenty-ui/theme';

import { PreviewButton, getPreviewStyles } from 'src/front-components/components/PreviewUi';
import { createRequestId } from 'src/front-components/components/createRequestId';
import { uploadWhatsAppAttachment } from 'src/front-components/components/uploadWhatsAppAttachment';

type PendingAttachment = { id: string; file: File; uploaded?: UploadedFrontComponentFile };
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

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
  status?: 'OPEN' | 'CLOSED' | null;
  assigneeId?: string | null;
};

type View = 'open' | 'mine' | 'closed';
type Member = { id: string; name: string };

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
  // The open conversation, also when the search leaves it out of `conversations`.
  selectedConversation?: Conversation;
  messages: Message[];
  groupMembers?: GroupMember[];
  connectionState: 'disconnected' | 'pairing' | 'connected' | 'reconnecting' | 'unavailable';
  // Inbox only: who conversations can be assigned to, and who is looking.
  members?: Member[];
  currentMemberId?: string;
};

const POLL_INTERVAL_MS = 5_000;
const SEARCH_DEBOUNCE_MS = 250;
// Every Nth poll reloads anyway, to pick up connection changes.
const FULL_RELOAD_EVERY = 12;

// Cheap check through the REST API: the newest conversation activity visible to this member.
const fetchLatestActivity = async (personId?: string): Promise<string | undefined> => {
  const response = await new RestApiClient().get<{ data?: { whatsappConversations?: { lastMessageAt?: string }[] } }>(
    '/rest/whatsappConversations',
    {
      query: {
        order_by: 'lastMessageAt[DescNullsLast]',
        limit: 1,
        ...(personId ? { filter: `personId[eq]:"${personId}"` } : {}),
      },
    },
  );
  return response.data?.whatsappConversations?.[0]?.lastMessageAt;
};

type WhatsAppThreadProps = { personId?: string };

// http(s) URLs only, so a message can never produce a javascript: link.
// Trailing punctuation (as in "see https://example.com.") stays outside the link.
const URL_PATTERN = /(https?:\/\/[^\s]*[^\s.,;:!?)\]'"])/gi;

// Renders message text with its URLs as links opening in a new tab.
const TextWithLinks = ({ text }: { text: string }) =>
  text.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1 ? (
      <a key={index} href={part} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
        {part}
      </a>
    ) : (
      part
    ),
  );

const formatTime = (value?: string | null) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '';

export const WhatsAppThread = ({ personId }: WhatsAppThreadProps) => {
  const styles = getPreviewStyles();
  const isDark = useColorScheme() === 'dark';
  const [data, setData] = useState<InboxData>();
  const [selectedId, setSelectedId] = useState<string>();
  const selectedIdRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [requestId, setRequestId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendingLabel, setSendingLabel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showGroupMembers, setShowGroupMembers] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef('');
  const [view, setView] = useState<View>('open');
  const viewRef = useRef<View>('open');
  const [updating, setUpdating] = useState(false);

  // The search and view a list request was made for, to drop answers to filters since replaced.
  const currentFilterKey = () => `${viewRef.current}:${searchRef.current.trim()}`;

  // The list request for the current filters, so polling and selection never drop them.
  const listInbox = (conversationId?: string) => {
    const term = searchRef.current.trim();
    return {
      filterKey: currentFilterKey(),
      request: new RestApiClient().post<InboxData>('/s/whatsapp/messages/list', {
        ...(personId ? { personId } : { view: viewRef.current }),
        ...(conversationId ? { conversationId } : {}),
        ...(term ? { search: term } : {}),
      }),
    };
  };

  const markSelectedRead = async (next: InboxData) => {
    const conversation =
      next.selectedConversation ?? next.conversations.find((item) => item.id === next.selectedConversationId);

    if (
      !conversation?.unread ||
      !conversation.lastInboundAt ||
      !next.messages.some((message) => message.direction === 'INBOUND' && message.sentAt === conversation.lastInboundAt)
    ) {
      return;
    }

    try {
      const result = await new RestApiClient().post<{ lastReadAt: string }>('/s/whatsapp/messages/read', {
        conversationId: conversation.id,
        readThroughAt: conversation.lastInboundAt,
      });

      const markRead = (item: Conversation) =>
        item.id === conversation.id && item.lastInboundAt && item.lastInboundAt <= result.lastReadAt
          ? { ...item, lastReadAt: result.lastReadAt, unread: false }
          : item;
      setData((previous) =>
        previous
          ? {
              ...previous,
              conversations: previous.conversations.map(markRead),
              selectedConversation: previous.selectedConversation && markRead(previous.selectedConversation),
            }
          : previous,
      );
    } catch {
      // Keep the unread state so the next refresh can retry.
    }
  };

  const load = async (conversationId?: string, silent = false) => {
    if (!silent) {
      setLoading(true);
    }

    try {
      const { filterKey, request } = listInbox(conversationId);
      const next = await request;
      // A newer selection or search has been made since: its own request shows the result.
      if (conversationId !== selectedIdRef.current || filterKey !== currentFilterKey()) return;
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

  useEffect(() => {
    let active = true;
    let lastActivity: string | undefined;
    let polls = 0;
    const refresh = async () => {
      try {
        const requestedId = selectedIdRef.current;
        const { filterKey, request } = listInbox(requestedId);
        const next = await request;

        if (active && requestedId === selectedIdRef.current && filterKey === currentFilterKey()) {
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
      }
    };

    void refresh();
    const timer = setInterval(async () => {
      polls += 1;
      const activity = await fetchLatestActivity(personId).catch(() => lastActivity);

      if (active && (activity !== lastActivity || polls % FULL_RELOAD_EVERY === 0)) {
        lastActivity = activity;
        await refresh();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [personId]);

  // Reloads the list once typing pauses; the open conversation stays open.
  // `load` reads the latest search and selection through refs, so it is not a dependency.
  const searchMountedRef = useRef(false);
  useEffect(() => {
    searchRef.current = search;
    if (!searchMountedRef.current) {
      searchMountedRef.current = true;
      return;
    }
    const timer = setTimeout(() => void load(selectedIdRef.current, true), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const changeView = (next: View) => {
    if (next === viewRef.current) return;
    viewRef.current = next;
    setView(next);
    void load(selectedIdRef.current, true);
  };

  // Assigns, closes or reopens the open conversation. Shown at once, then confirmed by a reload.
  const updateConversation = async (patch: { status?: 'OPEN' | 'CLOSED'; assigneeId?: string | null }) => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || updating) return;

    const apply = (item: Conversation) => (item.id === conversationId ? { ...item, ...patch } : item);
    setUpdating(true);
    setError('');
    setData((previous) =>
      previous
        ? {
            ...previous,
            conversations: previous.conversations.map(apply),
            selectedConversation: previous.selectedConversation && apply(previous.selectedConversation),
          }
        : previous,
    );

    try {
      await new RestApiClient().post('/s/whatsapp/conversations/update', { conversationId, ...patch });
    } catch {
      setError(t('Could not update the conversation.'));
    } finally {
      setUpdating(false);
      await load(conversationId, true);
    }
  };

  const selectConversation = (conversationId: string) => {
    setDraft('');
    setAttachments([]);
    setRequestId(undefined);
    setNotice('');
    setShowGroupMembers(false);
    setSelectedId(conversationId);
    // Clear the previous conversation's messages so they never show under the new header.
    setData((previous) => (previous ? { ...previous, messages: [], groupMembers: undefined } : previous));
    selectedIdRef.current = conversationId;
    void load(conversationId);
  };

  const addFiles = (files: File[]) => {
    if (!selectedId || !connected || sending) return;
    const accepted = files
      .filter((file) => file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES)
      .map((file) => {
        if (file.name.trim()) return file;
        const extension =
          file.type === 'image/png'
            ? '.png'
            : file.type === 'image/jpeg'
              ? '.jpg'
              : file.type === 'video/mp4'
                ? '.mp4'
                : '';
        return new File([file], `pasted-file-${Date.now()}${extension}`, { type: file.type });
      });
    if (accepted.length !== files.length) setError(t('Files must be nonempty and at most 64 MB each.'));
    if (accepted.length) {
      setAttachments((previous) => [...previous, ...accepted.map((file) => ({ id: createRequestId(), file }))]);
      setNotice('');
    }
  };

  const send = async () => {
    if (
      !selectedId ||
      (!draft.trim() && attachments.length === 0) ||
      sendingRef.current ||
      data?.connectionState !== 'connected'
    ) {
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setError('');
    setNotice('');

    try {
      if (attachments.length) {
        let caption = draft;
        for (const attachment of attachments) {
          setSendingLabel(t('Uploading…'));
          const uploaded = attachment.uploaded ?? (await uploadWhatsAppAttachment(attachment.file));
          if (!attachment.uploaded) {
            setAttachments((previous) =>
              previous.map((item) => (item.id === attachment.id ? { ...item, uploaded } : item)),
            );
          }
          setSendingLabel(t('Sending…'));
          const result = await new RestApiClient().post<{ state: 'sent' | 'unknown' }>('/s/whatsapp/messages/send', {
            conversationId: selectedId,
            requestId: attachment.id,
            text: caption,
            attachment: {
              fileId: uploaded.fileId,
              label: attachment.file.name,
              mimeType: uploaded.mimeType || attachment.file.type || 'application/octet-stream',
              size: uploaded.size,
            },
          });
          if (result.state !== 'sent') {
            setNotice(t('Delivery is uncertain. Check WhatsApp before trying again.'));
            await load(selectedId, true);
            return;
          }
          setAttachments((previous) => previous.filter((item) => item.id !== attachment.id));
          if (caption) {
            setDraft('');
            caption = '';
          }
        }
        await load(selectedId, true);
        return;
      }
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
      } else {
        setNotice(t('Delivery is uncertain. Check WhatsApp before trying again.'));
      }

      await load(selectedId, true);
    } catch {
      setError(t('Could not confirm delivery. Your draft is saved here; retry uses the same request ID.'));
    } finally {
      sendingRef.current = false;
      setSending(false);
      setSendingLabel('');
    }
  };

  const selected =
    data?.selectedConversation?.id === selectedId
      ? data?.selectedConversation
      : data?.conversations.find((conversation) => conversation.id === selectedId);
  const searching = search.trim().length > 0;
  const memberName = (memberId?: string | null) =>
    memberId ? (data?.members?.find((member) => member.id === memberId)?.name ?? t('Someone')) : undefined;
  const views: { value: View; label: string }[] = [
    { value: 'open', label: t('Open') },
    { value: 'mine', label: t('Mine') },
    { value: 'closed', label: t('Closed') },
  ];
  const connected = data?.connectionState === 'connected';
  const connectionWarning =
    data?.connectionState === 'reconnecting'
      ? t('WhatsApp is reconnecting.')
      : data?.connectionState === 'unavailable'
        ? t('WhatsApp connection is unavailable.')
        : data?.connectionState === 'pairing'
          ? t('WhatsApp is waiting for a QR scan.')
          : data?.connectionState === 'disconnected'
            ? t('WhatsApp is disconnected.')
            : undefined;
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
    <section
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer?.files ?? []));
      }}
      style={{
        ...styles.root,
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gap: themeCssVariables.spacing[3],
        height: personId ? 'calc(100dvh - 140px)' : '100%',
        minHeight: personId ? 420 : 560,
        padding: personId ? 0 : themeCssVariables.spacing[3],
      }}
    >
      <header
        style={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between',
          gap: themeCssVariables.spacing[2],
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: personId ? 16 : 20 }}>{personId ? t('WhatsApp') : t('WhatsApp inbox')}</h2>
          {!personId && <p style={styles.muted}>{t('Shared direct and group conversations in this workspace.')}</p>}
        </div>
        {connectionWarning && (
          <span
            role="alert"
            style={{ color: themeCssVariables.color.red, fontSize: themeCssVariables.font.size.sm, textAlign: 'right' }}
          >
            {connectionWarning}{' '}
            <a href="/settings/applications" style={{ color: 'inherit', textDecoration: 'underline' }}>
              {t('App settings')}
            </a>
          </span>
        )}
      </header>
      <div
        style={{
          ...styles.card,
          display: 'grid',
          gridTemplateColumns: personId ? 'minmax(0, 1fr)' : 'minmax(200px, 30%) minmax(0, 1fr)',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {!personId && (
          <aside
            aria-label={t('Conversations')}
            style={{ borderRight: `1px solid ${themeCssVariables.border.color.medium}`, overflowY: 'auto' }}
          >
            <div
              style={{
                background: themeCssVariables.background.primary,
                borderBottom: `1px solid ${themeCssVariables.border.color.medium}`,
                padding: themeCssVariables.spacing[2],
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <input
                type="search"
                aria-label={t('Search conversations')}
                placeholder={t('Search conversations')}
                value={search}
                maxLength={100}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearch('');
                }}
                style={{
                  background: themeCssVariables.background.secondary,
                  border: `1px solid ${themeCssVariables.border.color.medium}`,
                  borderRadius: themeCssVariables.border.radius.sm,
                  boxSizing: 'border-box',
                  color: themeCssVariables.font.color.primary,
                  fontFamily: themeCssVariables.font.family,
                  fontSize: themeCssVariables.font.size.md,
                  padding: themeCssVariables.spacing[2],
                  width: '100%',
                }}
              />
              <div
                role="tablist"
                aria-label={t('Conversation filter')}
                style={{ display: 'flex', gap: themeCssVariables.spacing[1], marginTop: themeCssVariables.spacing[2] }}
              >
                {views.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={view === option.value}
                    onClick={() => changeView(option.value)}
                    style={{
                      background: view === option.value ? themeCssVariables.background.secondary : 'transparent',
                      border: 0,
                      borderRadius: themeCssVariables.border.radius.sm,
                      color: view === option.value ? themeCssVariables.font.color.primary : styles.muted.color,
                      cursor: 'pointer',
                      fontFamily: themeCssVariables.font.family,
                      fontSize: themeCssVariables.font.size.sm,
                      fontWeight: view === option.value ? 600 : 500,
                      padding: `${themeCssVariables.spacing[1]} ${themeCssVariables.spacing[2]}`,
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {loading && !data && (
              <p style={{ ...styles.muted, padding: themeCssVariables.spacing[3] }}>{t('Loading conversations…')}</p>
            )}
            {!loading && data?.conversations.length === 0 && (
              <p style={{ ...styles.muted, padding: themeCssVariables.spacing[3] }}>
                {searching
                  ? t('No conversations match this search.')
                  : view === 'mine'
                    ? t('No open conversations assigned to you.')
                    : view === 'closed'
                      ? t('No closed conversations.')
                      : t('No open conversations.')}
              </p>
            )}
            {data?.conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => selectConversation(conversation.id)}
                style={{
                  background: conversation.unread
                    ? isDark
                      ? '#182635'
                      : '#eef4ff'
                    : conversation.id === selectedId
                      ? themeCssVariables.background.secondary
                      : themeCssVariables.background.primary,
                  border: 0,
                  borderBottom: `1px solid ${themeCssVariables.border.color.medium}`,
                  borderLeft: `3px solid ${conversation.unread ? themeCssVariables.color.blue : 'transparent'}`,
                  color: themeCssVariables.font.color.primary,
                  cursor: 'pointer',
                  display: 'grid',
                  fontFamily: themeCssVariables.font.family,
                  gap: 4,
                  padding: themeCssVariables.spacing[3],
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span
                  style={{
                    alignItems: 'center',
                    display: 'flex',
                    gap: themeCssVariables.spacing[2],
                    justifyContent: 'space-between',
                  }}
                >
                  <strong style={{ fontWeight: conversation.unread ? 700 : 600 }}>{conversation.name}</strong>
                  {conversation.assigneeId && (
                    <small style={{ ...styles.label, flexShrink: 0 }}>
                      {conversation.assigneeId === data?.currentMemberId
                        ? t('You')
                        : memberName(conversation.assigneeId)}
                    </small>
                  )}
                </span>
                <span
                  style={{
                    ...styles.muted,
                    color: conversation.unread ? themeCssVariables.font.color.primary : styles.muted.color,
                    fontWeight: conversation.unread ? 600 : undefined,
                  }}
                >
                  {conversation.lastPreview ?? t('No messages yet')}
                </span>
                <small
                  style={{
                    ...styles.label,
                    color: conversation.unread ? themeCssVariables.color.blue : styles.label.color,
                    fontWeight: conversation.unread ? 600 : undefined,
                  }}
                >
                  {formatTime(conversation.lastMessageAt)}
                </small>
              </button>
            ))}
          </aside>
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateRows: personId ? 'minmax(0, 1fr) auto' : 'auto minmax(0, 1fr) auto',
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {!personId && (
            <div
              style={{
                borderBottom: `1px solid ${themeCssVariables.border.color.medium}`,
                display: 'grid',
                gap: themeCssVariables.spacing[2],
                padding: themeCssVariables.spacing[3],
              }}
            >
              <div
                style={{
                  alignItems: 'center',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: themeCssVariables.spacing[2],
                }}
              >
                <strong>{selected?.name ?? t('Select a conversation')}</strong>
                <div style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[2] }}>
                  {isGroup && data?.groupMembers && (
                    <PreviewButton onClick={() => setShowGroupMembers((previous) => !previous)}>
                      {showGroupMembers ? t('Hide members') : `${t('Members')} (${data.groupMembers.length})`}
                    </PreviewButton>
                  )}
                  {selected && data?.members && (
                    <select
                      aria-label={t('Assignee')}
                      value={selected.assigneeId ?? ''}
                      disabled={updating}
                      onChange={(event) => void updateConversation({ assigneeId: event.target.value || null })}
                      style={{
                        background: themeCssVariables.background.primary,
                        border: `1px solid ${themeCssVariables.border.color.medium}`,
                        borderRadius: themeCssVariables.border.radius.sm,
                        color: themeCssVariables.font.color.primary,
                        fontFamily: themeCssVariables.font.family,
                        fontSize: themeCssVariables.font.size.sm,
                        maxWidth: 180,
                        padding: themeCssVariables.spacing[1],
                      }}
                    >
                      <option value="">{t('Unassigned')}</option>
                      {data.members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.id === data.currentMemberId ? `${member.name} (${t('you')})` : member.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {selected && data?.members && (
                    <PreviewButton
                      disabled={updating}
                      onClick={() =>
                        void updateConversation({ status: selected.status === 'CLOSED' ? 'OPEN' : 'CLOSED' })
                      }
                    >
                      {selected.status === 'CLOSED' ? t('Reopen') : t('Close')}
                    </PreviewButton>
                  )}
                </div>
              </div>
              {isGroup && showGroupMembers && data?.groupMembers && (
                <div
                  aria-label={t('Group members')}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: themeCssVariables.spacing[2],
                    maxHeight: 120,
                    overflowY: 'auto',
                  }}
                >
                  {data.groupMembers.map((member) => (
                    <span
                      key={member.id}
                      style={{
                        ...styles.label,
                        background: themeCssVariables.background.secondary,
                        borderRadius: themeCssVariables.border.radius.sm,
                        padding: themeCssVariables.spacing[1],
                      }}
                    >
                      {member.isMe
                        ? `${t('You')}${member.displayName ? ` · ${member.displayName}` : ''}`
                        : member.displayName || member.phoneNumber || member.id}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            key={`${selectedId}:${latestMessageId}`}
            aria-label={t('Message thread')}
            style={{
              backgroundColor: isDark ? '#0b141a' : '#faf7f2',
              backgroundImage: `url("${getPublicAssetUrl(isDark ? 'whatsapp-wallpaper-dark.png' : 'whatsapp-wallpaper.png')}")`,
              backgroundRepeat: 'repeat',
              backgroundSize: '485px auto',
              display: 'flex',
              flexDirection: 'column-reverse',
              gap: themeCssVariables.spacing[2],
              overflowY: 'auto',
              padding: themeCssVariables.spacing[3],
            }}
          >
            {personId && loading && !data && (
              <p style={{ color: isDark ? '#8696a0' : '#667781' }}>{t('Loading conversation…')}</p>
            )}
            {personId && !loading && !selected && (
              <p style={{ color: isDark ? '#8696a0' : '#667781' }}>
                {t('No WhatsApp conversation for this Person yet.')}
              </p>
            )}
            {selected && !loading && data?.messages.length === 0 && <p style={styles.muted}>{t('No messages yet.')}</p>}
            {data?.messages
              .slice()
              .reverse()
              .map((message) => (
                <div
                  key={message.id}
                  style={{
                    alignSelf: message.direction === 'OUTBOUND' ? 'flex-end' : 'flex-start',
                    background:
                      message.direction === 'OUTBOUND' ? (isDark ? '#005c4b' : '#d9fdd3') : isDark ? '#202c33' : '#fff',
                    border: isDark ? '1px solid #26343d' : '1px solid #e9e7e3',
                    borderRadius: themeCssVariables.border.radius.md,
                    color: isDark ? '#e9edef' : '#202c33',
                    maxWidth: '78%',
                    padding: `${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]}`,
                  }}
                >
                  {isGroup && message.direction === 'INBOUND' && (
                    <strong
                      style={{
                        color: isDark ? '#53bdeb' : '#075e54',
                        display: 'block',
                        fontSize: themeCssVariables.font.size.sm,
                        marginBottom: 4,
                      }}
                    >
                      {memberNameById.get(message.senderId ?? '') ||
                        message.senderName ||
                        message.senderId?.split('@')[0] ||
                        t('Group participant')}
                    </strong>
                  )}
                  {message.media?.[0]?.url && message.mediaKind === 'IMAGE' && (
                    <a
                      href={message.media[0].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('Open image')}
                    >
                      <img
                        src={message.media[0].url}
                        alt={message.text === '[Image]' ? t('WhatsApp image') : message.text}
                        loading="lazy"
                        style={{
                          display: 'block',
                          maxHeight: 360,
                          maxWidth: '100%',
                          borderRadius: themeCssVariables.border.radius.sm,
                          objectFit: 'contain',
                        }}
                      />
                    </a>
                  )}
                  {message.media?.[0]?.url && message.mediaKind === 'VIDEO' && (
                    <video
                      controls
                      preload="metadata"
                      aria-label={t('WhatsApp video')}
                      style={{
                        display: 'block',
                        maxHeight: 360,
                        maxWidth: '100%',
                        borderRadius: themeCssVariables.border.radius.sm,
                      }}
                      src={message.media[0].url}
                    />
                  )}
                  {message.media?.[0]?.url && message.mediaKind === 'AUDIO' && (
                    <audio
                      controls
                      preload="metadata"
                      aria-label={t('WhatsApp audio message')}
                      src={message.media[0].url}
                      style={{ display: 'block', maxWidth: '100%', width: 320 }}
                    />
                  )}
                  {message.media?.[0]?.url && message.mediaKind === 'DOCUMENT' && (
                    <a
                      href={message.media[0].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'inherit', textDecoration: 'underline' }}
                    >
                      {message.media[0].label || t('Download file')}
                    </a>
                  )}
                  {message.mediaKind && !message.media?.[0]?.url && (
                    <div style={{ color: isDark ? '#8696a0' : '#667781' }}>
                      {message.mediaKind === 'IMAGE'
                        ? t('Image unavailable')
                        : message.mediaKind === 'VIDEO'
                          ? t('Video unavailable')
                          : message.mediaKind === 'AUDIO'
                            ? t('Audio unavailable')
                            : t('File unavailable')}
                    </div>
                  )}
                  {(!message.mediaKind || !['[Image]', '[Video]', '[Audio]', '[File]'].includes(message.text)) && (
                    <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                      <TextWithLinks text={message.text} />
                    </div>
                  )}
                  <small
                    style={{ ...styles.label, color: isDark ? '#aebac1' : '#667781', display: 'block', marginTop: 6 }}
                  >
                    {formatTime(message.sentAt)}
                    {message.direction === 'OUTBOUND' ? ` · ${message.deliveryState.toLowerCase()}` : ''}
                  </small>
                </div>
              ))}
          </div>
          <div
            style={{
              borderTop: `1px solid ${themeCssVariables.border.color.medium}`,
              display: 'grid',
              gap: themeCssVariables.spacing[2],
              padding: themeCssVariables.spacing[3],
            }}
          >
            {error && (
              <p role="alert" style={{ color: themeCssVariables.color.red, margin: 0 }}>
                {error}
              </p>
            )}
            {notice && (
              <p
                role="status"
                style={{
                  background: themeCssVariables.background.secondary,
                  border: `1px solid ${themeCssVariables.border.color.medium}`,
                  borderLeft: `3px solid ${themeCssVariables.color.blue}`,
                  borderRadius: themeCssVariables.border.radius.sm,
                  color: themeCssVariables.font.color.primary,
                  fontWeight: 600,
                  margin: 0,
                  padding: themeCssVariables.spacing[2],
                }}
              >
                {notice}
              </p>
            )}
            {attachments.length > 0 && (
              <div
                aria-label={t('Files to send')}
                style={{ display: 'flex', flexWrap: 'wrap', gap: themeCssVariables.spacing[2] }}
              >
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    style={{
                      ...styles.label,
                      alignItems: 'center',
                      background: themeCssVariables.background.secondary,
                      borderRadius: themeCssVariables.border.radius.sm,
                      display: 'inline-flex',
                      gap: themeCssVariables.spacing[2],
                      padding: themeCssVariables.spacing[2],
                    }}
                  >
                    {attachment.file.name} · {(attachment.file.size / 1024 / 1024).toFixed(1)} MB
                    <button
                      type="button"
                      aria-label={`${t('Remove')} ${attachment.file.name}`}
                      disabled={sending}
                      onClick={() => setAttachments((previous) => previous.filter((item) => item.id !== attachment.id))}
                      style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer' }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              aria-label={t('Write a WhatsApp message')}
              placeholder={
                selected
                  ? t('Write a message…')
                  : personId
                    ? t('No conversation yet')
                    : t('Select a conversation first')
              }
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setRequestId(undefined);
                setNotice('');
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length) {
                  event.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !('isComposing' in event && event.isComposing)) {
                  event.preventDefault();
                  if (!event.repeat) void send();
                }
              }}
              disabled={!selected || !connected || sending}
              rows={personId ? 2 : 3}
              maxLength={4096}
              style={{
                background: themeCssVariables.background.primary,
                border: `1px solid ${themeCssVariables.border.color.medium}`,
                borderRadius: themeCssVariables.border.radius.sm,
                color: themeCssVariables.font.color.primary,
                fontFamily: themeCssVariables.font.family,
                fontSize: themeCssVariables.font.size.md,
                padding: themeCssVariables.spacing[2],
                resize: 'vertical',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
            <div
              style={{
                alignItems: 'center',
                display: 'flex',
                justifyContent: 'space-between',
                gap: themeCssVariables.spacing[2],
              }}
            >
              <span
                style={{
                  ...styles.button,
                  cursor: !selected || !connected || sending ? 'not-allowed' : 'pointer',
                  opacity: !selected || !connected || sending ? 0.5 : 1,
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <span aria-hidden="true">{t('Attach files')}</span>
                <input
                  type="file"
                  multiple
                  aria-label={t('Attach files')}
                  disabled={!selected || !connected || sending}
                  onChange={(event) => {
                    addFiles(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                  style={{
                    cursor: 'pointer',
                    height: '100%',
                    inset: 0,
                    opacity: 0,
                    position: 'absolute',
                    width: '100%',
                  }}
                />
              </span>
              <PreviewButton
                primary
                disabled={!selected || !connected || (!draft.trim() && attachments.length === 0) || sending}
                onClick={() => void send()}
              >
                {sending ? sendingLabel : t('Send')}
              </PreviewButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
