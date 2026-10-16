import { RestApiClient, RestApiClientError } from 'twenty-client-sdk/rest';
import { enqueueSnackbar } from 'twenty-sdk/front-component';

// Calls one of the app's logic function routes (`/s/...`).
export const callApp = <TResponse>(path: string, body: Record<string, unknown> = {}) =>
  new RestApiClient().post<TResponse>(`/s/whatsapp/${path}`, body);

// Error text returned by our routes (`{ error }`), or the given fallback.
export const errorMessage = (error: unknown, fallback: string) => {
  const body = error instanceof RestApiClientError ? error.body : undefined;
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback;
};

export const showError = (error: unknown, fallback: string) => {
  void enqueueSnackbar({ message: errorMessage(error, fallback), variant: 'error', dedupeKey: fallback });
};
