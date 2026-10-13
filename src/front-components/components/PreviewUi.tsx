import type { CSSProperties, ReactNode } from 'react';
import { themeCssVariables } from 'twenty-ui/theme';

export const getPreviewStyles = () => ({
  root: {
    boxSizing: 'border-box',
    color: themeCssVariables.font.color.primary,
    fontFamily: themeCssVariables.font.family,
    fontSize: themeCssVariables.font.size.md,
    minHeight: '100%',
    width: '100%',
  } satisfies CSSProperties,
  card: {
    background: themeCssVariables.background.primary,
    border: `1px solid ${themeCssVariables.border.color.medium}`,
    borderRadius: themeCssVariables.border.radius.md,
  } satisfies CSSProperties,
  muted: {
    color: themeCssVariables.font.color.secondary,
    fontSize: themeCssVariables.font.size.sm,
    lineHeight: themeCssVariables.text.lineHeight.md,
  } satisfies CSSProperties,
  label: {
    color: themeCssVariables.font.color.tertiary,
    fontSize: themeCssVariables.font.size.sm,
  } satisfies CSSProperties,
  button: {
    alignItems: 'center',
    background: themeCssVariables.background.primary,
    border: `1px solid ${themeCssVariables.border.color.medium}`,
    borderRadius: themeCssVariables.border.radius.sm,
    color: themeCssVariables.font.color.primary,
    cursor: 'pointer',
    display: 'inline-flex',
    fontFamily: themeCssVariables.font.family,
    fontSize: themeCssVariables.font.size.md,
    fontWeight: themeCssVariables.font.weight.medium,
    justifyContent: 'center',
    minHeight: themeCssVariables.spacing[8],
    padding: `0 ${themeCssVariables.spacing[3]}`,
  } satisfies CSSProperties,
  primaryButton: {
    background: themeCssVariables.color.blue,
    borderColor: themeCssVariables.color.blue,
    color: '#fff',
  } satisfies CSSProperties,
} as const);

type PreviewBadgeProps = {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'orange' | 'red';
};

export const PreviewBadge = ({
  children,
  tone = 'neutral',
}: PreviewBadgeProps) => {
  const colorByTone = {
    neutral: themeCssVariables.font.color.secondary,
    green: themeCssVariables.color.green,
    orange: themeCssVariables.color.orange,
    red: themeCssVariables.color.red,
  };

  return (
    <span
      style={{
        alignItems: 'center',
        border: `1px solid ${themeCssVariables.border.color.medium}`,
        borderRadius: themeCssVariables.border.radius.sm,
        color: colorByTone[tone],
        display: 'inline-flex',
        fontSize: themeCssVariables.font.size.sm,
        fontWeight: themeCssVariables.font.weight.medium,
        gap: themeCssVariables.spacing[1],
        padding: `${themeCssVariables.spacing[1]} ${themeCssVariables.spacing[2]}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
};

type PreviewButtonProps = {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  primary?: boolean;
};

export const PreviewButton = ({
  children,
  disabled = false,
  onClick,
  primary = false,
}: PreviewButtonProps) => {
  const previewStyles = getPreviewStyles();

  return <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={{
      ...previewStyles.button,
      ...(primary ? previewStyles.primaryButton : {}),
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    {children}
  </button>;
};
