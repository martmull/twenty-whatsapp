import { useEffect, useState } from 'react';
import { enqueueSnackbar, t } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components';
import { Tag } from 'twenty-ui/primitives/data-display';
import { ProgressBar } from 'twenty-ui/primitives/feedback';
import { Button, Input } from 'twenty-ui/primitives/input';
import { Card } from 'twenty-ui/primitives/surfaces';
import { Heading, Text } from 'twenty-ui/primitives/typography';
import { themeCssVariables } from 'twenty-ui/theme';

import { callApp, showError } from 'src/front-components/components/app-api';
import { FrontComponentCheckbox } from 'src/front-components/components/FrontComponentCheckbox';
import { formatTime, type GroupMember } from 'src/front-components/components/inbox-types';

type RangeDays = 0 | 30 | 90;
type ChatFilter = 'all' | 'direct' | 'group';
type Name = { firstName: string; lastName: string };

type HistoryCandidate = {
  chatId: string;
  kind: 'direct' | 'group';
  name: string;
  messageCount: number;
  lastMessageAt?: string;
  match: 'matched' | 'new' | 'ambiguous' | 'group';
  renameable?: boolean;
};

type JobStatus = { jobId: string; state: string; failedReason?: string | null };

// The running import's job IDs, kept so the progress shows again after a reload.
const JOB_IDS_KEY = 'whatsapp-history-import-jobs';

