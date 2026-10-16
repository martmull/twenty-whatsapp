import { useEffect, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineSettingsFrontComponent } from 'twenty-sdk/define';
import { t } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components';
import { Tag } from 'twenty-ui/primitives/data-display';
import { Button } from 'twenty-ui/primitives/input';
import { themeCssVariables } from 'twenty-ui/theme';
import 'twenty-ui/style.css';

import { SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { FrontComponentCheckbox } from 'src/front-components/components/FrontComponentCheckbox';
import { WhatsAppHistoryImport } from 'src/front-components/components/WhatsAppHistoryImport';
import { getPreviewStyles } from 'src/front-components/components/PreviewUi';

type ConnectionStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  qrExpiresAt?: number;
  phoneNumber?: string;
};

const parseStatus = (value: unknown): ConnectionStatus => {
  if (typeof value !== 'object' || value === null || !('state' in value)) {
    throw new Error('Unexpected bridge response');
  }

  const state = value.state;

  if (
    state !== 'disconnected' &&
    state !== 'pairing' &&
    state !== 'connected' &&
    state !== 'reconnecting'
  ) {
    throw new Error('Unexpected bridge state');
  }

  const record = value as Record<string, unknown>;

  return {
    state,
    qrDataUrl:
      typeof record.qrDataUrl === 'string' &&
      record.qrDataUrl.startsWith('data:image/png;base64,')
        ? record.qrDataUrl
        : undefined,
    qrExpiresAt:
      typeof record.qrExpiresAt === 'number' ? record.qrExpiresAt : undefined,
    phoneNumber:
      typeof record.phoneNumber === 'string' ? record.phoneNumber : undefined,
  };
};

const requestStatus = async (): Promise<ConnectionStatus> =>
  parseStatus(
    await new RestApiClient().post('/s/whatsapp/connection/status', {}),
  );

