import React from 'react';
import { Modal } from 'antd';
import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmColor?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Thin wrapper around antd Modal for backward compatibility.
 * Since antd provides Modal.confirm built-in, new code should prefer
 * using Modal.confirm directly. This component is kept so that
 * existing call sites continue to work without changes.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmText,
  cancelText,
  confirmColor = 'primary',
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();

  return (
    <Modal
      open={open}
      title={title}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={confirmText || t('common.confirm')}
      cancelText={cancelText || t('common.cancel')}
      okType={confirmColor === 'danger' ? 'primary' : 'primary'}
      okButtonProps={
        confirmColor === 'danger' ? { danger: true } : undefined
      }
      width={400}
      centered
      destroyOnClose
    >
      <p>{message}</p>
    </Modal>
  );
};

export default ConfirmDialog;
