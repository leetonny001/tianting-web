import { c2cConvId } from '@tianting/sdk';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog } from '../components/Dialog';
import { useSelf } from '../im/ImProvider';
import { messageFor } from '../lib/errors';
import { chatPath } from '../lib/routes';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 发起单聊（PRD-ui F-UI-05、F-CONV-03）：临时会话只在本地，发出第一条成功后才进入会话列表。 */
export function StartChatDialog({ onClose }: { onClose: () => void }) {
  const self = useSelf();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const target = value.trim();

  function start() {
    if (!target) return;
    if (!USER_ID_RE.test(target)) {
      setError(messageFor(4004));
      return;
    }
    onClose();
    navigate(chatPath(c2cConvId(self, target)));
  }

  return (
    <Dialog
      title="发起单聊"
      testId="start-chat-dialog"
      onDismiss={onClose}
      actions={
        <>
          <button className="tt-btn" onClick={onClose}>
            取消
          </button>
          <button className="tt-btn tt-btn-primary" disabled={!target} onClick={start} data-testid="start-chat-submit">
            开始聊天
          </button>
        </>
      }
    >
      <input
        className="tt-input"
        placeholder="输入对方账号"
        value={value}
        autoFocus
        autoCapitalize="off"
        onChange={(e) => {
          setValue(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') start();
        }}
        data-testid="start-chat-input"
      />
      {error && <p className="tt-field-error">{error}</p>}
    </Dialog>
  );
}
