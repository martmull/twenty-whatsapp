import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestId } from '../../src/front-components/components/createRequestId.ts';

test('a front component can create a UUID without crypto.randomUUID', () => {
  const randomUUID = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });

  try {
    const first = createRequestId();
    const second = createRequestId();

    assert.match(first, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    assert.notEqual(first, second);
  } finally {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: randomUUID });
  }
});
