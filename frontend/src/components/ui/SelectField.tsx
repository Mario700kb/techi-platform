import { Children, CSSProperties, isValidElement, ReactElement, ReactNode } from "react";
import Select, { SelectOption } from "./Select";

type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean; label?: string };

interface SelectFieldProps {
  value?: string | number | null;
  /** Same shape as a native <select> change handler: read `event.target.value`. */
  onChange?: (event: { target: { value: string }; currentTarget: { value: string } }) => void;
  children: ReactNode;
  id?: string;
  name?: string;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  required?: boolean;
  title?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

const textOf = (node: ReactNode): string => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
};

function collect(children: ReactNode, out: SelectOption[], group?: string) {
  let pendingGroup = group;
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<OptionProps & { children?: ReactNode; label?: string }>;
    if (el.type === "option") {
      const label = textOf(el.props.children).trim();
      out.push({
        value: String(el.props.value ?? label),
        label,
        disabled: el.props.disabled,
        group: pendingGroup,
      });
      pendingGroup = undefined;
    } else if (el.type === "optgroup") {
      collect(el.props.children, out, el.props.label);
    } else {
      // Fragments and other wrappers around <option> elements.
      const before = out.length;
      collect(el.props.children, out, pendingGroup);
      if (out.length > before) pendingGroup = undefined;
    }
  });
}

/**
 * Drop-in replacement for a native <select>: same props (`value`, `onChange`,
 * `<option>` / `<optgroup>` children), rendered through the themed Select so
 * every dropdown in the app looks and behaves the same.
 */
export default function SelectField({ value, onChange, children, className, title, name: _name, ...rest }: SelectFieldProps) {
  const options: SelectOption[] = [];
  collect(children, options);
  return (
    <Select
      {...rest}
      aria-label={rest["aria-label"] ?? title}
      className={className}
      value={value == null ? "" : String(value)}
      options={options}
      onChange={(next) => onChange?.({ target: { value: next }, currentTarget: { value: next } })}
    />
  );
}
