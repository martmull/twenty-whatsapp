import { HttpError } from 'src/logic-functions/utils/route';

export type BridgeStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

export const bridgeFetch = async (path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> => {
  const bridgeUrl = process.env.WHATSAPP_BRIDGE_URL;
  const bridgeToken = process.env.WHATSAPP_BRIDGE_TOKEN;

  if (!bridgeUrl || !bridgeToken) {
    throw new HttpError(500, 'WhatsApp bridge is not configured');
  }

  const response = await fetch(new URL(path, bridgeUrl), {
    ...init,
    headers: { authorization: `Bearer ${bridgeToken}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined);

  if (!response?.ok) {
    await response?.body?.cancel();
    throw new HttpError(502, 'WhatsApp bridge is unavailable');
  }

  return response;
};

export const bridgePost = async <TResponse>(path: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<TResponse> => {
  const response = await bridgeFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs);

  return (await response.json()) as TResponse;
};

export const getBridgeStatus = async (): Promise<BridgeStatus> =>
  (await (await bridgeFetch('/status')).json()) as BridgeStatus;
