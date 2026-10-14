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

type HistoryCandidate = {
  chatId: string;
  name: string;
  messageCount: number;
  lastMessageAt?: string;
  match: 'matched' | 'new' | 'ambiguous';
  personName?: string;
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

const rangeOptions: { value: RangeDays; label: string }[] = [
  { value: 30, label: t('Last 30 days') },
  { value: 90, label: t('Last 90 days') },
  { value: 0, label: t('All available') },
];

export const WhatsAppHistoryImport = () => {
  const styles = getPreviewStyles();
  const [reviewing, setReviewing] = useState(false);
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [items, setItems] = useState<HistoryCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [historyReceivedAt, setHistoryReceivedAt] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async (range: RangeDays, offset: number) => {
    setWorking(true);
    setError('');
    setNotice('');

    try {
      const response = await new RestApiClient().post('/s/whatsapp/history', {
        action: 'list', rangeDays: range, offset,
      }) as HistoryList;

      setItems((previous) => offset === 0 ? response.items : [...previous, ...response.items]);
      setTotal(response.total);
      setHistoryReceivedAt(response.historyReceivedAt);
      setReviewing(true);
    } catch {
      setError(t('Could not load WhatsApp history. Check the bridge and retry.'));
    } finally {
      setWorking(false);
    }
  };

  const changeRange = (range: RangeDays) => {
    setRangeDays(range);
    setItems([]);
    setSelected([]);
    setAcknowledged(false);
    void load(range, 0);
  };

  const toggle = (chatId: string, checked: boolean) => {
    setSelected((previous) => checked ? [...previous, chatId] : previous.filter((id) => id !== chatId));
  };

  const visibleConversations = items.filter((item) => item.messageCount > 0 && item.match !== 'ambiguous');
  const selectedConversations = visibleConversations.filter((item) => selected.includes(item.chatId));
  const allShownSelected = visibleConversations.length > 0 && selectedConversations.length === visibleConversations.length;
  const someShownSelected = selectedConversations.length > 0 && !allShownSelected;

  const importSelected = async () => {
    setWorking(true);
    setError('');
    setNotice('');
    let imported = 0;
    let createdPeople = 0;

    try {
      const chosen = items.filter((item) => selected.includes(item.chatId));

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
      await load(rangeDays, 0);
      setNotice(`${t('Import complete')}: ${imported} ${t('messages')}, ${createdPeople} ${t('new People')}.`);
    } catch {
      setNotice('');
      setError(t('Import stopped. Completed records were saved. Review and retry; duplicate messages will be skipped.'));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section style={{ ...styles.card, display: 'grid', gap: themeCssVariables.spacing[4], padding: themeCssVariables.spacing[4] }} aria-label={t('Import existing history')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: themeCssVariables.spacing[2] }}>
        <IconHistory size={themeCssVariables.icon.size.md} />
        <strong>{t('Import existing history')}</strong>
        <Tag color="gray" variant="soft">{t('Optional')}</Tag>
      </div>
      <p style={{ ...styles.muted, margin: 0 }}>
        {t('Review available one-to-one text conversations and contacts before sharing them with this workspace. Start with the last 30 days; nothing is imported automatically.')}
      </p>
      {!reviewing && (
        <div>
          <Button type="button" variant="solid" color="accent" size="sm" onClick={() => void load(rangeDays, 0)} loading={working}>
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
          {!historyReceivedAt && (
            <Callout variant="warning" title={t('Earlier history may be missing')} description={t('This device was linked before history capture was enabled, or WhatsApp has not sent a history sync. A new QR link may be needed to receive older chats.')} />
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
              {items.map((item) => (
                <label key={item.chatId} style={{ alignItems: 'center', borderTop: `1px solid ${themeCssVariables.border.color.light}`, display: 'flex', gap: themeCssVariables.spacing[3], padding: `${themeCssVariables.spacing[2]} 0` }}>
                  <FrontComponentCheckbox checked={selected.includes(item.chatId)} disabled={working || item.match === 'ambiguous'} onChange={(event) => toggle(item.chatId, event.target.checked)} aria-label={`${t('Select')} ${item.name}`} />
                  <span style={{ display: 'grid', gap: themeCssVariables.spacing[1], minWidth: 0, flex: 1 }}>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</strong>
                    <span style={styles.muted}>{item.messageCount} {t('text messages in range')} · {item.chatId.split('@')[0]}</span>
                  </span>
                  <Tag color={item.match === 'matched' ? 'green' : item.match === 'ambiguous' ? 'orange' : 'blue'} variant="soft">
                    {item.match === 'matched' ? t('Matched Person') : item.match === 'ambiguous' ? t('Ambiguous match') : t('New Person')}
                  </Tag>
                </label>
              ))}
              {items.length < total && (
                <div><Button type="button" variant="outline" size="sm" onClick={() => void load(rangeDays, items.length)} loading={working}>{t('Load more conversations')}</Button></div>
              )}
            </div>
          )}
          <p style={{ ...styles.muted, margin: 0 }}>{t('Select all covers loaded conversations only. Contacts without messages must be selected individually. New People are created only for selected unmatched contacts. Groups, media, and calls are excluded.')}</p>
          {selected.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: themeCssVariables.spacing[2] }}>
              <FrontComponentCheckbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} aria-label={t('Acknowledge workspace sharing')} />
              <span style={styles.muted}>{t('I understand selected contacts and messages will be visible to workspace members with access to these records.')}</span>
            </label>
          )}
          <div style={{ display: 'flex', gap: themeCssVariables.spacing[2], alignItems: 'center' }}>
            <Button type="button" variant="solid" color="accent" size="sm" disabled={selected.length === 0 || !acknowledged} loading={working} onClick={() => void importSelected()}>{t('Import selected')}</Button>
            <span style={styles.label}>{selected.length} {t('selected')}</span>
          </div>
        </>
      )}
      {notice && <p role="status" style={{ ...styles.muted, margin: 0 }}>{notice}</p>}
      {error && <Callout variant="error" title={t('History import unavailable')} description={error} />}
    </section>
  );
};
