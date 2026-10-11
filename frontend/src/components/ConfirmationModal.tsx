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
          <Button variant="secondary" type="button" onClick={onClose} disabled={loading} data-autofocus={destructive || undefined}>{cancelLabel}</Button>
          <Button variant={destructive ? "danger" : "primary"} type="button" onClick={onConfirm} disabled={loading} data-autofocus={!destructive || undefined}>
            {loading ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </>
      }
    >
      <div>{children}</div>
    </Modal>
  );
}
