import { useEffect, useState } from 'react';
import { defineSettingsFrontComponent } from 'twenty-sdk/define';
import { t } from 'twenty-sdk/front-component';
import { Callout } from 'twenty-ui/components';
import { Tag } from 'twenty-ui/primitives/data-display';
import { Button } from 'twenty-ui/primitives/input';
import { Card } from 'twenty-ui/primitives/surfaces';
import { Heading, Text } from 'twenty-ui/primitives/typography';
import { themeCssVariables } from 'twenty-ui/theme';
import 'twenty-ui/style.css';

import { SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { callApp, showError } from 'src/front-components/components/app-api';
import { FrontComponentCheckbox } from 'src/front-components/components/FrontComponentCheckbox';
import { WhatsAppHistoryImport } from 'src/front-components/components/WhatsAppHistoryImport';

type ConnectionStatus = {
  state: 'disconnected' | 'pairing' | 'connected' | 'reconnecting';
  qrDataUrl?: string;
  phoneNumber?: string;
  canManage: boolean;
};

const stateTag = (state: ConnectionStatus['state'] = 'disconnected') =>
  ({
    connected: { label: t('Connected'), color: 'green' as const },
    pairing: { label: t('Waiting for scan'), color: 'orange' as const },
    reconnecting: { label: t('Reconnecting'), color: 'orange' as const },
    disconnected: { label: t('Not connected'), color: 'gray' as const },
  })[state];

const WhatsAppSettings = () => {
  const [status, setStatus] = useState<ConnectionStatus>();
  const [ownsNumber, setOwnsNumber] = useState(false);
  const [acceptsRisk, setAcceptsRisk] = useState(false);
  const [working, setWorking] = useState(false);

  // Poll quickly while a QR code is shown, slowly otherwise.
  const pollMs = status?.state === 'pairing' || status?.state === 'reconnecting' ? 3_000 : 30_000;

  useEffect(() => {
    let active = true;
    const refresh = () =>
      callApp<ConnectionStatus>('connection/status')
        .then((next) => active && setStatus(next))
        .catch((error) => showError(error, t('WhatsApp bridge unavailable')));

    void refresh();
    const timer = setInterval(refresh, pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  const perform = async (action: 'start' | 'disconnect') => {
    setWorking(true);
    try {
      setStatus(
        await callApp<ConnectionStatus>(`connection/${action}`, action === 'start' ? { ownsNumber, acceptsRisk } : {}),
      );
    } catch (error) {
      showError(error, action === 'start' ? t('Could not start pairing') : t('Could not disconnect'));
    } finally {
      setWorking(false);
    }
  };

  const tag = stateTag(status?.state);

  return (
    <main
      style={{
        display: 'grid',
        gap: themeCssVariables.spacing[4],
        maxWidth: 840,
        padding: themeCssVariables.spacing[4],
      }}
    >
      <Card.Root>
        <Card.Content>
          <div style={{ display: 'grid', gap: themeCssVariables.spacing[4], padding: themeCssVariables.spacing[4] }}>
            <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
              <Heading level={2} size="sm">
                {t('WhatsApp connection')}
              </Heading>
              <Tag color={tag.color} variant="soft" preventShrink>
                {tag.label}
              </Tag>
            </div>

            {status?.state === 'connected' && (
              <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
                <Text>{status.phoneNumber ? `+${status.phoneNumber}` : ''}</Text>
                {status.canManage && (
                  <Button
                    variant="outline"
                    color="danger"
                    size="sm"
                    disabled={working}
                    onClick={() => void perform('disconnect')}
                  >
                    {t('Disconnect')}
                  </Button>
                )}
              </div>
            )}

            {status?.state === 'pairing' && status.canManage && (
              <div
                style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: themeCssVariables.spacing[4] }}
              >
                {status.qrDataUrl?.startsWith('data:image/png;base64,') ? (
                  <img src={status.qrDataUrl} alt={t('WhatsApp pairing QR code')} width={248} height={248} />
                ) : (
                  <Text style={{ width: 248 }}>{t('Waiting for a QR code…')}</Text>
                )}
                <div style={{ display: 'grid', gap: themeCssVariables.spacing[3] }}>
                  <Text>{t('In WhatsApp, open Linked devices and scan this code.')}</Text>
                  <div>
                    <Button variant="outline" size="sm" disabled={working} onClick={() => void perform('disconnect')}>
                      {t('Cancel')}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {status?.state === 'disconnected' && status.canManage && (
              <div style={{ display: 'grid', gap: themeCssVariables.spacing[3] }}>
                <Callout
                  variant="warning"
                  title={t('Unofficial connection')}
                  description={t(
                    'This links WhatsApp as a web device. WhatsApp may restrict or disconnect the number.',
                  )}
                />
                <label style={{ display: 'flex', gap: themeCssVariables.spacing[2] }}>
                  <FrontComponentCheckbox
                    checked={ownsNumber}
                    onChange={(event) => setOwnsNumber(event.target.checked)}
                  />
                  {t('I control this WhatsApp number')}
                </label>
                <label style={{ display: 'flex', gap: themeCssVariables.spacing[2] }}>
                  <FrontComponentCheckbox
                    checked={acceptsRisk}
                    onChange={(event) => setAcceptsRisk(event.target.checked)}
                  />
                  {t('I accept that it may be disconnected')}
                </label>
                <div>
                  <Button
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
        </Card.Content>
      </Card.Root>
      {status?.state === 'connected' && status.canManage && <WhatsAppHistoryImport />}
    </main>
  );
};

export default defineSettingsFrontComponent({
  universalIdentifier: SETTINGS_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-settings',
  description: 'Linked-device connection settings.',
  component: WhatsAppSettings,
});
