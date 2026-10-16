import { useState } from 'react';
import { t } from 'twenty-sdk/front-component';
import { IconButton } from 'twenty-ui/components';
import { IconPaperclip, IconSend, IconX } from 'twenty-ui/icon';
import { Chip } from 'twenty-ui/primitives/data-display';
import { Textarea } from 'twenty-ui/primitives/input';
import { themeCssVariables } from 'twenty-ui/theme';

import { createRequestId } from 'src/front-components/components/createRequestId';

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

export type PendingFile = { id: string; file: File };

type MessageComposerProps = {
  disabled: boolean;
  sending: boolean;
  // Resolves with what could not be sent, kept in the composer for a retry.
  onSend: (text: string, files: PendingFile[]) => Promise<{ text: string; files: PendingFile[] }>;
};

// Pasted files have no name; give them one so WhatsApp shows something sensible.
const withName = (file: File) =>
  file.name.trim()
    ? file
    : new File([file], `pasted-file-${Date.now()}.${file.type.split('/')[1] ?? 'bin'}`, { type: file.type });

export const MessageComposer = ({ disabled, sending, onSend }: MessageComposerProps) => {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const canSend = !disabled && !sending && (text.trim() !== '' || files.length > 0);

  const addFiles = (added: File[]) => {
    if (disabled || sending) return;
    const accepted = added.filter((file) => file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES);
    setFiles((previous) => [...previous, ...accepted.map((file) => ({ id: createRequestId(), file: withName(file) }))]);
  };

  const send = async () => {
    if (!canSend) return;
    const remaining = await onSend(text, files);
    setText(remaining.text);
    setFiles(remaining.files);
  };

  return (
    <div
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer?.files ?? []));
      }}
      style={{
        borderTop: `1px solid ${themeCssVariables.border.color.medium}`,
        display: 'grid',
        gap: themeCssVariables.spacing[2],
        padding: themeCssVariables.spacing[3],
      }}
    >
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: themeCssVariables.spacing[2] }}>
          {files.map((pending) => (
            <Chip
              key={pending.id}
              endElement={
                <IconButton
                  size="xs"
                  variant="ghost"
                  aria-label={t('Remove')}
                  disabled={sending}
                  onClick={() => setFiles((previous) => previous.filter((item) => item.id !== pending.id))}
                >
                  <IconX size={12} />
                </IconButton>
              }
            >
              {pending.file.name}
            </Chip>
          ))}
        </div>
      )}
      <div style={{ alignItems: 'flex-end', display: 'flex', gap: themeCssVariables.spacing[2] }}>
        {/* A transparent native input over the button: the sandbox only opens file pickers from a real click. */}
        <span style={{ position: 'relative' }}>
          <IconButton variant="ghost" aria-label={t('Attach files')} disabled={disabled || sending}>
            <IconPaperclip size={16} />
          </IconButton>
          <input
            type="file"
            multiple
            aria-label={t('Attach files')}
            disabled={disabled || sending}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
            style={{ cursor: 'pointer', inset: 0, opacity: 0, position: 'absolute' }}
          />
        </span>
        <div style={{ flex: 1 }}>
          <Textarea
            aria-label={t('Message')}
            placeholder={t('Message')}
            value={text}
            disabled={disabled || sending}
            maxLength={4096}
            autoResize
            maxRows={6}
            rows={1}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const pasted = Array.from(event.clipboardData?.files ?? []);
              if (pasted.length) {
                event.preventDefault();
                addFiles(pasted);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!event.repeat) void send();
              }
            }}
          />
        </div>
        <IconButton
          variant="solid"
          color="accent"
          aria-label={t('Send')}
          loading={sending}
          disabled={!canSend}
          onClick={() => void send()}
        >
          <IconSend size={16} />
        </IconButton>
      </div>
    </div>
  );
};
