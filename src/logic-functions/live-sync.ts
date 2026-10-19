import type { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgePost, getBridgeStatus, isBridgeOutdated, reportRateLimit } from 'src/logic-functions/bridge-request';
import {
  applicationClient,
  ensureAccount,
  findConversations,
  findPeopleByPhones,
  isValidBridgeEvent,
  messageRecord,
  personName,
  planSavedContactPeople,
  summarizeEvents,
  summaryPatch,
  type BridgeMessageEvent,
  type ContactName,
  type Conversation,
  type Person,
  type SavedContact,
} from 'src/logic-functions/message-data';
import { queueMedia } from 'src/logic-functions/media-import';
import { pendingMedia, type MediaItem } from 'src/logic-functions/message-media';
import {
  countingClient,
  deterministicId,
  rateLimitRetryAfterMs,
  upsertConversations,
  upsertMessages,
  upsertPeople,
  type UpsertedMessage,
} from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import {
  chatNumber,
  digits,
  isContactId,
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

// `waitMs` without a lease: the API budget is spent, come back then.
type ClaimedEvents = { leaseId?: string; events: BridgeMessageEvent[]; jobKey?: string; waitMs?: number };

// The account record is looked up once, then remembered by the bridge.
const resolveAccountId = async (client: CoreApiClient, phoneNumber: string, cached?: string): Promise<string> => {
  if (cached) return cached;

  const accountId = await ensureAccount(client, phoneNumber);
  // A bridge from before the account was cached answers 404; the next sync looks it up again.
  await bridgePost('/account', { phoneNumber, accountId }).catch(() => undefined);
  return accountId;
};

// Direct chats need exactly one matching Person; group chats are imported only once an admin has
// imported their history (the conversation exists). A conversation still named after a number takes
// the name the bridge knows.
const planChats = (
  eventsByChat: Map<string, BridgeMessageEvent[]>,
  people: Map<string, Person[]>,
  conversations: Map<string, Conversation>,
  contactByChatId: Map<string, ContactName>,
): { batches: ChatBatch[]; ignored: BridgeMessageEvent[] } => {
  const batches: ChatBatch[] = [];
  const ignored: BridgeMessageEvent[] = [];

  for (const [chatId, events] of eventsByChat) {
    const conversation = conversations.get(chatId);
    const contactName = contactByChatId.get(chatId)?.name;

    if (isGroupChatId(chatId)) {
      if (conversation) batches.push({ chatId, events, conversation, name: contactName ?? conversation.name });
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
        name: personName(matches[0]) || contactName || chatNumber(chatId),
      });
    } else {
      ignored.push(...events);
    }
  }

  return { batches, ignored };
};

// Group senders saved in the phone's address book, by sender ID. Best effort: a group's messages are
// imported even when its senders cannot become People.
const findSavedGroupSenders = async (
  events: BridgeMessageEvent[],
  logger: Logger,
): Promise<(SavedContact & { id: string })[]> => {
  const ids = [
    ...new Set(
      events.flatMap((event) => (isGroupChatId(event.chatId) && isContactId(event.senderId) ? [event.senderId] : [])),
    ),
  ];
  if (ids.length === 0) return [];

  return bridgePost<(SavedContact & { id: string })[]>('/contacts/saved', { ids }).catch((error: unknown) => {
    logger.warn('Could not look up saved group senders', { error: String(error) });
    return [];
  });
};

// Unmatched direct chats need the contact's saved name to become People; conversations still named
// after a number need a better one. Without it, unmatched chats are ignored as before.
const findContactNames = async (
  chatIds: string[],
  people: Map<string, Person[]>,
  conversations: Map<string, Conversation>,
  logger: Logger,
): Promise<Map<string, ContactName>> => {
  const chatsToName = chatIds.filter((chatId) => {
    const conversation = conversations.get(chatId);
    if (conversation) return isPhoneLikeName(conversation.name);
    return isDirectChatId(chatId) && !people.has(chatNumber(chatId));
  });
  if (chatsToName.length === 0) return new Map();

  const names = await bridgePost<ContactName[]>('/history/names', { chatIds: chatsToName }, 30_000).catch(
    (error: unknown) => {
      logger.warn('Could not read contact names', { error: String(error) });
      return [];
    },
  );
  return new Map(names.map((contact) => [contact.chatId, contact]));
};

type SavedContactPlan = {
  eventsByChat: Map<string, BridgeMessageEvent[]>;
  people: Map<string, Person[]>;
  conversations: Map<string, Conversation>;
  contactByChatId: Map<string, ContactName>;
  savedSenders: (SavedContact & { id: string })[];
  logger: Logger;
};

