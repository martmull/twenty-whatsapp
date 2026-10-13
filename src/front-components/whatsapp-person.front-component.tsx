import { defineFrontComponent } from 'twenty-sdk/define';
import { t } from 'twenty-sdk/front-component';
import { themeCssVariables } from 'twenty-ui/theme';

import { PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
import { PreviewBadge, getPreviewStyles } from 'src/front-components/components/PreviewUi';

const WhatsAppPerson = () => {
  const styles = getPreviewStyles();

  return (
    <section aria-label={t('WhatsApp conversations')} style={{
      ...styles.root,
      display: 'grid',
      gap: themeCssVariables.spacing[3],
      padding: themeCssVariables.spacing[3],
    }}>
      <div style={{
        alignItems: 'center',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <strong>{t('WhatsApp conversations')}</strong>
        <PreviewBadge>{t('Message sync pending')}</PreviewBadge>
      </div>
      <p style={{ ...styles.muted, margin: 0 }}>
        {t('No WhatsApp messages are linked to this Person yet. Contact matching and message sync will be enabled in the next implementation slice.')}
      </p>
    </section>
  );
};

export default defineFrontComponent({
  universalIdentifier: PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'whatsapp-person',
  description: 'WhatsApp activity on a Person record.',
  component: WhatsAppPerson,
});
