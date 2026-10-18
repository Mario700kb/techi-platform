import { ReactNode } from "react";
import { AlertTriangle, HelpCircle } from "lucide-react";

import Button from "./ui/Button";
import Modal from "./ui/Modal";

interface ConfirmationModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  /** The answer cannot be yes yet (e.g. nothing to do). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** A yes/no question on the global Modal; destructive ones carry the danger tone. */
export default function ConfirmationModal({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  loading = false,
  confirmDisabled = false,
  onConfirm,
  onClose,
}: ConfirmationModalProps) {
  return (
    <Modal
      title={title}
      icon={destructive ? AlertTriangle : HelpCircle}
      tone={destructive ? "danger" : "accent"}
      size="sm"
      busy={loading}
      onClose={onClose}
      footer={
        <>
          {/* A destructive question starts on Cancel, so Enter never deletes by accident. */}
          <Button
            variant="secondary"
            type="button"
            onClick={onClose}
            disabled={loading}
            data-autofocus={destructive || undefined}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            type="button"
            onClick={onConfirm}
            disabled={loading || confirmDisabled}
            data-autofocus={!destructive || undefined}
          >
            {loading ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </>
      }
    >
      <div>{children}</div>
    </Modal>
  );
}
