import {
  definePageLayoutWidget,
  PageLayoutTabLayoutMode,
} from 'twenty-sdk/define';

import {
  PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  PERSON_TAB_UNIVERSAL_IDENTIFIER,
  PERSON_WIDGET_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default definePageLayoutWidget({
  universalIdentifier: PERSON_WIDGET_UNIVERSAL_IDENTIFIER,
  pageLayoutTabUniversalIdentifier: PERSON_TAB_UNIVERSAL_IDENTIFIER,
  title: 'WhatsApp conversation',
  type: 'FRONT_COMPONENT',
  position: { layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST, index: 0 },
  heightBehavior: 'TAB_VIEWPORT',
  configuration: {
    configurationType: 'FRONT_COMPONENT',
    frontComponentUniversalIdentifier:
      PERSON_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  },
});
