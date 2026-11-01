import { Title } from '@radix-ui/react-dialog';
import { LoaderCircle, X } from 'lucide-react';
import { Dialog } from './Dialog';
import { useI18n } from '../../i18n';
import './console-loading.css';

export function ConsoleLoading({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      id="control-console"
      className="console-loading"
      aria-describedby={undefined}
      onCancel={onClose}
    >
      <button
        type="button"
        className="console-loading-close"
        aria-label={t('common.close')}
        onClick={onClose}
      >
        <X size={16} aria-hidden="true" />
      </button>
      <LoaderCircle
        className="console-loading-spinner"
        size={28}
        aria-hidden="true"
      />
      <Title className="console-loading-title">{t('console.title')}</Title>
      <p role="status" aria-live="polite">
        {t('common.loading')}
      </p>
    </Dialog>
  );
}
