import { t } from 'twenty-sdk/front-component';
import { themeCssVariables } from 'twenty-ui/theme';

import { formatTime, type Message } from 'src/front-components/components/inbox-types';

const PLACEHOLDER_TEXTS = ['[Image]', '[Video]', '[Audio]', '[File]'];

// http(s) URLs only, so a message can never produce a javascript: link.
// Trailing punctuation (as in "see https://example.com.") stays outside the link.
const URL_PATTERN = /(https?:\/\/[^\s]*[^\s.,;:!?)\]'"])/gi;

// Renders message text with its URLs as links opening in a new tab.
const TextWithLinks = ({ text }: { text: string }) =>
  text.split(URL_PATTERN).map((part, index) =>
    index % 2 === 1 ? (
      <a key={index} href={part} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
        {part}
      </a>
    ) : (
      part
    ),
  );

type MessageBubbleProps = {
  message: Message;
  senderName?: string;
  highlighted: boolean;
};

const MessageMedia = ({ message }: { message: Message }) => {
  const url = message.media?.[0]?.url;
  const mediaStyle = {
    display: 'block',
    maxHeight: 360,
    maxWidth: '100%',
    borderRadius: themeCssVariables.border.radius.sm,
  };

  if (!message.mediaKind) return null;
  if (!url) return <div style={{ color: themeCssVariables.font.color.tertiary }}>{t('Media unavailable')}</div>;

  switch (message.mediaKind) {
    case 'IMAGE':
      return (
        <a href={url} target="_blank" rel="noopener noreferrer">
          <img src={url} alt={t('WhatsApp image')} loading="lazy" style={{ ...mediaStyle, objectFit: 'contain' }} />
        </a>
      );
    case 'VIDEO':
      return <video controls preload="metadata" src={url} style={mediaStyle} />;
    case 'AUDIO':
      return <audio controls preload="metadata" src={url} style={{ display: 'block', maxWidth: '100%', width: 320 }} />;
    default:
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
          {message.media?.[0]?.label || t('Download file')}
        </a>
      );
  }
};

export const MessageBubble = ({ message, senderName, highlighted }: MessageBubbleProps) => {
  const outbound = message.direction === 'OUTBOUND';

  return (
    <div
      style={{
        alignSelf: outbound ? 'flex-end' : 'flex-start',
        background: outbound ? themeCssVariables.color.green3 : themeCssVariables.background.primary,
        border: `1px solid ${highlighted ? themeCssVariables.color.blue : themeCssVariables.border.color.medium}`,
        borderRadius: themeCssVariables.border.radius.md,
        color: themeCssVariables.font.color.primary,
        display: 'grid',
        gap: themeCssVariables.spacing[1],
        maxWidth: '78%',
        padding: `${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]}`,
      }}
    >
      {senderName && (
        <strong style={{ color: themeCssVariables.color.green11, fontSize: themeCssVariables.font.size.sm }}>
          {senderName}
        </strong>
      )}
      <MessageMedia message={message} />
      {!(message.mediaKind && PLACEHOLDER_TEXTS.includes(message.text)) && (
        <div style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
          <TextWithLinks text={message.text} />
        </div>
      )}
      <small style={{ color: themeCssVariables.font.color.tertiary, fontSize: themeCssVariables.font.size.xs }}>
        {formatTime(message.sentAt)}
        {outbound && message.deliveryState === 'UNKNOWN' && ` · ${t('Not confirmed')}`}
      </small>
    </div>
  );
};
