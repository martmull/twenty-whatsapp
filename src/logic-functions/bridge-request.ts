type BridgeStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

export const bridgeJsonRequest = async <TResponse>(
  path: '/status' | '/connect' | '/disconnect' | '/events' | '/events/ack' | '/send',
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
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp bridge returned ${response.status}`);
  }

  return (await response.json()) as TResponse;
};

export const bridgeRequest = (path: '/status' | '/connect' | '/disconnect') =>
  bridgeJsonRequest<BridgeStatus>(path);
