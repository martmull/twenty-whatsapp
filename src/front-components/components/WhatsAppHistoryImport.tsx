import { useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { t } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components';
import { IconHistory } from 'twenty-ui/icon';
import { Tag } from 'twenty-ui/primitives/data-display';
import { Button } from 'twenty-ui/primitives/input';
import { themeCssVariables } from 'twenty-ui/theme';
import 'twenty-ui/style.css';

import { getPreviewStyles } from 'src/front-components/components/PreviewUi';
import { FrontComponentCheckbox } from 'src/front-components/components/FrontComponentCheckbox';

type RangeDays = 0 | 30 | 90;
type ChatFilter = 'all' | 'direct' | 'group';

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
  match: 'matched' | 'new' | 'ambiguous' | 'group';
  personName?: string;
  renameable?: boolean;
};

type HistoryList = {
  items: HistoryCandidate[];
  total: number;
  historyReceivedAt?: string;
};

type ImportResult = {
  imported: number;
  nextOffset?: number;
  createdPerson: boolean;
};

type GroupMember = {
  id: string;
  phoneNumber?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  isMe?: boolean;
};

const rangeOptions: { value: RangeDays; label: string }[] = [
  { value: 30, label: t('Last 30 days') },
  { value: 90, label: t('Last 90 days') },
  { value: 0, label: t('All available') },
];