const storedJobIds = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(JOB_IDS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const storeJobIds = (jobIds: string[]) => {
  try {
    if (jobIds.length) localStorage.setItem(JOB_IDS_KEY, JSON.stringify(jobIds));
    else localStorage.removeItem(JOB_IDS_KEY);
  } catch {
    // Without storage the progress just doesn't survive a reload.
  }
};

const isPhoneLikeName = (name: string) => /^\+?\d+$/.test(name.trim());

// First/last name suggested from the WhatsApp display name.
const suggestedName = (item: HistoryCandidate): Name => {
  const [firstName = '', ...lastName] = isPhoneLikeName(item.name) ? [] : item.name.trim().split(/\s+/);
  return { firstName, lastName: lastName.join(' ') };
};

const matchTag = (match: HistoryCandidate['match']) =>
  ({
    matched: { label: t('Matched'), color: 'green' as const },
    new: { label: t('New Person'), color: 'blue' as const },
    ambiguous: { label: t('Several matches'), color: 'orange' as const },
    group: { label: t('Group'), color: 'gray' as const },
  })[match];

export const WhatsAppHistoryImport = () => {
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all');
  const [items, setItems] = useState<HistoryCandidate[]>();
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, Name>>({});
  const [members, setMembers] = useState<Record<string, GroupMember[]>>({});
  const [working, setWorking] = useState(false);
  // One background job per imported chat; empty when no import is running.
  const [jobIds, setJobIds] = useState<string[]>(storedJobIds);
  const [finishedJobs, setFinishedJobs] = useState(0);
  const importing = jobIds.length > 0;

  const load = async (range: RangeDays, kind: ChatFilter, offset = 0) => {
    setWorking(true);
    try {
      const page = await callApp<{ items: HistoryCandidate[]; total: number }>('history', {
        action: 'list',
        rangeDays: range,
        kind,
        offset,
      });
      setItems((previous) => (offset === 0 ? page.items : [...(previous ?? []), ...page.items]));
      setTotal(page.total);
    } catch (error) {
      showError(error, t('Could not load WhatsApp history'));
    } finally {
      setWorking(false);
    }
  };

  const changeFilters = (range: RangeDays, kind: ChatFilter) => {
    setRangeDays(range);
    setChatFilter(kind);
    setSelected([]);
    void load(range, kind);
  };

  const toggleMembers = async (chatId: string) => {
    if (members[chatId]) {
      setMembers(({ [chatId]: _, ...rest }) => rest);
      return;
    }
    try {
      const list = await callApp<GroupMember[]>('history', { action: 'members', rangeDays, chatId });
      setMembers((previous) => ({ ...previous, [chatId]: list }));
    } catch (error) {
      showError(error, t('Could not load group members'));
    }
  };

  const needsName = (item: HistoryCandidate) => item.match === 'new' || Boolean(item.renameable);
  const nameFor = (item: HistoryCandidate) => names[item.chatId] ?? suggestedName(item);

  const importSelected = async () => {
    const chosen = (items ?? []).filter((item) => selected.includes(item.chatId));

    if (chosen.some((item) => needsName(item) && !nameFor(item).firstName.trim())) {
      void enqueueSnackbar({ message: t('Enter a first name for each new contact'), variant: 'error' });
      return;
    }

    setWorking(true);
    try {
      const result = await callApp<{ jobIds: string[] }>('history', {
        action: 'import',
        rangeDays,
        chats: chosen.map((item) => {
          const name = nameFor(item);
          return {
            chatId: item.chatId,
            createPerson: item.match === 'new',
            ...(needsName(item)
              ? { firstName: name.firstName.trim() || undefined, lastName: name.lastName.trim() || undefined }
              : {}),
          };
        }),
      });
      storeJobIds(result.jobIds);
      setFinishedJobs(0);
      setJobIds(result.jobIds);
      setSelected([]);
    } catch (error) {
      showError(error, t('Could not start the import'));
    } finally {
      setWorking(false);
    }
  };

  // Follow the import jobs until they have all finished.
  useEffect(() => {
    if (jobIds.length === 0) return;
    let active = true;

    const poll = async () => {
      const result = await callApp<{ jobs: JobStatus[] }>('history', { action: 'progress', jobIds }).catch(
        () => undefined,
      );
      if (!active || !result) return;

      // A job the queue no longer returns finished long ago.
      const running = result.jobs.filter((job) => job.state !== 'COMPLETED' && job.state !== 'FAILED');
      const failed = result.jobs.filter((job) => job.state === 'FAILED');
      setFinishedJobs(jobIds.length - running.length);

      if (running.length === 0) {
        void enqueueSnackbar(
          failed.length
            ? {
                message: `${t('Chats not imported')}: ${failed.length}. ${t('Retry them, duplicates are skipped.')}`,
                variant: 'warning',
              }
            : { message: t('History import complete'), variant: 'success' },
        );
        storeJobIds([]);
        setJobIds([]);
      }
    };

    void poll();
    const timer = setInterval(poll, 2_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [jobIds]);

  const filterButton = (label: string, active: boolean, onClick: () => void) => (
    <Button
      key={label}
      variant={active ? 'solid' : 'outline'}
      color={active ? 'accent' : 'neutral'}
      size="sm"
      disabled={working}
      onClick={onClick}
    >
      {label}
    </Button>
  );

  return (
    <Card.Root>
      <Card.Content>
        <div style={{ display: 'grid', gap: themeCssVariables.spacing[3], padding: themeCssVariables.spacing[4] }}>
          <Heading level={2} size="sm">
            {t('Import history')}
          </Heading>

          {importing && <ProgressBar value={(100 * finishedJobs) / jobIds.length} ariaLabel={t('Import progress')} />}

          {!items && (
            <div>
              <Button variant="outline" size="sm" loading={working} onClick={() => void load(rangeDays, chatFilter)}>
                {t('Review available history')}
              </Button>
            </div>
          )}

          {items && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: themeCssVariables.spacing[2] }}>
                {filterButton(t('30 days'), rangeDays === 30, () => changeFilters(30, chatFilter))}
                {filterButton(t('90 days'), rangeDays === 90, () => changeFilters(90, chatFilter))}
                {filterButton(t('All'), rangeDays === 0, () => changeFilters(0, chatFilter))}
                <span style={{ width: themeCssVariables.spacing[4] }} />
                {filterButton(t('All chats'), chatFilter === 'all', () => changeFilters(rangeDays, 'all'))}
                {filterButton(t('Direct'), chatFilter === 'direct', () => changeFilters(rangeDays, 'direct'))}
                {filterButton(t('Groups'), chatFilter === 'group', () => changeFilters(rangeDays, 'group'))}
              </div>

              {items.length === 0 && !working && <Callout variant="info" title={t('No history in this range')} />}

              {items.map((item) => (
                <div
                  key={item.chatId}
                  style={{
                    borderTop: `1px solid ${themeCssVariables.border.color.light}`,
                    display: 'grid',
                    gap: themeCssVariables.spacing[2],
                    paddingTop: themeCssVariables.spacing[2],
                  }}
                >
                  <label style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[3] }}>
                    <FrontComponentCheckbox
                      checked={selected.includes(item.chatId)}
                      disabled={working || item.match === 'ambiguous'}
                      onChange={(event) =>
                        setSelected((previous) =>
                          event.target.checked
                            ? [...previous, item.chatId]
                            : previous.filter((id) => id !== item.chatId),
                        )
                      }
                    />
                    <span style={{ display: 'grid', flex: 1, minWidth: 0 }}>
                      <strong>{item.name}</strong>
                      <Text
                        style={{
                          color: themeCssVariables.font.color.tertiary,
                          fontSize: themeCssVariables.font.size.sm,
                        }}
                      >
                        {item.messageCount} {t('messages')}
                        {item.lastMessageAt ? ` · ${formatTime(item.lastMessageAt)}` : ''}
                      </Text>
                    </span>
                    {item.kind === 'group' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={working}
                        onClick={() => void toggleMembers(item.chatId)}
                      >
                        {t('Members')}
                      </Button>
                    )}
                    <Tag color={matchTag(item.match).color} variant="soft" preventShrink>
                      {matchTag(item.match).label}
                    </Tag>
                  </label>

                  {members[item.chatId] && (
                    <Text
                      style={{
                        color: themeCssVariables.font.color.secondary,
                        fontSize: themeCssVariables.font.size.sm,
                        paddingLeft: themeCssVariables.spacing[6],
                      }}
                    >
                      {members[item.chatId]
                        .map((member) =>
                          member.isMe ? t('You') : member.displayName || member.phoneNumber || member.id,
                        )
                        .join(', ')}
                    </Text>
                  )}

                  {needsName(item) && selected.includes(item.chatId) && (
                    <div
                      style={{
                        display: 'flex',
                        gap: themeCssVariables.spacing[2],
                        paddingLeft: themeCssVariables.spacing[6],
                      }}
                    >
                      <Input
                        placeholder={t('First name')}
                        value={nameFor(item).firstName}
                        maxLength={80}
                        disabled={working}
                        onChange={(event) =>
                          setNames((previous) => ({
                            ...previous,
                            [item.chatId]: { ...nameFor(item), firstName: event.target.value },
                          }))
                        }
                      />
                      <Input
                        placeholder={t('Last name')}
                        value={nameFor(item).lastName}
                        maxLength={80}
                        disabled={working}
                        onChange={(event) =>
                          setNames((previous) => ({
                            ...previous,
                            [item.chatId]: { ...nameFor(item), lastName: event.target.value },
                          }))
                        }
                      />
                    </div>
                  )}
                </div>
              ))}

              <div style={{ alignItems: 'center', display: 'flex', gap: themeCssVariables.spacing[2] }}>
                {items.length < total && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={working}
                    onClick={() => void load(rangeDays, chatFilter, items.length)}
                  >
                    {t('Load more')}
                  </Button>
                )}
                <Button
                  variant="solid"
                  color="accent"
                  size="sm"
                  disabled={working || importing || selected.length === 0}
                  loading={importing}
                  onClick={() => void importSelected()}
                >
                  {t('Import selected')} ({selected.length})
                </Button>
              </div>
            </>
          )}
        </div>
      </Card.Content>
    </Card.Root>
  );
};
