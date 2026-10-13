import {
  definePageLayoutWidget,
  PageLayoutTabLayoutMode,
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  PERSON_WIDGET_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default definePageLayoutWidget({
  universalIdentifier: PERSON_WIDGET_UNIVERSAL_IDENTIFIER,
  pageLayoutTabUniversalIdentifier:
    STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS.personRecordPage.tabs.home
      .universalIdentifier,
  title: 'WhatsApp conversations',
  type: 'FRONT_COMPONENT',
  position: { layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST, index: 1000 },
  configuration: {
    configurationType: 'FRONT_COMPONENT',
    frontComponentUniversalIdentifier:
      PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  },
});
