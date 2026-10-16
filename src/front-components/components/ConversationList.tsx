import { t } from 'twenty-sdk/front-component';
import { NotificationCounter, SearchInput } from 'twenty-ui/components';
import { Avatar } from 'twenty-ui/primitives/data-display';
import { ListItem } from 'twenty-ui/primitives/navigation';
import { themeCssVariables } from 'twenty-ui/theme';

import { formatTime, type Conversation } from 'src/front-components/components/inbox-types';

type ConversationListProps = {
  conversations: Conversation[];
  selectedId?: string;
  search?: string;
  onSearchChange?: (search: string) => void;
  onSelect: (conversationId: string) => void;
};

export const ConversationList = ({ conversations, selectedId, search, onSearchChange, onSelect }: ConversationListProps) => (
  <aside style={{ borderRight: `1px solid ${themeCssVariables.border.color.medium}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    {onSearchChange && (
      <div style={{ padding: themeCssVariables.spacing[2] }}>
        <SearchInput value={search} placeholder={t('Search')} onChange={(event) => onSearchChange(event.target.value)} />
      </div>
    )}
    <div style={{ overflowY: 'auto' }}>
      {conversations.map((conversation) => (
        <ListItem
          key={conversation.id}
          selected={conversation.id === selectedId}
          onClick={() => onSelect(conversation.id)}
          startIcon={<Avatar name={conversation.name} colorSeed={conversation.id} size="md" />}
          description={conversation.lastPreview ?? ''}
          endIcon={conversation.unread ? <NotificationCounter count={1} /> : <small>{formatTime(conversation.lastMessageAt)}</small>}
        >
          <span style={{ fontWeight: conversation.unread ? 700 : undefined }}>{conversation.name}</span>
        </ListItem>
      ))}
    </div>
  </aside>
);
