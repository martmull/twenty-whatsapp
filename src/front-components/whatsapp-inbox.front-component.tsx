import { defineFrontComponent } from 'twenty-sdk/define';
import { t } from 'twenty-sdk/front-component';
import { themeCssVariables } from 'twenty-ui/theme';

import { INBOX_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { PreviewBadge, getPreviewStyles } from 'src/front-components/components/PreviewUi';

const WhatsAppInbox = () => {
  const styles = getPreviewStyles();

  return (
    <main style={{
      ...styles.root,
      display: 'grid',
      gap: themeCssVariables.spacing[3],
      gridTemplateRows: 'auto minmax(0, 1fr)',
      height: '100%',
      minHeight: 560,
      padding: themeCssVariables.spacing[3],
    }}>
      <header style={{
        alignItems: 'center',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <div>
          <h2 style={{ margin: 0 }}>{t('WhatsApp inbox')}</h2>
          <p style={styles.muted}>{t('Shared conversations with People in this workspace.')}</p>
        </div>
        <PreviewBadge>{t('Message sync pending')}</PreviewBadge>
      </header>
      <div style={{
        ...styles.card,
        display: 'grid',
        gridTemplateColumns: 'minmax(185px, 30%) minmax(0, 1fr)',
        overflow: 'hidden',
      }}>
        <aside aria-label={t('Conversations')} style={{
          borderRight: '1px solid ' + themeCssVariables.border.color.medium,
          padding: themeCssVariables.spacing[3],
        }}>
          <strong>{t('Conversations')}</strong>
          <p style={styles.muted}>{t('No synced conversations yet')}</p>
        </aside>
        <section aria-label={t('Message thread')} style={{
          alignItems: 'center',
          background: themeCssVariables.background.secondary,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: themeCssVariables.spacing[6],
          textAlign: 'center',
        }}>
          <strong>{t('Your inbox will appear here')}</strong>
          <p style={{ ...styles.muted, maxWidth: 420 }}>
            {t('QR pairing is implemented. Receiving, storing, and sending messages will be enabled after CRM contact matching and permissions are in place.')}
          </p>
        </section>
      </div>
    </main>
  );
};

export default defineFrontComponent({
  universalIdentifier: INBOX_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-inbox',
  description: 'WhatsApp inbox shell awaiting message sync.',
  component: WhatsAppInbox,
});
