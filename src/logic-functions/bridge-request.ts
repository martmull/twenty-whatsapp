type BridgeStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

export const bridgeJsonRequest = async <TResponse>(
  path: '/status' | '/connect' | '/disconnect' | '/events' | '/events/claim' | '/events/release' | '/events/wait' | '/events/notify' | '/events/ack' | '/send' | '/history/list' | '/history/messages' | '/history/names' | '/history/members',
  body?: Record<string, unknown>,
): Promise<TResponse> => {
  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
  const bridgeToken = process.env.WHATSAPP_BRIDGE_TOKEN;

  if (!bridgeUrl || !bridgeToken) {
    throw new Error('WhatsApp bridge variables are not configured');
  }

  const response = await fetch(new URL(path, bridgeUrl), {
    method: path === '/status' || path === '/events' ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(path === '/events/wait' ? 25_000 : path.startsWith('/history/') ? 30_000 : 10_000),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp bridge returned ${response.status}`);
  }

  return (await response.json()) as TResponse;
};

export const bridgeRequest = (path: '/status' | '/connect' | '/disconnect') =>
  bridgeJsonRequest<BridgeStatus>(path);

export const bridgeMediaRequest = async (eventId: string): Promise<Response | undefined> => {
  if (!/^[a-f\d]{64}$/.test(eventId)) {
    throw new Error('Invalid media ID');
  }

  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
  const bridgeToken = process.env.WHATSAPP_BRIDGE_TOKEN;
  if (!bridgeUrl || !bridgeToken) {
    throw new Error('WhatsApp bridge variables are not configured');
  }

  const response = await fetch(new URL(`/media/${eventId}`, bridgeUrl), {
    headers: { authorization: `Bearer ${bridgeToken}` },
    signal: AbortSignal.timeout(55_000),
  });

  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return response;
};
