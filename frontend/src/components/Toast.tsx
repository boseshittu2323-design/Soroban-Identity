import { useToast } from '../context/ToastContext';
import styles from './Toast.module.css';

export default function ToastContainer() {
  const { toasts, dismiss } = useToast();

  return (
    <div className={styles.container}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`${styles.toast} ${styles[toast.type]}`}
          role="alert"
          aria-live="polite"
        >
          <span>{toast.message}</span>
          <button
            onClick={() => dismiss(toast.id)}
            className={styles.dismissBtn}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
