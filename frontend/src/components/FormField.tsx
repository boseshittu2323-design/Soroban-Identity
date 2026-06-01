import { useId, type ChangeEventHandler, type CSSProperties } from 'react';

export interface FormFieldProps {
  label: string;
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  error?: string;
  type?: 'text' | 'number';
  min?: number;
  id?: string;
  style?: CSSProperties;
}

export default function FormField({
  label,
  value,
  onChange,
  placeholder,
  error,
  type = 'text',
  min,
  id: idProp,
  style,
}: FormFieldProps) {
  const generatedId = useId();
  const inputId = idProp ?? generatedId;

  return (
    <div style={style}>
      <label
        htmlFor={inputId}
        style={{
          display: 'block',
          marginBottom: '0.5rem',
          fontSize: '0.85rem',
          fontWeight: 600,
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        min={min}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        style={{
          width: '100%',
          borderColor: error ? 'var(--error)' : undefined,
        }}
      />
      {error && (
        <p
          id={`${inputId}-error`}
          role="alert"
          style={{ color: 'var(--error)', fontSize: '0.75rem', marginTop: '0.25rem' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
