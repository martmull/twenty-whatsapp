import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import {
  INBOX_NAVIGATION_UNIVERSAL_IDENTIFIER,
  INBOX_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: INBOX_NAVIGATION_UNIVERSAL_IDENTIFIER,
  name: 'WhatsApp',
  icon: 'IconBrandWhatsapp',
  color: 'green',
  position: 50,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: INBOX_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
});