// Creates, in one upsert, a Person for each saved contact of the batch: direct chats from a saved
// contact, and saved senders of imported groups. Unknown numbers are ignored. Returns the direct
// chats that could not get their Person, so their messages are not dropped.
const createSavedContactPeople = async (
  client: CoreApiClient,
  { eventsByChat, people, conversations, contactByChatId, savedSenders, logger }: SavedContactPlan,
): Promise<string[]> => {
  const senderById = new Map(savedSenders.map((sender) => [sender.id, sender]));
  const directContacts: SavedContact[] = [];
  const groupContacts: SavedContact[] = [];

  for (const [chatId, events] of eventsByChat) {
    if (isGroupChatId(chatId)) {
      if (conversations.has(chatId)) {
        groupContacts.push(...events.flatMap((event) => senderById.get(event.senderId ?? '') ?? []));
      }
      continue;
    }
    const contact = contactByChatId.get(chatId);
    if (!people.has(chatNumber(chatId)) && contact?.firstName) {
      directContacts.push({
        phoneNumber: chatNumber(chatId),
        firstName: contact.firstName,
        lastName: contact.lastName ?? '',
      });
    }
  }

  const planned = planSavedContactPeople([...directContacts, ...groupContacts], people);
  if (planned.length === 0) return [];

  try {
    await upsertPeople(
      client,
      planned.map(({ write }) => write),
    );
  } catch (error) {
    if (rateLimitRetryAfterMs(error) !== undefined) throw error;
    logger.error('Could not create People for saved contacts', {
      error: error instanceof Error ? error.message : String(error),
    });
    const waiting = new Set(directContacts.map((contact) => digits(contact.phoneNumber)));
    return [...eventsByChat.keys()].filter((chatId) => isDirectChatId(chatId) && waiting.has(chatNumber(chatId)));
  }

  for (const { number, person } of planned) people.set(number, [person]);
  logger.info('Created People for saved contacts', { count: planned.length });
  return [];
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
    isPhoneLikeName(conversation.name) && name.trim() && !isPhoneLikeName(name)
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

type SyncDependencies = { client?: CoreApiClient; queueFiles?: (items: MediaItem[]) => Promise<unknown> };

// Imports the messages queued by the bridge: a fixed number of requests per batch, whatever the
// number of chats in it. If the batch cannot be written, chats are retried one by one so a single
// bad chat cannot hold the queue.
export const syncMessages = async (
  logger: Logger,
  {
    client: baseClient = applicationClient(),
    queueFiles = (items) => queueMedia(items, 'live'),
  }: SyncDependencies = {},
): Promise<SyncResult> => {
  const counter = { requests: 0 };
  const client = countingClient(baseClient, counter);
  const status = await getBridgeStatus();

  if (status.state !== 'connected' || !status.phoneNumber) {
    // The bridge signals again when it reconnects.
    logger.info('Bridge not connected, nothing to sync', { state: status.state });
    return { imported: 0, ignored: 0, acknowledged: 0, remaining: false };
  }

  // Claimed before any Twenty query, so a sync with nothing to do costs no API request.
  const claimed = await bridgePost<ClaimedEvents>('/events/claim');

  if (!claimed.leaseId && claimed.waitMs !== undefined) {
    return {
      imported: 0,
      ignored: 0,
      acknowledged: 0,
      remaining: true,
      jobKey: claimed.jobKey,
      retryInMs: claimed.waitMs,
    };
  }

  // Nothing queued, or another sync holds the batch (or waits for budget) and queues the next one.
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
    const events = claimed.events;
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
    const chatIds = [...eventsByChat.keys()];
    const savedSenders = await findSavedGroupSenders(valid, logger);
    const [people, conversations] = await Promise.all([
      findPeopleByPhones(client, [
        ...chatIds.filter(isDirectChatId).map(chatNumber),
        ...savedSenders.map((sender) => digits(sender.phoneNumber)),
      ]),
      findConversations(client, accountId, chatIds),
    ]);
    const contactByChatId = await findContactNames(chatIds, people, conversations, logger);
    const unwrittenChatIds = await createSavedContactPeople(client, {
      eventsByChat,
      people,
      conversations,
      contactByChatId,
      savedSenders,
      logger,
    });
    // Chats waiting for their Person stay queued for the next sync.
    for (const chatId of unwrittenChatIds) eventsByChat.delete(chatId);

    const { batches, ignored } = planChats(eventsByChat, people, conversations, contactByChatId);
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

    const media: MediaItem[] = [];
    const writtenEventIds: string[] = [];
    for (const { batches: written, written: messages } of writtenBatches) {
      const writtenEvents = written.flatMap((batch) => batch.events);
      media.push(...pendingMedia(messages, writtenEvents));
      imported += messages.filter((message) => message.created).length;
      writtenEventIds.push(...writtenEvents.map((event) => event.eventId));
    }

    // Files wait in the bridge's media queue, so text never waits behind them. Events are
    // acknowledged only once their files are queued: otherwise the replay finds the files missing.
    // A bridge without the queue still gets its messages imported, without their files.
    if (isBridgeOutdated(status)) {
      if (media.length > 0)
        logger.warn('Skipping files: the WhatsApp bridge is older than the app', { count: media.length });
    } else {
      await queueFiles(media);
    }
    acknowledge.push(...writtenEventIds);
    completed = true;
  } catch (error) {
    retryInMs = rateLimitRetryAfterMs(error);
    if (retryInMs === undefined) throw error;
    logger.warn('Twenty rate limited the sync', { retryInMs });
    await reportRateLimit(retryInMs);
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
      requests: counter.requests,
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
