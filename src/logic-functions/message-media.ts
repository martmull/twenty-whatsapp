import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { type ReadableStream as NodeReadableStream } from 'node:stream/web';

import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import { WHATSAPP_MESSAGE_MEDIA_FIELD_ID } from 'src/fields/media';
import { bridgeMediaRequest } from 'src/logic-functions/bridge-request';

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

type MediaEvent = {
  eventId: string;
  media?: { kind: 'image' | 'video' | 'audio'; mimeType: string; fileName: string; sizeBytes?: number };
};

const putMedia = async (body: ReadableStream<Uint8Array>, sizeBytes: number, url: string, contentType: string): Promise<void> => {
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

export const importMessageMedia = async (event: MediaEvent): Promise<{ fileId: string; label: string } | undefined> => {
  if (!event.media) {
    return undefined;
  }

  const response = await bridgeMediaRequest(event.eventId);
  if (!response) {
    return undefined;
  }

  const sizeBytes = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_MEDIA_BYTES || !response.body) {
    await response.body?.cancel();
    return undefined;
  }

  const metadataClient = new MetadataApiClient();
  const result = await metadataClient.mutation({
    createFileUpload: {
      __args: {
        filename: event.media.fileName,
        size: sizeBytes,
        fileFolder: 'FilesField',
        fieldMetadataUniversalIdentifier: WHATSAPP_MESSAGE_MEDIA_FIELD_ID,
      },
      fileId: true,
      uploadUrl: true,
      contentType: true,
    },
  }).catch(async (error: unknown) => {
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

  return { fileId: completed.completeFileUpload.id, label: event.media.fileName };
};
