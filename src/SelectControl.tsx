import type { ComponentPropsWithRef } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import './selectControl.css';

type SelectControlProps = ComponentPropsWithRef<'select'> & {
  density?: 'compact' | 'form';
  wrapperClassName?: string;
};

/** Shared appearance for product selects; the native control owns input and focus. */
export function SelectControl({ density = 'form', wrapperClassName = '', children, ...props }: SelectControlProps) {
  return <span className={`select-control select-control--${density} ${wrapperClassName}`.trim()}>
    <select {...props}>{children}</select>
    <ChevronsUpDown size={14} aria-hidden="true" focusable="false" />
  </span>;
}