const WhatsAppSettings = () => {
  const styles = getPreviewStyles();
  const [status, setStatus] = useState<ConnectionStatus>();
  const [ownsNumber, setOwnsNumber] = useState(false);
  const [acceptsRisk, setAcceptsRisk] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = async () => {
    setWorking(true);
    setError('');
    try {
      setStatus(await requestStatus());
      setError('');
    } catch {
      setError(t('The WhatsApp bridge is unavailable. Check its URL, token, and process.'));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const refresh = async () => {
      try {
        const nextStatus = await requestStatus();

        if (!cancelled) {
          setStatus(nextStatus);
          setError('');
        }
      } catch {
        if (!cancelled) {
          setError(t('The WhatsApp bridge is unavailable. Check its URL, token, and process.'));
        }
      }

      if (!cancelled) {
        timer = setTimeout(refresh, 3_000);
      }
    };

    void refresh();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const perform = async (action: 'start' | 'disconnect') => {
    setWorking(true);
    setError('');

    try {
      const result = await new RestApiClient().post(
        '/s/whatsapp/connection/' + action,
        action === 'start' ? { ownsNumber, acceptsRisk } : {},
      );
      setStatus(parseStatus(result));
    } catch {
      setError(
        action === 'start'
          ? t('Could not start pairing. Check administrator access and the bridge configuration.')
          : t('Could not disconnect. Please retry.'),
      );
    } finally {
      setWorking(false);
    }
  };

  const badge = status?.state === 'connected'
    ? { label: t('Connected'), color: 'green' as const }
    : status?.state === 'pairing'
      ? { label: t('Waiting for scan'), color: 'orange' as const }
      : status?.state === 'reconnecting'
        ? { label: t('Reconnecting'), color: 'orange' as const }
        : { label: t('Not connected'), color: 'gray' as const };

  return (
    <main style={{
      ...styles.root,
      display: 'grid',
      gap: themeCssVariables.spacing[4],
      maxWidth: 840,
      padding: themeCssVariables.spacing[4],
    }}>
      <div>
        <h2 style={{ margin: 0 }}>{t('WhatsApp connection')}</h2>
        <p style={styles.muted}>
          {t('Link a phone by scanning a QR code in WhatsApp → Linked devices.')}
        </p>
      </div>
      <div style={{
        ...styles.card,
        display: 'grid',
        gap: themeCssVariables.spacing[4],
        padding: themeCssVariables.spacing[4],
      }}>
        <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
          <strong>{t('Linked device')}</strong>
          <Tag color={badge.color} variant="soft" preventShrink>{badge.label}</Tag>
        </div>
        <div>
          <Button type="button" variant="outline" size="sm" loading={working} onClick={() => void refreshStatus()}>
            {t('Check connection')}
          </Button>
        </div>
        {error && <Callout variant="error" title={t('Connection unavailable')} description={error} />}
        {status?.state === 'connected' && (
          <div style={{ display: 'grid', gap: themeCssVariables.spacing[3] }}>
            <span>{t('Phone number')}: <strong>{status.phoneNumber ?? t('Connected')}</strong></span>
            <span style={styles.muted}>
              {t('New direct messages from matched People, including available images, videos, and audio, appear in the inbox and on Person records. Selected groups appear in the shared inbox after import.')}
            </span>
            <div>
              <Button type="button" variant="outline" color="danger" size="sm" disabled={working} onClick={() => void perform('disconnect')}>
                {t('Disconnect and remove session')}
              </Button>
            </div>
          </div>
        )}
        {status?.state === 'pairing' && (
          <div style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: themeCssVariables.spacing[5],
          }}>
            {status.qrDataUrl ? (
              <img src={status.qrDataUrl} alt={t('WhatsApp pairing QR code')} width={248} height={248} />
            ) : (
              <div style={{ ...styles.muted, width: 248 }}>{t('Waiting for a fresh QR code…')}</div>
            )}
            <div style={{ display: 'grid', gap: themeCssVariables.spacing[2] }}>
              <strong>{t('Scan on your phone')}</strong>
              <ol style={{ ...styles.muted, lineHeight: 1.8, margin: 0, paddingLeft: 20 }}>
                <li>{t('Open WhatsApp on the phone that owns the number.')}</li>
                <li>{t('Go to Linked devices, then Link a device.')}</li>
                <li>{t('Scan this QR code.')}</li>
              </ol>
              {status.qrExpiresAt && (
                <span style={styles.label}>
                  {t('QR expires at')} {new Date(status.qrExpiresAt).toLocaleTimeString()}
                </span>
              )}
              <div>
                <Button type="button" variant="outline" size="sm" disabled={working} onClick={() => void perform('disconnect')}>
                  {t('Cancel pairing')}
                </Button>
              </div>
            </div>
          </div>
        )}
        {status?.state === 'reconnecting' && (
          <p style={styles.muted}>
            {t('The linked device is reconnecting. Keep WhatsApp available on your phone.')}
          </p>
        )}
        {(!status || status.state === 'disconnected') && (
          <div style={{ display: 'grid', gap: themeCssVariables.spacing[3] }}>
            <div style={{
              background: themeCssVariables.background.secondary,
              borderRadius: themeCssVariables.border.radius.sm,
              padding: themeCssVariables.spacing[3],
            }}>
              <strong>{t('Before you connect')}</strong>
              <p style={styles.muted}>
                {t('This app uses an unofficial WhatsApp Web client. WhatsApp may restrict or disconnect your number. This app is not affiliated with Meta. New messages and available images, videos, and audio from matched People are shared with permitted workspace members. Available earlier history is stored encrypted on the bridge for optional review and is shared only if you import it.')}
              </p>
              <a href="https://www.whatsapp.com/legal/terms-of-service" target="_blank" rel="noreferrer">
                {t('Read WhatsApp terms')}
              </a>
            </div>
            <label style={{ display: 'flex', gap: themeCssVariables.spacing[2] }}>
              <FrontComponentCheckbox checked={ownsNumber} onChange={(event) => setOwnsNumber(event.target.checked)} aria-label={t('I control this WhatsApp number')} />
              {t('I control this WhatsApp number and can authorize its connection.')}
            </label>
            <label style={{ display: 'flex', gap: themeCssVariables.spacing[2] }}>
              <FrontComponentCheckbox checked={acceptsRisk} onChange={(event) => setAcceptsRisk(event.target.checked)} aria-label={t('I understand the unofficial connection risk')} />
              {t('I understand an unofficial linked-device connection may be restricted or disconnected.')}
            </label>
            <div>
              <Button
                type="button"
                variant="solid"
                color="accent"
                size="sm"
                disabled={working || !ownsNumber || !acceptsRisk}
                onClick={() => void perform('start')}
              >
                {t('Show QR code')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {status?.state === 'connected' && <WhatsAppHistoryImport />}
    </main>
  );
};

export default defineSettingsFrontComponent({
  universalIdentifier: SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-settings',
  description: 'Linked-device connection settings.',
  component: WhatsAppSettings,
});
