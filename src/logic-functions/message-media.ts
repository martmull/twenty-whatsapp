import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { type ReadableStream as NodeReadableStream } from 'node:stream/web';

import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { MESSAGE_MEDIA_FIELD_ID } from 'src/constants/universal-identifiers';
import { bridgeFetch } from 'src/logic-functions/bridge-request';
import type { BridgeMessageEvent } from 'src/logic-functions/message-data';
import type { UpsertedMessage } from 'src/logic-functions/record-writes';
import { isEventId } from 'src/logic-functions/utils/validators';

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

const putMedia = async (
  body: ReadableStream<Uint8Array>,
  sizeBytes: number,
  url: string,
  contentType: string,
): Promise<void> => {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upload = request(target, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': sizeBytes },
    signal: AbortSignal.timeout(40_000),
  });
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    upload.once('response', resolve);
    upload.once('error', reject);
  });
  const source = Readable.fromWeb(body as NodeReadableStream<Uint8Array>);
  const uploadPromise = pipeline(source, upload);
  let response: IncomingMessage;
  try {
    response = await Promise.race([responsePromise, uploadPromise.then(() => responsePromise)]);
  } catch (error) {
    source.destroy();
    upload.destroy();
    await uploadPromise.catch(() => undefined);
    throw error;
  }
  const responseDrain = finished(response);
  response.resume();
  if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
    source.destroy();
    upload.destroy();
    await Promise.allSettled([uploadPromise, responseDrain]);
    throw new Error(`Media upload failed with status ${response.statusCode}`);
  }
  await Promise.all([uploadPromise, responseDrain]);
};

export const importMessageMedia = async (
  eventId: string,
  fileName: string,
): Promise<{ fileId: string; label: string } | undefined> => {
  if (!isEventId(eventId) || !fileName) {
    return undefined;
  }

  // Media can expire on WhatsApp's side; the message is still imported without it.
  const response = await bridgeFetch(`/media/${eventId}`, {}, 55_000).catch(() => undefined);
  if (!response) {
    return undefined;
  }

  const sizeBytes = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES || !response.body) {
    await response.body?.cancel();
    return undefined;
  }

  const metadataClient = new MetadataApiClient();
  const result = await metadataClient
    .mutation({
      createFileUpload: {
        __args: {
          filename: fileName,
          size: sizeBytes,
          fileFolder: 'FilesField',
          fieldMetadataUniversalIdentifier: MESSAGE_MEDIA_FIELD_ID,
        },
        fileId: true,
        uploadUrl: true,
        contentType: true,
      },
    })
    .catch(async (error: unknown) => {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    });
  const target = result.createFileUpload;
  if (!target?.fileId || !target.uploadUrl || !target.contentType) {
    await response.body.cancel();
    throw new Error('Could not create WhatsApp media upload');
  }

  await putMedia(response.body, sizeBytes, target.uploadUrl, target.contentType);
  const completed = await metadataClient.mutation({
    completeFileUpload: { __args: { fileId: target.fileId }, id: true },
  });
  if (!completed.completeFileUpload?.id) {
    throw new Error('Could not complete WhatsApp media upload');
  }

  return { fileId: completed.completeFileUpload.id, label: fileName };
};

export type MediaItem = { messageId: string; eventId: string; fileName: string };
export type MediaWrite = { id: string; media: { fileId: string; label: string }[] };

// Uploads each file; uploads cost no API budget. Stops starting uploads after the deadline and
// reports how many items it went through, so the caller can retry the rest.
export const uploadMedia = async (
  items: MediaItem[],
  deadline = Number.POSITIVE_INFINITY,
  importFile = importMessageMedia,
): Promise<{ writes: MediaWrite[]; processed: number }> => {
  const writes: MediaWrite[] = [];
  let processed = 0;

  for (const item of items) {
    if (processed > 0 && Date.now() > deadline) break;
    const file = await importFile(item.eventId, item.fileName);
    processed += 1;
    if (file) writes.push({ id: item.messageId, media: [file] });
  }

  return { writes, processed };
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
