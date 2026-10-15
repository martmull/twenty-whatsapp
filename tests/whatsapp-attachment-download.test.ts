import assert from 'node:assert/strict';
import { test } from 'node:test';

import { downloadAttachment } from '../src/logic-functions/whatsapp-message-send';

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const attachment = { fileId: FILE_ID, label: 'image.png', mimeType: 'image/png', size: 3 };

test('downloads a file from the signed URL returned by Twenty', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(new Uint8Array([1, 2, 3]));
  };

  try {
    const bytes = await downloadAttachment(
      attachment,
      `http://localhost:2020/file/files-field/${FILE_ID}?token=test`,
    );

    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects signed URLs for a different file', async () => {
  await assert.rejects(
    downloadAttachment(
      attachment,
      'http://localhost:2020/file/files-field/00000000-0000-0000-0000-000000000000?token=test',
    ),
    /Invalid attachment URL/,
  );
});