export const WhatsAppHistoryImport = () => {
  const styles = getPreviewStyles();
  const [reviewing, setReviewing] = useState(false);
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const [items, setItems] = useState<HistoryCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [historyReceivedAt, setHistoryReceivedAt] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, { firstName: string; lastName: string }>>({});
  const [membersByChat, setMembersByChat] = useState<Record<string, GroupMember[]>>({});
  const [openMembersChatId, setOpenMembersChatId] = useState<string>();
  const [loadingMembersChatId, setLoadingMembersChatId] = useState<string>();
  const [membersError, setMembersError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [workingAction, setWorkingAction] = useState<'review' | 'load-more' | 'import' | null>(null);
  const working = workingAction !== null;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async (range: RangeDays, offset: number, action: 'review' | 'load-more' | 'import' = 'review', kind: ChatFilter = chatFilter) => {
    setWorkingAction(action);
    setError('');
    setNotice('');

    try {
      const response = await new RestApiClient().post('/s/whatsapp/history', {
        action: 'list', rangeDays: range, kind, offset,
      }) as HistoryList;

      setItems((previous) => offset === 0 ? response.items : [...previous, ...response.items]);
      setTotal(response.total);
      setHistoryReceivedAt(response.historyReceivedAt);
      setReviewing(true);
    } catch {
      setError(t('Could not load WhatsApp history. Check the bridge and retry.'));
    } finally {
      setWorkingAction(null);
    }
  };

  const changeRange = (range: RangeDays) => {
    setRangeDays(range);
    setItems([]);
    setSelected([]);
    setNames({});
    setOpenMembersChatId(undefined);
    setAcknowledged(false);
    void load(range, 0);
  };

  const changeFilter = (kind: ChatFilter) => {
    setChatFilter(kind);
    setItems([]);
    setSelected([]);
    setOpenMembersChatId(undefined);
    setAcknowledged(false);
    void load(rangeDays, 0, 'review', kind);
  };

  const toggle = (chatId: string, checked: boolean) => {
    setSelected((previous) => checked ? [...previous, chatId] : previous.filter((id) => id !== chatId));
  };

  const showMembers = async (chatId: string) => {
    if (openMembersChatId === chatId) {
      setOpenMembersChatId(undefined);
      return;
    }

    setOpenMembersChatId(chatId);
    setMembersError('');
    if (membersByChat[chatId]) {
      return;
    }

    setLoadingMembersChatId(chatId);
    try {
      const members = await new RestApiClient().post<GroupMember[]>('/s/whatsapp/history', {
        action: 'members', rangeDays, chatId,
      });
      setMembersByChat((previous) => ({ ...previous, [chatId]: members }));
    } catch {
      setMembersError(t('Could not load group members. Check the connection and retry.'));
    } finally {
      setLoadingMembersChatId(undefined);
    }
  };

  const visibleConversations = items.filter((item) => item.messageCount > 0 && item.match !== 'ambiguous');
  const selectedConversations = visibleConversations.filter((item) => selected.includes(item.chatId));
  const allShownSelected = visibleConversations.length > 0 && selectedConversations.length === visibleConversations.length;
  const someShownSelected = selectedConversations.length > 0 && !allShownSelected;

  const importSelected = async () => {
    setWorkingAction('import');
    setError('');
    setNotice('');
    let imported = 0;
    let createdPeople = 0;

    try {
      const chosen = items.filter((item) => selected.includes(item.chatId));
      const missingName = chosen.find((item) => {
        if (item.match !== 'new' && !item.renameable) {
          return false;
        }
        const suggested = /^\+?\d+$/.test(item.name) ? '' : item.name.trim().split(/\s+/)[0];
        return !(names[item.chatId]?.firstName.trim() || suggested);
      });
      if (missingName) {
        setError(t('Enter a first name for contacts whose name is unavailable before importing.'));
        return;
      }

      for (const [index, item] of chosen.entries()) {
        setNotice(`${t('Importing')} ${index + 1} / ${chosen.length}…`);
        let offset = 0;

        while (true) {
          const result = await new RestApiClient().post('/s/whatsapp/history', {
            action: 'import',
            rangeDays,
            chatId: item.chatId,
            offset,
            createPerson: item.match === 'new',
            ...(item.match === 'new' || item.renameable ? names[item.chatId] : {}),
            acknowledged,
          }) as ImportResult;
          imported += result.imported;
          createdPeople += Number(result.createdPerson);

          if (result.nextOffset === undefined) {
            break;
          }

          offset = result.nextOffset;
        }
      }

      setSelected([]);
      setAcknowledged(false);
      await load(rangeDays, 0, 'import');
      setNotice(`${t('Import complete')}: ${imported} ${t('messages')}, ${createdPeople} ${t('new People')}.`);
    } catch {
      setNotice('');
      setError(t('Import stopped. Completed records were saved. Review and retry; duplicate messages will be skipped.'));
    } finally {
      setWorkingAction(null);
    }
  };

  return (
    <section style={{ ...styles.card, display: 'grid', gap: themeCssVariables.spacing[4], padding: themeCssVariables.spacing[4] }} aria-label={t('Import existing history')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: themeCssVariables.spacing[2] }}>
        <IconHistory size={themeCssVariables.icon.size.md} />
        <strong>{t('Import existing history')}</strong>
        <Tag color="gray" variant="soft" preventShrink>{t('Optional')}</Tag>
      </div>
      <p style={{ ...styles.muted, margin: 0 }}>
        {t('Review available direct and group conversations before sharing them with this workspace. Text, available images, videos, and audio can be imported. Start with the last 30 days; nothing is imported automatically.')}
      </p>
      {!reviewing && (
        <div>
          <Button type="button" variant="solid" color="accent" size="sm" onClick={() => void load(rangeDays, 0)} loading={workingAction === 'review'}>
            {t('Review available history')}
          </Button>
        </div>
      )}
      {reviewing && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: themeCssVariables.spacing[2] }}>
            <span style={styles.muted}>{t('Messages from')}</span>
            {rangeOptions.map((option) => (
              <Button key={option.value} type="button" variant={rangeDays === option.value ? 'solid' : 'outline'} color={rangeDays === option.value ? 'accent' : 'neutral'} size="sm" disabled={working} onClick={() => changeRange(option.value)}>
                {option.label}
              </Button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: themeCssVariables.spacing[2] }}>
            <span style={styles.muted}>{t('Show')}</span>
            {([{ value: 'all', label: t('All chats') }, { value: 'direct', label: t('Direct') }, { value: 'group', label: t('Groups') }] as const).map((option) => (
              <Button key={option.value} type="button" variant={chatFilter === option.value ? 'solid' : 'outline'} color={chatFilter === option.value ? 'accent' : 'neutral'} size="sm" disabled={working} onClick={() => changeFilter(option.value)}>{option.label}</Button>
            ))}
          </div>
          {!historyReceivedAt && (
            <Callout variant="warning" title={t('Earlier history may be missing')} description={t('This device was linked before history capture was enabled, or WhatsApp has not sent a history sync. A new QR link may be needed to receive older chats.')} />
          )}
          {chatFilter === 'group' && items.length > 0 && items.every((item) => item.messageCount === 0) && (
            <Callout variant="warning" title={t('Group messages are not available yet')} description={t('This linked device discovered your groups, but earlier group texts were not captured. Groups without a last message date appear alphabetically after dated chats. You can import a selected group now for future messages. To recover earlier texts and dates, WhatsApp may need to send a new history sync after linking the device again.')} />
          )}
          {items.length === 0 && !working && (
            <Callout variant="info" title={t('No available history in this range')} description={t('Try a wider date range. If nothing appears, WhatsApp may need a fresh linked-device pairing to send earlier history.')} />
          )}
          {items.length > 0 && (
            <div style={{ display: 'grid', gap: themeCssVariables.spacing[2] }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: themeCssVariables.spacing[2] }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: themeCssVariables.spacing[2] }}>
                  <FrontComponentCheckbox checked={allShownSelected} onChange={(event) => {
                    const checked = event.target.checked;
                    const chatIds = visibleConversations.map((item) => item.chatId);
                    setSelected((previous) => checked ? [...new Set([...previous, ...chatIds])] : previous.filter((id) => !chatIds.includes(id)));
                  }} aria-checked={someShownSelected ? 'mixed' : allShownSelected} aria-label={t('Select all shown conversations')} />
                  <span>{t('Select all shown conversations')}</span>
                </label>
                <span style={styles.label}>{items.length} / {total}</span>
              </div>
              {items.map((item) => {
                const [suggestedFirstName, ...suggestedLastName] = /^\+?\d+$/.test(item.name) ? ['', ''] : item.name.trim().split(/\s+/);
                const name = names[item.chatId] ?? { firstName: suggestedFirstName, lastName: suggestedLastName.join(' ') };

                return (
                  <div key={item.chatId} style={{ borderTop: `1px solid ${themeCssVariables.border.color.light}`, display: 'grid', gap: themeCssVariables.spacing[2], padding: `${themeCssVariables.spacing[2]} 0` }}>
                    <label style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[3] }}>
                      <FrontComponentCheckbox checked={selected.includes(item.chatId)} disabled={working || item.match === 'ambiguous'} onChange={(event) => toggle(item.chatId, event.target.checked)} aria-label={`${t('Select')} ${item.name}`} />
                      <span style={{ display: 'grid', gap: themeCssVariables.spacing[1], minWidth: 0, flex: 1 }}>
                        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</strong>
                        <span style={styles.muted}>{item.messageCount} {t('messages in range')}{item.lastMessageAt ? ` · ${new Date(item.lastMessageAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}` : ` · ${t('Last message date unavailable')}`}{item.kind === 'direct' ? ` · ${item.chatId.split('@')[0]}` : ''}</span>
                      </span>
                      <Tag color={item.match === 'matched' ? 'green' : item.match === 'ambiguous' ? 'orange' : 'blue'} variant="soft" preventShrink>
                        {item.match === 'group' ? t('Group') : item.match === 'matched' ? t('Matched Person') : item.match === 'ambiguous' ? t('Ambiguous match') : t('New Person')}
                      </Tag>
                    </label>
                    {item.kind === 'group' && (
                      <div style={{ paddingLeft: themeCssVariables.spacing[4] }}>
                        <Button type="button" variant="outline" size="sm" disabled={working} loading={loadingMembersChatId === item.chatId} onClick={() => void showMembers(item.chatId)}>
                          {openMembersChatId === item.chatId ? t('Hide members') : t('Show members')}
                        </Button>
                      </div>
                    )}
                    {item.kind === 'group' && openMembersChatId === item.chatId && (
                      <div style={{ ...styles.card, display: 'grid', gap: themeCssVariables.spacing[2], marginLeft: themeCssVariables.spacing[4], padding: themeCssVariables.spacing[3] }}>
                        <strong>{t('Current group members')} {membersByChat[item.chatId] ? `(${membersByChat[item.chatId].length})` : ''}</strong>
                        <span style={styles.muted}>{t('WhatsApp provides display names, not separate first and last names. The suggestions below split the available name and may need correction.')}</span>
                        {membersError && <span role="alert" style={{ color: themeCssVariables.color.red }}>{membersError}</span>}
                        {membersByChat[item.chatId] && (
                          <div style={{ display: 'grid', gap: themeCssVariables.spacing[2], maxHeight: 240, overflowY: 'auto' }}>
                            {membersByChat[item.chatId].length === 0 && <span style={styles.muted}>{t('No members available.')}</span>}
                            {membersByChat[item.chatId].map((member) => (
                              <div key={member.id} style={{ display: 'grid', gap: themeCssVariables.spacing[1] }}>
                                <strong>{member.isMe ? `${t('You')}${member.displayName ? ` · ${member.displayName}` : ''}` : member.displayName || member.phoneNumber || t('Name unavailable')}</strong>
                                <span style={styles.muted}>{member.displayName ? `${t('First name')}: ${member.firstName || '—'} · ${t('Last name')}: ${member.lastName || '—'}` : member.phoneNumber || member.id}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {(item.match === 'new' || item.renameable) && selected.includes(item.chatId) && (
                      <div style={{ display: 'flex', gap: themeCssVariables.spacing[2], paddingLeft: themeCssVariables.spacing[4] }}>
                        <input aria-label={`${t('First name')} · ${item.chatId.split('@')[0]}`} placeholder={t('First name')} value={name.firstName} maxLength={80} disabled={working} onChange={(event) => setNames((previous) => ({ ...previous, [item.chatId]: { ...name, firstName: event.target.value } }))} style={{ background: themeCssVariables.background.primary, border: `1px solid ${themeCssVariables.border.color.medium}`, borderRadius: themeCssVariables.border.radius.sm, color: themeCssVariables.font.color.primary, fontFamily: themeCssVariables.font.family, fontSize: themeCssVariables.font.size.md, minWidth: 0, flex: 1, padding: themeCssVariables.spacing[2] }} />
                        <input aria-label={`${t('Last name')} · ${item.chatId.split('@')[0]}`} placeholder={t('Last name')} value={name.lastName} maxLength={80} disabled={working} onChange={(event) => setNames((previous) => ({ ...previous, [item.chatId]: { ...name, lastName: event.target.value } }))} style={{ background: themeCssVariables.background.primary, border: `1px solid ${themeCssVariables.border.color.medium}`, borderRadius: themeCssVariables.border.radius.sm, color: themeCssVariables.font.color.primary, fontFamily: themeCssVariables.font.family, fontSize: themeCssVariables.font.size.md, minWidth: 0, flex: 1, padding: themeCssVariables.spacing[2] }} />
                      </div>
                    )}
                  </div>
                );
              })}
              {items.length < total && (
                <div><Button type="button" variant="outline" size="sm" onClick={() => void load(rangeDays, items.length, 'load-more')} disabled={working} loading={workingAction === 'load-more'}>{t('Load more conversations')}</Button></div>
              )}
            </div>
          )}
          <p style={{ ...styles.muted, margin: 0 }}>{t('Select all covers loaded conversations with messages only. Chats without messages must be selected individually. New People are created only for selected unmatched direct contacts. Group participants are not created as People. Available images, videos, and audio up to 64 MB are imported; older media may be unavailable. Calls and other attachments are excluded.')}</p>
          {selected.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: themeCssVariables.spacing[2] }}>
              <FrontComponentCheckbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} aria-label={t('Acknowledge workspace sharing')} />
              <span style={styles.muted}>{t('I understand selected direct contacts, group conversations, participants, messages, images, videos, and audio will be visible to workspace members with access to these records.')}</span>
            </label>
          )}
          <div style={{ display: 'flex', gap: themeCssVariables.spacing[2], alignItems: 'center' }}>
            <Button type="button" variant="solid" color="accent" size="sm" disabled={working || selected.length === 0 || !acknowledged} loading={workingAction === 'import'} onClick={() => void importSelected()}>{t('Import selected')}</Button>
            <span style={styles.label}>{selected.length} {t('selected')}</span>
          </div>
        </>
      )}
      {notice && <p role="status" style={{ ...styles.muted, margin: 0 }}>{notice}</p>}
      {error && <Callout variant="error" title={t('History import unavailable')} description={error} />}
    </section>
  );
};
