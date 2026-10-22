import { useEffect, useState } from 'react';
import { RestApiClient, RestApiClientError } from 'twenty-client-sdk/rest';
import { t } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components';
import { IconHistory } from 'twenty-ui/icon';
import { Tag } from 'twenty-ui/primitives/data-display';
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
  messageCount: number;
  lastMessageAt?: string;
  // New messages of this chat are synced.
  synced?: boolean;
};

type HistoryList = { items: HistoryCandidate[]; total: number };

type ChatFailure = { chatId: string; error: string };

type QueueResult = { queued: number; createdPeople: number; failures: ChatFailure[] };

type SyncResult = { updated: number; createdPeople: number; failures: ChatFailure[] };

type ImportProgress = { chatId: string; processed: number; total: number; state: 'queued' | 'done' | 'failed' };

// The history route queues at most this many chats per request.
const CHATS_PER_REQUEST = 50;

const RANGE_OPTIONS: { value: RangeDays; label: string }[] = [
  { value: 7, label: t('Last week') },
  { value: 30, label: t('Last month') },
  { value: 90, label: t('Last 3 months') },
  { value: 365, label: t('Last year') },
];

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

type WhatsAppHistoryImportProps = { createPeople: boolean };

export const WhatsAppHistoryImport = ({ createPeople }: WhatsAppHistoryImportProps) => {
  const styles = getPreviewStyles();
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [chats, setChats] = useState<HistoryCandidate[]>();
  const [loadingChats, setLoadingChats] = useState(false);
  const [updatingSync, setUpdatingSync] = useState<boolean>();
  const [selected, setSelected] = useState<string[]>([]);
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

  const bridgeError = (requestError: unknown) =>
    // 426: the bridge runs an older version than the app.
    requestError instanceof RestApiClientError && requestError.status === 426
      ? t(
          'The WhatsApp bridge that is running is older than this app. Restart it with npm run restart in the bridge folder, then import again.',
        )
      : t('Could not reach the WhatsApp bridge. Check that it is running and retry.');

  const loadChats = async (range: RangeDays) => {
    setLoadingChats(true);
    setError('');
    setSelected([]);

    try {
      setChats(await listChats(range));
    } catch (requestError) {
      setChats(undefined);
      setError(bridgeError(requestError));
    } finally {
      setLoadingChats(false);
    }
  };

  const changeRange = (range: RangeDays) => {
    setRangeDays(range);
    if (chats) void loadChats(range);
  };

  const allChats = chats ?? [];
  const selectedChats = allChats.filter((chat) => selected.includes(chat.chatId));
  const allSelected = allChats.length > 0 && selectedChats.length === allChats.length;

  const toggle = (chatId: string, checked: boolean) =>
    setSelected((previous) => (checked ? [...previous, chatId] : previous.filter((id) => id !== chatId)));

  const toggleAll = (checked: boolean) => setSelected(checked ? allChats.map((chat) => chat.chatId) : []);

  const runImport = async () => {
    setStarting(true);
    setError('');

    try {
      let queued = 0;
      let failed = 0;

      for (let start = 0; start < selectedChats.length; start += CHATS_PER_REQUEST) {
        const result = await historyRequest<QueueResult>({
          action: 'import',
          rangeDays,
          chats: selectedChats.slice(start, start + CHATS_PER_REQUEST).map((chat) => ({
            chatId: chat.chatId,
            createPerson: createPeople,
          })),
        });
        queued += result.queued;
        failed += result.failures.length;
      }

      if (failed > 0) setError(`${failed} ${t('chats failed; import again to retry them')}`);
      if (queued > 0) {
        setSelected([]);
        setProgress((previous) => previous ?? 0);
        setImportRunning(true);
      }
    } catch (requestError) {
      setError(bridgeError(requestError));
    } finally {
      setStarting(false);
    }
  };

  const changeSync = async (enabled: boolean) => {
    setUpdatingSync(enabled);
    setError('');
    const failed = new Set<string>();
    const done = new Set<string>();

    try {
      for (let start = 0; start < selectedChats.length; start += CHATS_PER_REQUEST) {
        const batch = selectedChats.slice(start, start + CHATS_PER_REQUEST);
        const result = await historyRequest<SyncResult>({
          action: 'sync',
          enabled,
          chats: batch.map((chat) => ({ chatId: chat.chatId, createPerson: createPeople })),
        });
        result.failures.forEach((failure) => failed.add(failure.chatId));
        batch.forEach((chat) => done.add(chat.chatId));
      }

      if (failed.size > 0) setError(`${failed.size} ${t('chats could not be updated; retry them')}`);
      setSelected([]);
    } catch (requestError) {
      setError(bridgeError(requestError));
    } finally {
      setChats((previous) =>
        previous?.map((chat) =>
          done.has(chat.chatId) && !failed.has(chat.chatId) ? { ...chat, synced: enabled } : chat,
        ),
      );
      setUpdatingSync(undefined);
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
  const busy = starting || loadingChats || updatingSync !== undefined;

  return (
    <section
      style={{
        ...styles.card,
        display: 'grid',
        gap: themeCssVariables.spacing[4],
        padding: themeCssVariables.spacing[4],
      }}
      aria-label={t('Chats')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: themeCssVariables.spacing[2] }}>
        <IconHistory size={themeCssVariables.icon.size.md} />
        <strong>{t('Chats')}</strong>
      </div>
      <p style={{ ...styles.muted, margin: 0 }}>
        {t(
          'Select chats, then import their messages from the chosen period, or turn syncing of their new messages on or off. Imported and synced messages are visible to workspace members with access to these records. Messages already imported are skipped.',
        )}
      </p>
      <label style={{ display: 'grid', gap: themeCssVariables.spacing[1] }}>
        <span style={styles.label}>{t('Messages from')}</span>
        <select
          value={rangeDays}
          disabled={running}
          onChange={(event) => changeRange(Number(event.target.value) as RangeDays)}
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
      {!chats && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={loadingChats}
            disabled={loadingChats}
            onClick={() => void loadChats(rangeDays)}
          >
            {t('Show chats')}
          </Button>
        </div>
      )}
      {chats && (
        <div style={{ display: 'grid', gap: themeCssVariables.spacing[2] }}>
          {allChats.length === 0 ? (
            <p style={{ ...styles.muted, margin: 0 }}>
              {loadingChats ? t('Loading chats…') : t('No chats to import in this period.')}
            </p>
          ) : (
            <div style={{ ...styles.card, maxHeight: 360, overflowY: 'auto' }}>
              <label
                style={{
                  alignItems: 'center',
                  display: 'flex',
                  gap: themeCssVariables.spacing[3],
                  padding: themeCssVariables.spacing[2],
                }}
              >
                <FrontComponentCheckbox
                  checked={allSelected}
                  disabled={busy}
                  onChange={(event) => toggleAll(event.target.checked)}
                />
                <span style={styles.label}>
                  {t('Select all')} ({allChats.length})
                </span>
              </label>
              {allChats.map((chat) => (
                <label
                  key={chat.chatId}
                  style={{
                    alignItems: 'center',
                    borderTop: `1px solid ${themeCssVariables.border.color.light}`,
                    display: 'flex',
                    gap: themeCssVariables.spacing[3],
                    padding: themeCssVariables.spacing[2],
                  }}
                >
                  <FrontComponentCheckbox
                    checked={selected.includes(chat.chatId)}
                    disabled={busy}
                    onChange={(event) => toggle(chat.chatId, event.target.checked)}
                  />
                  <span style={{ display: 'grid', flex: 1, minWidth: 0 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chat.name}
                    </span>
                    <span style={styles.label}>
                      {chat.messageCount} {t('messages')}
                      {chat.lastMessageAt
                        ? ` · ${new Date(chat.lastMessageAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
                        : ''}
                    </span>
                  </span>
                  {chat.synced && (
                    <Tag color="green" variant="soft" preventShrink>
                      {t('Synced')}
                    </Tag>
                  )}
                  {chat.kind === 'group' && (
                    <Tag color="gray" variant="soft" preventShrink>
                      {t('Group')}
                    </Tag>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: themeCssVariables.spacing[2] }}>
        {chats && (
          <span style={styles.label}>
            {selectedChats.length} {t('selected')}
          </span>
        )}
        <Button
          type="button"
          variant="solid"
          color="accent"
          size="sm"
          loading={starting}
          disabled={running || busy || selectedChats.length === 0}
          onClick={() => void runImport()}
        >
          {t('Import history')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={updatingSync === true}
          disabled={busy || selectedChats.length === 0}
          onClick={() => void changeSync(true)}
        >
          {t('Sync new messages')}
        </Button>
        <Button
          type="button"
          variant="outline"
          color="neutral"
          size="sm"
          loading={updatingSync === false}
          disabled={busy || selectedChats.every((chat) => !chat.synced)}
          onClick={() => void changeSync(false)}
        >
          {t('Stop syncing')}
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
