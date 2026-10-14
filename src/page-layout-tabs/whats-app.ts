import {
  definePageLayoutTab,
  PageLayoutTabLayoutMode,
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PERSON_TAB_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default definePageLayoutTab({
  universalIdentifier: PERSON_TAB_UNIVERSAL_IDENTIFIER,
  pageLayoutUniversalIdentifier:
    STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS.personRecordPage
      .universalIdentifier,
  title: 'WhatsApp',
  position: 25,
  icon: 'IconMessage',
  layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
  widgets: [],
});
