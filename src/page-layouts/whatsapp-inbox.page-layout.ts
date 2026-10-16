import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';

import {
  INBOX_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  INBOX_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  INBOX_TAB_UNIVERSAL_IDENTIFIER,
  INBOX_WIDGET_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default definePageLayout({
  universalIdentifier: INBOX_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  name: 'WhatsApp inbox',
  type: 'STANDALONE_PAGE',
  tabs: [
    {
      universalIdentifier: INBOX_TAB_UNIVERSAL_IDENTIFIER,
      title: 'Inbox',
      position: 0,
      icon: 'IconMessage',
      layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      widgets: [
        {
          universalIdentifier: INBOX_WIDGET_UNIVERSAL_IDENTIFIER,
          title: 'WhatsApp inbox',
          type: 'FRONT_COMPONENT',
          heightBehavior: 'TAB_VIEWPORT',
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier: INBOX_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
