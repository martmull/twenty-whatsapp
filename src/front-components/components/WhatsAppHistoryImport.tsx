import { useEffect, useState } from 'react';
import { RestApiClient, RestApiClientError } from 'twenty-client-sdk/rest';
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

type QueueResult = { queued: number; createdPeople: number; failures: { chatId: string; error: string }[] };

type ImportProgress = { chatId: string; processed: number; total: number; state: 'queued' | 'done' | 'failed' };

// The history route queues at most this many chats per request.
const CHATS_PER_REQUEST = 50;

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
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // From 0 to 100 while an import runs.
  const [progress, setProgress] = useState<number>();
  const [importRunning, setImportRunning] = useState(false);
  const [error, setError] = useState('');

  // The import runs in background jobs: check once on open, then poll the bridge while it runs.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      try {
        const tasks = await historyRequest<ImportProgress[]>({ action: 'progress' });
        if (cancelled) return;
        const failed = tasks.filter((task) => task.state === 'failed').length;

        if (!tasks.some((task) => task.state === 'queued')) {
          setProgress(undefined);
          if (importRunning) {
            setImportRunning(false);
            if (failed > 0) setError(`${failed} ${t('chats failed; import again to retry them')}`);
          }
          return;
        }

        // Covers the whole run: finished chats count as complete, failed ones as settled.
        const total = tasks.reduce((sum, task) => sum + task.total, 0);
        const settled = tasks.reduce((sum, task) => sum + (task.state === 'queued' ? task.processed : task.total), 0);
        setProgress(total > 0 ? (100 * settled) / total : 0);
        setImportRunning(true);
      } catch {
        // The bridge may be restarting; keep checking while an import runs.
      }
      if (!cancelled && importRunning) timer = setTimeout(check, 4_000);
    };

    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [importRunning]);

  const runImport = async () => {
    setStarting(true);
    setError('');

    try {
      const chats = (await listChats(rangeDays)).filter((chat) => chat.messageCount > 0);
      const importable = chats.filter(
        (chat) =>
          chat.match === 'group' ||
          chat.match === 'matched' ||
          (chat.match === 'new' && createPeople && hasContactName(chat)),
      );
      let queued = 0;
      let failed = 0;

      for (let start = 0; start < importable.length; start += CHATS_PER_REQUEST) {
        const result = await historyRequest<QueueResult>({
          action: 'import',
          rangeDays,
          chats: importable.slice(start, start + CHATS_PER_REQUEST).map((chat) => ({
            chatId: chat.chatId,
            createPerson: chat.match === 'new' || (chat.match === 'group' && createPeople),
          })),
        });
        queued += result.queued;
        failed += result.failures.length;
      }

      if (failed > 0) setError(`${failed} ${t('chats failed; import again to retry them')}`);
      if (queued > 0) {
        setProgress((previous) => previous ?? 0);
        setImportRunning(true);
      }
    } catch (requestError) {
      // 426: the bridge runs an older version than the app.
      setError(
        requestError instanceof RestApiClientError && requestError.status === 426
          ? t(
              'The WhatsApp bridge that is running is older than this app. Restart it with npm run restart in the bridge folder, then import again.',
            )
          : t('Could not reach the WhatsApp bridge. Check that it is running and retry.'),
      );
    } finally {
      setStarting(false);
    }
  };

  const cancelImport = async () => {
    setCancelling(true);
    setError('');

    try {
      await historyRequest({ action: 'cancel' });
      setImportRunning(false);
      setProgress(undefined);
    } catch {
      setError(t('Could not cancel the import. Check that the WhatsApp bridge is running and retry.'));
    } finally {
      setCancelling(false);
    }
  };

  const running = starting || importRunning;

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
      <div style={{ display: 'flex', gap: themeCssVariables.spacing[2] }}>
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
        {importRunning && !starting && (
          <Button
            type="button"
            variant="outline"
            color="neutral"
            size="sm"
            loading={cancelling}
            disabled={cancelling}
            onClick={() => void cancelImport()}
          >
            {t('Cancel import')}
          </Button>
        )}
      </div>
      {progress !== undefined && (
        <div
          role="progressbar"
          aria-label={t('Import progress')}
          aria-valuenow={Math.round(progress)}
          style={{
            background: themeCssVariables.background.tertiary,
            borderRadius: themeCssVariables.border.radius.sm,
            height: 4,
            maxWidth: 240,
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
      {error && <Callout variant="error" title={t('History import unavailable')} description={error} />}
    </section>
  );
};
