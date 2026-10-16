import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { uploadFile, type UploadedFrontComponentFile } from 'twenty-sdk/front-component';

import { MESSAGE_MEDIA_FIELD_ID } from 'src/constants/universal-identifiers';

let mediaFieldMetadataId: string | undefined;

const getMediaFieldMetadataId = async (): Promise<string> => {
  if (mediaFieldMetadataId) return mediaFieldMetadataId;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await new MetadataApiClient().query({
      objects: {
        __args: { paging: { first: 100, ...(cursor ? { after: cursor } : {}) }, filter: {} },
        pageInfo: { hasNextPage: true, endCursor: true },
        edges: { node: { fieldsList: { id: true, universalIdentifier: true } } },
      },
    });
    const field = result.objects.edges.flatMap((edge) => edge.node.fieldsList ?? [])
      .find((candidate) => candidate.universalIdentifier === MESSAGE_MEDIA_FIELD_ID);
    if (field) {
      mediaFieldMetadataId = field.id;
      return field.id;
    }
    if (!result.objects.pageInfo.hasNextPage || !result.objects.pageInfo.endCursor) break;
    cursor = result.objects.pageInfo.endCursor;
  }
  throw new Error('WhatsApp media field is unavailable');
};

export const uploadWhatsAppAttachment = async (file: File): Promise<UploadedFrontComponentFile> => {
  const fieldMetadataId = await getMediaFieldMetadataId();
  const result = await uploadFile(file, { fieldMetadataId, fileName: file.name });
  if (result.status !== 'uploaded') throw new Error('Could not upload attachment');
  return result.file;
};
