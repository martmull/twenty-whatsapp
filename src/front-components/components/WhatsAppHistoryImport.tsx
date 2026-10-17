import { useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { t } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components';
import { IconHistory } from 'twenty-ui/icon';
import { Button } from 'twenty-ui/primitives/input';
import { themeCssVariables } from 'twenty-ui/theme';
import 'twenty-ui/style.css';

import { getPreviewStyles } from 'src/front-components/components/PreviewUi';
import { FrontComponentCheckbox } from 'src/front-components/components/FrontComponentCheckbox';

type RangeDays = 7 | 30 | 90 | 365;

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  firstName?: string;
  messageCount: number;
  match: 'matched' | 'new' | 'ambiguous' | 'group';
};

type HistoryList = { items: HistoryCandidate[]; total: number };

type ImportResult = { imported: number; total: number; nextOffset?: number; createdPerson: boolean };

const RANGE_OPTIONS: { value: RangeDays; label: string }[] = [
  { value: 7, label: t('Last week') },
  { value: 30, label: t('Last month') },
  { value: 90, label: t('Last 3 months') },
  { value: 365, label: t('Last year') },
];

const hasContactName = (candidate: HistoryCandidate) =>
  Boolean(candidate.firstName) || !/^\+?\d+$/.test(candidate.name.trim());

const historyRequest = <TResult,>(body: Record<string, unknown>) =>
  new RestApiClient().post<TResult>('/s/whatsapp/history', body);

const listChats = async (rangeDays: RangeDays): Promise<HistoryCandidate[]> => {
  const chats: HistoryCandidate[] = [];
  for (let total = Infinity; chats.length < total;) {
    const page = await historyRequest<HistoryList>({ action: 'list', rangeDays, offset: chats.length });
    total = page.total;
    if (page.items.length === 0) break;
    chats.push(...page.items);
  }
  return chats;
};

export const WhatsAppHistoryImport = () => {
  const styles = getPreviewStyles();
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [createPeople, setCreatePeople] = useState(true);
  // From 0 to 100 while an import runs.
  const [progress, setProgress] = useState<number>();
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');

  const runImport = async () => {
    setProgress(0);
    setSummary('');
    setError('');
    let messages = 0;
    let people = 0;
    let failed = 0;

    try {
      const chats = (await listChats(rangeDays)).filter((chat) => chat.messageCount > 0);
      const importable = chats.filter(
        (chat) =>
          chat.match === 'group' ||
          chat.match === 'matched' ||
          (chat.match === 'new' && createPeople && hasContactName(chat)),
      );
      const skipped = chats.length - importable.length;

      for (const [index, chat] of importable.entries()) {
        try {
          for (let offset: number | undefined = 0; offset !== undefined;) {
            const result: ImportResult = await historyRequest<ImportResult>({
              action: 'import',
              rangeDays,
              chatId: chat.chatId,
              offset,
              createPerson: chat.match === 'new',
            });
            messages += result.imported;
            people += Number(result.createdPerson);
            offset = result.nextOffset;
            // Each chat is an equal share of the bar, filled as its pages are imported.
            const chatDone = offset !== undefined && result.total ? offset / result.total : 1;
            setProgress((100 * (index + chatDone)) / importable.length);
          }
        } catch {
          failed += 1;
        }
      }

      setSummary(
        [
          `${t('Imported')} ${messages} ${t('messages from')} ${importable.length - failed} ${t('chats')}`,
          `${people} ${t('new People')}`,
          skipped ? `${skipped} ${t('chats skipped without a matching Person')}` : '',
          failed ? `${failed} ${t('chats failed; import again to retry them')}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
    } catch {
      setError(t('Could not reach the WhatsApp bridge. Check that it is running and retry.'));
    } finally {
      setProgress(undefined);
    }
  };

  const running = progress !== undefined;

  return (
    <section
      style={{
        ...styles.card,
        display: 'grid',
        gap: themeCssVariables.spacing[4],
        padding: themeCssVariables.spacing[4],
      }}
      aria-label={t('Import existing history')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: themeCssVariables.spacing[2] }}>
        <IconHistory size={themeCssVariables.icon.size.md} />
        <strong>{t('Import existing history')}</strong>
      </div>
      <p style={{ ...styles.muted, margin: 0 }}>
        {t(
          'Imports group chats and chats with People in Twenty. Imported messages are visible to workspace members with access to these records. Messages already imported are skipped.',
        )}
      </p>
      <label style={{ display: 'grid', gap: themeCssVariables.spacing[1] }}>
        <span style={styles.label}>{t('Messages from')}</span>
        <select
          value={rangeDays}
          disabled={running}
          onChange={(event) => setRangeDays(Number(event.target.value) as RangeDays)}
          style={{
            background: themeCssVariables.background.primary,
            border: `1px solid ${themeCssVariables.border.color.medium}`,
            borderRadius: themeCssVariables.border.radius.sm,
            color: themeCssVariables.font.color.primary,
            fontFamily: themeCssVariables.font.family,
            fontSize: themeCssVariables.font.size.md,
            maxWidth: 240,
            padding: themeCssVariables.spacing[2],
          }}
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: themeCssVariables.spacing[2] }}>
        <FrontComponentCheckbox
          checked={createPeople}
          disabled={running}
          onChange={(event) => setCreatePeople(event.target.checked)}
        />
        <span>{t('Create People from WhatsApp contact info')}</span>
      </label>
      <div>
        <Button
          type="button"
          variant="solid"
          color="accent"
          size="sm"
          loading={running}
          disabled={running}
          onClick={() => void runImport()}
        >
          {t('Import')}
        </Button>
      </div>
      {running && (
        <div
          role="progressbar"
          aria-label={t('Import progress')}
          aria-valuenow={Math.round(progress)}
          style={{
            background: themeCssVariables.background.tertiary,
            borderRadius: themeCssVariables.border.radius.sm,
            height: 6,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              background: themeCssVariables.color.blue,
              height: '100%',
              transition: 'width 0.3s',
              width: `${progress}%`,
            }}
          />
        </div>
      )}
      {summary && (
        <p role="status" style={{ ...styles.muted, margin: 0 }}>
          {summary}
        </p>
      )}
      {error && <Callout variant="error" title={t('History import unavailable')} description={error} />}
    </section>
  );
};
