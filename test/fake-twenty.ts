// A stand-in for Twenty's API that records each root operation (what Twenty rate limits) and keeps
// the records written, so tests can assert both the requests made and the resulting data.
type Selection = Record<string, { __args?: Record<string, unknown> } & Record<string, unknown>>;
type Row = Record<string, unknown> & { id: string };

export type FakeTwenty = ReturnType<typeof createFakeTwenty>;

const OBJECTS: Record<string, { collection: string; uniqueKeys: string[][] }> = {
  WhatsappMessages: { collection: 'whatsappMessages', uniqueKeys: [['externalId'], ['requestId']] },
  WhatsappConversations: { collection: 'whatsappConversations', uniqueKeys: [['accountId', 'chatId']] },
  People: { collection: 'people', uniqueKeys: [] },
  WhatsappAccounts: { collection: 'whatsappAccounts', uniqueKeys: [['phoneNumber']] },
};

const MANY_MUTATIONS: Record<string, string> = {
  createWhatsappMessages: 'WhatsappMessages',
  createWhatsappConversations: 'WhatsappConversations',
  createPeople: 'People',
};
const SINGLE_MUTATIONS: Record<string, string> = {
  createWhatsappMessage: 'WhatsappMessages',
  updateWhatsappMessage: 'WhatsappMessages',
  createWhatsappConversation: 'WhatsappConversations',
  updateWhatsappConversation: 'WhatsappConversations',
  createPerson: 'People',
  updatePerson: 'People',
  createWhatsappAccount: 'WhatsappAccounts',
  updateWhatsappAccount: 'WhatsappAccounts',
};

const matchesFilter = (row: Row, filter: Record<string, Record<string, unknown>> = {}): boolean =>
  Object.entries(filter).every(([field, condition]) => {
    if (field === 'phones') {
      const wanted = (condition as { primaryPhoneNumber?: { in?: string[] } }).primaryPhoneNumber?.in ?? [];
      return wanted.includes((row.phones as { primaryPhoneNumber?: string } | undefined)?.primaryPhoneNumber ?? '');
    }
    if ('eq' in condition) return row[field] === condition.eq;
    if ('in' in condition) return (condition.in as unknown[]).includes(row[field]);
    return true;
  });

export const createFakeTwenty = (seed: Partial<Record<string, Row[]>> = {}) => {
  const store: Record<string, Row[]> = {
    whatsappMessages: [],
    whatsappConversations: [],
    people: [],
    whatsappAccounts: [],
    ...seed,
  } as Record<string, Row[]>;
  const requests: string[] = [];
  let clock = Date.UTC(2026, 9, 17);
  let nextId = 1;
  let failNext: unknown;
  let rejectRecord: ((record: Record<string, unknown>) => boolean) | undefined;

  const tick = () => new Date((clock += 1000)).toISOString();

  const upsert = (objectName: string, data: Record<string, unknown>[]) => {
    if (data.some((record) => rejectRecord?.(record))) throw new Error('Invalid record');
    const { collection, uniqueKeys } = OBJECTS[objectName];
    const rows = store[collection];

    return data.map((record) => {
      const existing = rows.find(
        (row) =>
          (record.id && row.id === record.id) ||
          uniqueKeys.some((keys) => keys.every((key) => record[key] !== undefined && row[key] === record[key])),
      );
      const now = tick();
      if (existing) {
        Object.assign(existing, record, { id: existing.id, updatedAt: now });
        return existing;
      }
      const row = {
        ...record,
        id: (record.id as string) ?? `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
        createdAt: now,
        updatedAt: now,
      } as Row;
      rows.push(row);
      return row;
    });
  };

  const client = {
    query: async (selection: Selection) => {
      const [name, body] = Object.entries(selection)[0];
      requests.push(`query ${name}`);
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        throw error;
      }
      const args = (body.__args ?? {}) as { filter?: Record<string, Record<string, unknown>>; first?: number };
      const rows = (store[name] ?? []).filter((row) => matchesFilter(row, args.filter)).slice(0, args.first ?? 60);
      return { [name]: { edges: rows.map((node) => ({ node })), pageInfo: { hasNextPage: false } } };
    },
    mutation: async (selection: Selection) => {
      const [name, body] = Object.entries(selection)[0];
      requests.push(`mutation ${name}`);
      if (failNext) {
        const error = failNext;
        failNext = undefined;
        throw error;
      }
      const args = body.__args as { data: Record<string, unknown> | Record<string, unknown>[]; id?: string };
      const many = MANY_MUTATIONS[name];
      if (many) {
        return { [name]: upsert(many, args.data as Record<string, unknown>[]) };
      }
      const single = SINGLE_MUTATIONS[name];
      if (single) {
        const data = name.startsWith('update') ? { ...(args.data as object), id: args.id } : args.data;
        return { [name]: upsert(single, [data as Record<string, unknown>])[0] };
      }
      throw new Error(`Unexpected mutation ${name}`);
    },
  };

  return {
    client: client as never,
    store,
    requests,
    failNextRequest: (error: unknown) => {
      failNext = error;
    },
    rejectRecords: (predicate: (record: Record<string, unknown>) => boolean) => {
      rejectRecord = predicate;
    },
  };
};

export type BridgeCall = { path: string; body: Record<string, unknown> };

// Replaces fetch for bridge calls; each handler answers one path.
export const mockBridge = (handlers: Record<string, (body: Record<string, unknown>) => unknown>) => {
  const calls: BridgeCall[] = [];
  const originalFetch = globalThis.fetch;
  process.env.WHATSAPP_BRIDGE_URL = 'http://bridge.test';
  process.env.WHATSAPP_BRIDGE_TOKEN = 'token';
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify((await handler(body)) ?? {}));
  };

  return { calls, restore: () => (globalThis.fetch = originalFetch) };
};
