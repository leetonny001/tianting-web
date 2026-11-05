import { c2cConvId } from '@tianting/sdk';
import { useState, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { Dialog } from '../components/Dialog';
import { useClient, useSelf } from '../im/ImProvider';
import { useSocialSettings } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { chatPath } from '../lib/routes';
import { applyPath } from '../lib/social';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 发起单聊（PRD-ui F-UI-05、F-CONV-03）：临时会话只在本地，发出第一条成功后才进入会话列表。 */
export function StartChatDialog({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  /** 从"+"菜单打开时菜单已经关了，焦点回到"+"按钮（AC-UI-05-4）。 */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const self = useSelf();
  const client = useClient();
  const { mode } = useSocialSettings();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  // 好友制下对方不是好友时先提示，不阻断（AC-UI-05-6）；改输入后回到普通状态。
  const [warned, setWarned] = useState<string>();
  const target = value.trim();

  function start() {
    if (!target) return;
    if (!USER_ID_RE.test(target)) {
      setError(messageFor(4004));
      return;
    }
    if (mode === 'friends' && target !== self && client.relationOf(target) !== 'friend') {
      setWarned(target);
      return;
    }
    open(target);
  }

  function open(userId: string) {
    onClose();
    navigate(chatPath(c2cConvId(self, userId)));
  }

  return (
    <Dialog
      title="发起单聊"
      testId="start-chat-dialog"
      onDismiss={onClose}
      returnFocus={returnFocus}
      actions={
        warned ? (
          <>
            <button
              className="tt-btn"
              onClick={() => {
                onClose();
                navigate(applyPath(warned), { state: { source: 'other' } });
              }}
              data-testid="start-chat-apply"
            >
              添加朋友
            </button>
            <button className="tt-btn tt-btn-primary" onClick={() => open(warned)} data-testid="start-chat-anyway">
              仍然发起
            </button>
          </>
        ) : (
          <>
            <button className="tt-btn" onClick={onClose}>
              取消
            </button>
            <button
              className="tt-btn tt-btn-primary"
              disabled={!target}
              onClick={start}
              data-testid="start-chat-submit"
            >
              开始聊天
            </button>
          </>
        )
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
          setWarned(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') start();
        }}
        data-testid="start-chat-input"
      />
      {error && <p className="tt-field-error">{error}</p>}
      {warned && <p data-testid="start-chat-warn">对方不是你的好友，可能无法发送消息</p>}
    </Dialog>
  );
}
