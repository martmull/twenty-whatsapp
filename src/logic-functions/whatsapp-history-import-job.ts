import { defineLogicFunction } from 'twenty-sdk/define';
import { RetryableLogicFunctionError } from 'twenty-sdk/logic-function';

import { HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { bridgePost, getBridgeStatus } from 'src/logic-functions/bridge-request';
import {
  applicationClient,
  ensureAccount,
  findPeopleByPhones,
  importChatMessages,
  personName,
  userClient,
  type BridgeMessageEvent,
  type Person,
} from 'src/logic-functions/message-data';
import { createLogger } from 'src/logic-functions/utils/logger';
import { HttpError } from 'src/logic-functions/utils/route';
import { chatNumber, digits, isChatId, isGroupChatId, isPhoneLikeName } from 'src/logic-functions/utils/validators';

// One job per chat, enqueued by the whatsapp-history route.
export type HistoryImportJob = {
  chatId: string;
  rangeDays: 0 | 30 | 90;
  createPerson?: boolean;
  firstName?: string;
  lastName?: string;
};

type HistoryMessages = { name: string; messages: BridgeMessageEvent[]; total: number; nextOffset?: number };

// Finds the Person for a direct chat, creating or renaming them as the admin asked.
const resolvePerson = async (job: HistoryImportJob, historyName: string): Promise<Person> => {
  const number = chatNumber(job.chatId);
  const matches = (await findPeopleByPhones(applicationClient(), [number])).get(number) ?? [];

  if (matches.length > 1) {
    throw new Error('More than one Person has this phone number');
  }

  const [suggestedFirstName = '', ...suggestedLastName] = isPhoneLikeName(historyName)
    ? []
    : historyName.trim().split(/\s+/);
  const firstName = job.firstName?.trim() || suggestedFirstName;
  const lastName = job.lastName?.trim() || suggestedLastName.join(' ');
  const existing = matches[0];

  if (!existing) {
    if (!job.createPerson) throw new Error('This contact is not matched to a Person');
    if (!firstName) throw new Error('No first name for this contact');

    // The job runs as the admin who started the import, so their own permissions apply.
    const created = await userClient().mutation({
      createPerson: {
        __args: {
          data: {
            name: { firstName, lastName },
            phones: {
              primaryPhoneNumber: `+${number}`,
              primaryPhoneCountryCode: '',
              primaryPhoneCallingCode: '',
              additionalPhones: null,
            },
          },
        },
        id: true,
      },
    });
    const id = created.createPerson?.id;
    if (!id) throw new Error('Could not create Person');

    return { id, name: { firstName, lastName } };
  }

  if (isPhoneLikeName(personName(existing)) && firstName) {
    await userClient().mutation({
      updatePerson: { __args: { id: existing.id, data: { name: { firstName, lastName } } }, id: true },
    });
    return { ...existing, name: { firstName, lastName } };
  }

  return existing;
};

// Imports every page of one chat's history. Safe to retry: existing messages are skipped.
const handler = async (job: HistoryImportJob) => {
  const logger = createLogger('whatsapp-history-import-job');

  try {
    if (!isChatId(job.chatId)) throw new Error('Invalid chat ID');

    const status = await getBridgeStatus();
    if (status.state !== 'connected' || !status.phoneNumber) throw new HttpError(502, 'WhatsApp is disconnected');

    const client = applicationClient();
    const accountId = await ensureAccount(client, `+${digits(status.phoneNumber)}`);
    let person: Person | undefined;
    let offset: number | undefined = 0;
    let imported = 0;

    while (offset !== undefined) {
      const page: HistoryMessages = await bridgePost<HistoryMessages>(
        '/history/messages',
        { chatId: job.chatId, rangeDays: job.rangeDays, offset, limit: 25 },
        30_000,
      );

      if (!person && !isGroupChatId(job.chatId)) person = await resolvePerson(job, page.name);

      const name = person ? personName(person) || chatNumber(job.chatId) : page.name.slice(0, 120);
      imported += await importChatMessages(client, accountId, job.chatId, name, page.messages, person);
      offset = page.nextOffset;
    }

    logger.info('Imported chat history', { chatId: job.chatId, imported });
    return { imported };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('History import failed', { chatId: job.chatId, error: message });
    // The bridge being down is worth a retry; anything else will fail the same way again.
    throw error instanceof HttpError && error.status === 502 ? new RetryableLogicFunctionError(message) : error;
  }
};

export default defineLogicFunction({
  universalIdentifier: HISTORY_IMPORT_JOB_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-history-import-job',
  description: 'Import the available history of one WhatsApp chat (background job).',
  timeoutSeconds: 900,
  handler,
});
