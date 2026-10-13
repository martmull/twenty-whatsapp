type BridgeStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

export const bridgeRequest = async (
  path: '/status' | '/connect' | '/disconnect',
): Promise<BridgeStatus> => {
  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
  const bridgeToken = process.env.WHATSAPP_BRIDGE_TOKEN;

  if (!bridgeUrl || !bridgeToken) {
    throw new Error('WhatsApp bridge variables are not configured');
  }

  const response = await fetch(new URL(path, bridgeUrl), {
    method: path === '/status' ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${bridgeToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`WhatsApp bridge returned ${response.status}`);
  }

  return (await response.json()) as BridgeStatus;
};
