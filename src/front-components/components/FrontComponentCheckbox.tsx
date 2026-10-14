import type { ComponentProps } from 'react';
import { themeCssVariables } from 'twenty-ui/theme';

type FrontComponentCheckboxProps = Omit<ComponentProps<'input'>, 'type'>;

export const FrontComponentCheckbox = ({ style, ...props }: FrontComponentCheckboxProps) => (
  // Base UI's Checkbox requires browser event constructors unavailable in the front component worker.
  <input type="checkbox" {...props} style={{ accentColor: themeCssVariables.color.blue, ...style }} />
);
