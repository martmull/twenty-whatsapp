import { createHash } from 'node:crypto';

import type { CoreApiClient } from 'twenty-client-sdk/core';

// Twenty caps createMany at 200 records; the byte cap keeps a page of long texts under request size limits.
export const MAX_UPSERT_RECORDS = 200;
export const MAX_UPSERT_BYTES = 512_000;

// Namespace of the UUID v5 ids this app derives from WhatsApp identities. Never change it: existing
// records would stop matching their derived id.
const ID_NAMESPACE = Buffer.from('5f0c6b1e9d3a4c7e8b2f61a4d9e07c35', 'hex');

export type DerivedIdKind = 'person' | 'conversation';

// A stable UUID v5 for a record the app creates, so a retried or duplicated write lands on the same row.
export const deterministicId = (kind: DerivedIdKind, key: string): string => {
  const bytes = createHash('sha1').update(ID_NAMESPACE).update(`${kind}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type GraphqlError = { message?: string; extensions?: { code?: string; retryAfterMs?: unknown } };

const graphqlErrors = (error: unknown): GraphqlError[] => {
  const errors = (error as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(errors) ? (errors as GraphqlError[]) : [];
};

export const isRateLimitError = (error: unknown): boolean =>
  graphqlErrors(error).some((item) => item?.extensions?.code === 'RATE_LIMITED') ||
  (error instanceof Error && /too many requests|rate limit|limit reached/i.test(error.message));

// How long Twenty asks us to wait, when the error is a rate limit. Twenty sends retryAfterMs with
// RATE_LIMITED; an older server does not, so a full window is assumed.
export const rateLimitRetryAfterMs = (error: unknown, fallbackMs = 60_000): number | undefined => {
  if (!isRateLimitError(error)) return undefined;

  const retryAfterMs = graphqlErrors(error)
    .map((item) => item?.extensions?.retryAfterMs)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);

  return Math.ceil(retryAfterMs ?? fallbackMs);
};

export const chunkRecords = <TRecord>(
  records: TRecord[],
  maxRecords = MAX_UPSERT_RECORDS,
  maxBytes = MAX_UPSERT_BYTES,
): TRecord[][] => {
  const chunks: TRecord[][] = [];
  let chunk: TRecord[] = [];
  let bytes = 0;

  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (chunk.length > 0 && (chunk.length >= maxRecords || bytes + size > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(record);
    bytes += size;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
};

type Selection = Record<string, unknown>;

// One createMany(upsert: true) per chunk. Twenty matches each record on its id or any unique index,
// inserts the rest, and writes only the fields sent, so callers send the fields they own.
const upsertRecords = async <TNode>(
  client: CoreApiClient,
  mutationName: string,
  records: Record<string, unknown>[],
  selection: Selection,
): Promise<TNode[]> => {
  const nodes: TNode[] = [];

  for (const chunk of chunkRecords(records)) {
    const result = await client.mutation({
      [mutationName]: { __args: { data: chunk, upsert: true }, ...selection },
    });
    const written = result?.[mutationName] as TNode[] | undefined;

    if (!Array.isArray(written) || written.length !== chunk.length) {
      throw new Error(`Could not write ${mutationName.replace(/^create/, '')}`);
    }
    nodes.push(...written);
  }

  return nodes;
};

export type UpsertedMessage = {
  id: string;
  externalId: string;
  conversationId: string;
  mediaKind?: string | null;
  media?: { fileId: string }[] | null;
  // False when the message was already in Twenty and only updated.
  created: boolean;
};

export const upsertMessages = async (
  client: CoreApiClient,
  records: Record<string, unknown>[],
): Promise<UpsertedMessage[]> => {
  const nodes = await upsertRecords<Omit<UpsertedMessage, 'created'> & { createdAt?: string; updatedAt?: string }>(
    client,
    'createWhatsappMessages',
    records,
    {
      id: true,
      externalId: true,
      conversationId: true,
      mediaKind: true,
      media: { fileId: true },
      createdAt: true,
      updatedAt: true,
    },
  );

  // An inserted row gets both timestamps from the same transaction; an update moves updatedAt only.
  return nodes.map(({ createdAt, updatedAt, ...message }) => ({
    ...message,
    created: Boolean(createdAt) && createdAt === updatedAt,
  }));
};

export const upsertConversations = (
  client: CoreApiClient,
  records: Record<string, unknown>[],
): Promise<{ id: string; chatId: string }[]> =>
  upsertRecords(client, 'createWhatsappConversations', records, { id: true, chatId: true });

export const upsertPeople = (client: CoreApiClient, records: Record<string, unknown>[]): Promise<{ id: string }[]> =>
  upsertRecords(client, 'createPeople', records, { id: true });

// Counts the root operations made through the client: what Twenty rate limits, and what a job
// reports back to the bridge's budget.
export const countingClient = (client: CoreApiClient, counter: { requests: number }): CoreApiClient =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'query' || property === 'mutation') && typeof value === 'function') {
        return (selection: Record<string, unknown>, ...rest: unknown[]) => {
          counter.requests += Math.max(1, Object.keys(selection ?? {}).length);
          return value.apply(target, [selection, ...rest]);
        };
      }
      return value;
    },
  });
