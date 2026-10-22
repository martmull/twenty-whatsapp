import type { CoreApiClient } from 'twenty-client-sdk/core';

import { bridgePost } from 'src/logic-functions/bridge-request';
import { applicationClient, nodesOf, type Message } from 'src/logic-functions/message-data';
import { countingClient } from 'src/logic-functions/record-writes';
import type { Logger } from 'src/logic-functions/utils/logger';
import { isEventId } from 'src/logic-functions/utils/validators';

export type BridgeReceipt = { eventId: string; state: 'failed' | 'delivered' | 'read' };
type ClaimedReceipts = { receipts?: BridgeReceipt[]; remaining?: boolean; waitMs?: number };
type DeliveryState = Message['deliveryState'];

export type ReceiptSyncResult = { updated: number; remaining: boolean };

const STATE: Record<BridgeReceipt['state'], DeliveryState> = {
  failed: 'FAILED',
  delivered: 'DELIVERED',
  read: 'READ',
};

// The states a receipt may replace: a message only moves forward, so a late "delivered" never
// replaces "read", and "failed" never replaces a confirmed delivery.
const REPLACES: Partial<Record<DeliveryState, DeliveryState[]>> = {
  FAILED: ['UNKNOWN', 'SENT'],
  DELIVERED: ['UNKNOWN', 'SENT', 'FAILED'],
  READ: ['UNKNOWN', 'SENT', 'FAILED', 'DELIVERED'],
};

// The delivery state to write for each message a receipt moves forward.
export const planReceiptUpdates = (
  receipts: BridgeReceipt[],
  messages: Pick<Message, 'id' | 'externalId' | 'deliveryState'>[],
): Map<DeliveryState, string[]> => {
  const byExternalId = new Map(messages.map((message) => [message.externalId, message]));
  const updates = new Map<DeliveryState, string[]>();

  for (const receipt of receipts) {
    const message = byExternalId.get(receipt.eventId);
    const target = STATE[receipt.state];
    if (!message || !REPLACES[target]?.includes(message.deliveryState ?? 'UNKNOWN')) continue;
    updates.set(target, [...(updates.get(target) ?? []), message.id]);
  }

  return updates;
};

// Writes the delivery and read receipts the bridge queued for outgoing messages: one query, then
// one update per state. Receipts for messages not in Twenty yet stay queued for a while on the
// bridge (their message may still be waiting as an event).
export const syncReceipts = async (
  logger: Logger,
  { client: baseClient = applicationClient() }: { client?: CoreApiClient } = {},
): Promise<ReceiptSyncResult> => {
  const claimed = await bridgePost<ClaimedReceipts>('/receipts/claim');
  const receipts = (claimed.receipts ?? []).filter(
    (receipt) => isEventId(receipt?.eventId) && Object.prototype.hasOwnProperty.call(STATE, receipt.state),
  );
  if (receipts.length === 0) return { updated: 0, remaining: false };

  const counter = { requests: 0 };
  const client = countingClient(baseClient, counter);
  const eventIds = [...new Set(receipts.map((receipt) => receipt.eventId))];
  const result = await client.query({
    whatsappMessages: {
      __args: { filter: { externalId: { in: eventIds }, direction: { eq: 'OUTBOUND' } }, first: eventIds.length },
      edges: { node: { id: true, externalId: true, deliveryState: true } },
    },
  });
  const messages = nodesOf<Pick<Message, 'id' | 'externalId' | 'deliveryState'>>(result.whatsappMessages);

  let updated = 0;
  for (const [deliveryState, ids] of planReceiptUpdates(receipts, messages)) {
    await client.mutation({
      updateWhatsappMessages: { __args: { filter: { id: { in: ids } }, data: { deliveryState } }, id: true },
    });
    updated += ids.length;
  }

  const found = new Set(messages.map((message) => message.externalId));
  await bridgePost('/receipts/ack', {
    written: receipts.filter((receipt) => found.has(receipt.eventId)),
    missing: receipts.filter((receipt) => !found.has(receipt.eventId)).map((receipt) => receipt.eventId),
  });

  logger.info('Synced receipts', { updated, received: receipts.length, requests: counter.requests });
  return { updated, remaining: Boolean(claimed.remaining) };
};
