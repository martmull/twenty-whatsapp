import { downloadContentFromMessage, type WAMessage } from '@whiskeysockets/baileys';

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

export type MediaKind = 'image' | 'video' | 'audio';

export type MediaSummary = {
  kind: MediaKind;
  mimeType: string;
  fileName: string;
  sizeBytes?: number;
};

export type MediaReference = MediaSummary & {
  mediaKey: string;
  directPath?: string;
  url?: string;
};

const MEDIA_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/webm': 'webm',
};

export const describeMedia = (
  message: WAMessage,
  eventId: string,
): { summary: MediaSummary; reference?: MediaReference; caption?: string } | undefined => {
  const image = message.message?.imageMessage;
  const video = message.message?.videoMessage;
  const audio = message.message?.audioMessage;
  const content = image ?? video ?? audio;

  if (!content) {
    return undefined;
  }

  const kind: MediaKind = image ? 'image' : video ? 'video' : 'audio';
  const suppliedMimeType = content.mimetype?.split(';')[0].trim().toLowerCase();
  const mimeType =
    suppliedMimeType && MEDIA_FORMATS[suppliedMimeType] && suppliedMimeType.startsWith(`${kind}/`)
      ? suppliedMimeType
      : kind === 'image'
        ? 'image/jpeg'
        : kind === 'video'
          ? 'video/mp4'
          : 'audio/ogg';
  const size = Number(content.fileLength ?? 0);
  const summary: MediaSummary = {
    kind,
    mimeType,
    fileName: `${eventId}.${MEDIA_FORMATS[mimeType]}`,
    ...(Number.isSafeInteger(size) && size > 0 ? { sizeBytes: size } : {}),
  };
  const mediaKey = content.mediaKey?.length ? Buffer.from(content.mediaKey).toString('base64') : undefined;
  const directPath = content.directPath || undefined;
  const url = content.url || undefined;
  const caption = image?.caption || video?.caption;

  return {
    summary,
    ...(mediaKey && (directPath || url) ? { reference: { ...summary, mediaKey, directPath, url } } : {}),
    ...(caption ? { caption } : {}),
  };
};

export const downloadMedia = async (reference: MediaReference): Promise<Buffer> => {
  if (reference.sizeBytes && reference.sizeBytes > MAX_MEDIA_BYTES) {
    throw new Error('Media exceeds import size limit');
  }

  const stream = await downloadContentFromMessage(
    {
      mediaKey: Buffer.from(reference.mediaKey, 'base64'),
      directPath: reference.directPath,
      url: reference.url,
    },
    reference.kind,
    { options: { timeout: 45_000 } },
  );
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MEDIA_BYTES) {
      stream.destroy();
      throw new Error('Media exceeds import size limit');
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    throw new Error('Media is empty');
  }

  return Buffer.concat(chunks, size);
};
