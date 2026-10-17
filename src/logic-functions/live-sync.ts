import type { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import {
  applicationClient,
  ensureAccount,
  findConversations,
  findPeopleByPhones,
  isValidBridgeEvent,
  messageRecord,
  personName,
  summarizeEvents,
  summaryPatch,
  type BridgeMessageEvent,
  type Conversation,
  type Person,
} from 'src/logic-functions/message-data';
import { attachMedia, type MediaItem } from 'src/logic-functions/message-media';
import {
  deterministicId,
  rateLimitRetryAfterMs,
  upsertConversations,
  upsertMessages,
  type UpsertedMessage,
} from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import {
  chatNumber,
  digits,
  isDirectChatId,
  isGroupChatId,
  isPhoneLikeName,
} from 'src/logic-functions/utils/validators';

export type SyncResult = {
  imported: number;
  ignored: number;
  acknowledged: number;
  remaining: boolean;
  // Names the next sync job, so signals and the job's own follow-up fold into one job.
  jobKey?: string;
  // Set when Twenty rate limited the batch: the next sync waits this long.
  retryInMs?: number;
};

type ChatBatch = {
  chatId: string;
  events: BridgeMessageEvent[];
  conversation?: Conversation;
  // For a direct chat: its Person, and the name a new or phone-named conversation takes.
  person?: Person;
  name: string;
};

type ClaimedEvents = { leaseId?: string; events: BridgeMessageEvent[]; jobKey?: string };

// The account record is looked up once, then remembered by the bridge.
const resolveAccountId = async (client: CoreApiClient, phoneNumber: string, cached?: string): Promise<string> => {
  if (cached) return cached;

  const accountId = await ensureAccount(client, phoneNumber);
  // A bridge from before the account was cached answers 404; the next sync looks it up again.
  await bridgePost('/account', { phoneNumber, accountId }).catch(() => undefined);
  return accountId;
};

// Direct chats need exactly one matching Person; group chats are imported only once an admin has
// imported their history (the conversation exists).
const planChats = (
  eventsByChat: Map<string, BridgeMessageEvent[]>,
  people: Map<string, Person[]>,
  conversations: Map<string, Conversation>,
): { batches: ChatBatch[]; ignored: BridgeMessageEvent[] } => {
  const batches: ChatBatch[] = [];
  const ignored: BridgeMessageEvent[] = [];

  for (const [chatId, events] of eventsByChat) {
    const conversation = conversations.get(chatId);

    if (isGroupChatId(chatId)) {
      if (conversation) batches.push({ chatId, events, conversation, name: conversation.name });
      else ignored.push(...events);
      continue;
    }

    const matches = people.get(chatNumber(chatId)) ?? [];
    if (matches.length === 1) {
      batches.push({
        chatId,
        events,
        conversation,
        person: matches[0],
        name: personName(matches[0]) || chatNumber(chatId),
      });
    } else {
      ignored.push(...events);
    }
  }

  return { batches, ignored };
};

const conversationWrite = (accountId: string, batch: ChatBatch): Record<string, unknown> | undefined => {
  const { conversation, chatId, name, person } = batch;
  const patch = summaryPatch(conversation, summarizeEvents(batch.events)) ?? {};

  if (!conversation) {
    return {
      id: deterministicId('conversation', `${accountId}:${chatId}`),
      name: name.trim().slice(0, 120),
      chatId,
      accountId,
      ...(person ? { personId: person.id } : {}),
      ...patch,
    };
  }

  const rename =
    person && isPhoneLikeName(conversation.name) && name.trim() && !isPhoneLikeName(name)
      ? { name: name.trim().slice(0, 120) }
      : {};
  const data = { ...patch, ...rename };

  return Object.keys(data).length > 0 ? { id: conversation.id, ...data } : undefined;
};

// Writes the chats of a batch together: one conversations upsert, then one messages upsert.
const writeChats = async (
  client: CoreApiClient,
  accountId: string,
  batches: ChatBatch[],
): Promise<UpsertedMessage[]> => {
  const conversationWrites = batches.flatMap((batch) => {
    const write = conversationWrite(accountId, batch);
    return write ? [write] : [];
  });
  const written = conversationWrites.length > 0 ? await upsertConversations(client, conversationWrites) : [];
  const writtenIdByChatId = new Map(written.map(({ id, chatId }) => [chatId, id]));
  const records = batches.flatMap((batch) => {
    const conversationId = batch.conversation?.id ?? writtenIdByChatId.get(batch.chatId);
    if (!conversationId) throw new Error('Could not create WhatsApp conversation');
    return batch.events.map((event) => messageRecord(event, conversationId));
  });

  return upsertMessages(client, records);
};

// Files of the written messages that do not have one yet.
export const pendingMedia = (written: UpsertedMessage[], events: BridgeMessageEvent[]): MediaItem[] => {
  const eventById = new Map(events.map((event) => [event.eventId, event]));

  return written.flatMap((message) => {
    const fileName = eventById.get(message.externalId)?.media?.fileName;
    return message.mediaKind && !message.media?.length && fileName
      ? [{ messageId: message.id, eventId: message.externalId, fileName }]
      : [];
  });
};

type SyncDependencies = { client?: CoreApiClient };

// Imports the messages queued by the bridge: a fixed number of requests per batch, whatever the
// number of chats in it. If the batch cannot be written, chats are retried one by one so a single
// bad chat cannot hold the queue.
export const syncMessages = async (
  logger: Logger,
  { client = applicationClient() }: SyncDependencies = {},
): Promise<SyncResult> => {
  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    // The bridge signals again when it reconnects.
    logger.info('Bridge not connected, nothing to sync', { state: status.state });
    return { imported: 0, ignored: 0, acknowledged: 0, remaining: false };
  }

  // Claimed before any Twenty query, so a sync with nothing to do costs no API request.
  const claimed = await bridgePost<ClaimedEvents>('/events/claim');

  // Nothing queued, or another sync holds the batch and will queue the next one itself.
  if (!claimed.leaseId) {
    return { imported: 0, ignored: 0, acknowledged: 0, remaining: false, jobKey: claimed.jobKey };
  }

  const { leaseId } = claimed;
  const acknowledge: string[] = [];
  let imported = 0;
  let ignoredCount = 0;
  let retryInMs: number | undefined;
  let completed = false;
  let released: { remaining?: boolean; jobKey?: string } | undefined;

  try {
    // Media uploads are slow: stop the batch after the first one, the bridge asks again for the rest.
    const firstMediaIndex = claimed.events.findIndex((event) => event.media);
    const events = firstMediaIndex < 0 ? claimed.events : claimed.events.slice(0, firstMediaIndex + 1);
    const valid = events.filter(isValidBridgeEvent);
    const invalid = events.filter((event) => !isValidBridgeEvent(event));

    if (invalid.length > 0) {
      logger.warn('Dropping invalid bridge events', { count: invalid.length });
      acknowledge.push(...invalid.map((event) => event.eventId));
    }

    const eventsByChat = new Map<string, BridgeMessageEvent[]>();
    for (const event of valid) {
      eventsByChat.set(event.chatId, [...(eventsByChat.get(event.chatId) ?? []), event]);
    }

    const accountId = await resolveAccountId(client, `+${digits(status.phoneNumber)}`, status.twentyAccountId);
    const directNumbers = [...eventsByChat.keys()].filter(isDirectChatId).map(chatNumber);
    const [people, conversations] = await Promise.all([
      findPeopleByPhones(client, directNumbers),
      findConversations(client, accountId, [...eventsByChat.keys()]),
    ]);
    const { batches, ignored } = planChats(eventsByChat, people, conversations);
    ignoredCount = ignored.length;
    acknowledge.push(...ignored.map((event) => event.eventId));

    const writtenBatches: { batches: ChatBatch[]; written: UpsertedMessage[] }[] = [];

    if (batches.length > 0) {
      try {
        writtenBatches.push({ batches, written: await writeChats(client, accountId, batches) });
      } catch (error) {
        if (rateLimitRetryAfterMs(error) !== undefined || batches.length === 1) throw error;
        logger.warn('Could not write the batch, retrying chat by chat', {
          error: error instanceof Error ? error.message : String(error),
        });
        for (const batch of batches) {
          try {
            writtenBatches.push({ batches: [batch], written: await writeChats(client, accountId, [batch]) });
          } catch (chatError) {
            if (rateLimitRetryAfterMs(chatError) !== undefined) throw chatError;
            // Keep the chat's events queued for the next sync and carry on with the other chats.
            logger.error('Could not import chat', {
              chatId: batch.chatId,
              error: chatError instanceof Error ? chatError.message : String(chatError),
            });
          }
        }
      }
    }

    for (const { batches: written, written: messages } of writtenBatches) {
      const writtenEvents = written.flatMap((batch) => batch.events);
      await attachMedia(client, pendingMedia(messages, writtenEvents));
      imported += messages.filter((message) => message.created).length;
      acknowledge.push(...writtenEvents.map((event) => event.eventId));
    }
    completed = true;
  } catch (error) {
    retryInMs = rateLimitRetryAfterMs(error);
    if (retryInMs === undefined) throw error;
    logger.warn('Twenty rate limited the sync', { retryInMs });
  } finally {
    // Acknowledged before release, so the remaining count leaves out what this batch handled.
    if (acknowledge.length > 0) {
      await bridgePost('/events/ack', { eventIds: acknowledge }).catch((error: unknown) =>
        logger.error('Could not acknowledge events', { error: String(error) }),
      );
    }
    // `completed` is read by bridges from before `remaining` was returned.
    released = await bridgePost<{ remaining?: boolean; jobKey?: string }>('/events/release', {
      leaseId,
      completed,
    }).catch(() => undefined);
  }

  const result: SyncResult = {
    imported,
    ignored: ignoredCount,
    acknowledged: acknowledge.length,
    remaining: released?.remaining ?? true,
    jobKey: released?.jobKey ?? claimed.jobKey,
    ...(retryInMs !== undefined ? { retryInMs } : {}),
  };

  logger.info('Synced messages', { imported, ignored: ignoredCount, remaining: result.remaining });
  return result;
};
