import { IMError } from '@tianting/sdk';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Dialog } from '../components/Dialog';
import { FriendPicker } from '../components/FriendPicker';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { groupCreateErrorText, MAX_GROUP_NAME, MIN_GROUP_PICK } from '../lib/group';
import { chatPath } from '../lib/routes';
import { textLen, useGoBack } from '../lib/social';

/** 发起群聊（PRD-ui F-UI-35）。 */
export function GroupNewPage() {
  const c = useClient();
  const self = useSelf();
  const navigate = useNavigate();
  const toast = useToast();
  const back = useGoBack('/chats');
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<ReadonlySet<string>>(new Set());
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const inFlight = useRef(false);
  const tooLong = textLen(name) > MAX_GROUP_NAME;

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function create() {
    if (inFlight.current || tooLong) return;
    inFlight.current = true;
    const trimmed = name.trim();
    try {
      const { conv } = await c.createGroup({ members: selected, ...(trimmed ? { name: trimmed } : {}) });
      navigate(chatPath(conv.convId), { replace: true });
    } catch (e) {
      setNaming(false);
      toast(groupCreateErrorText(e, c, self));
      if (e instanceof IMError && e.userId) setErrors(new Set([e.userId]));
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="tt-page">
      <TopBar
        title="发起群聊"
        back={back}
        right={
          <button
            className="tt-link tt-topbar-action"
            disabled={selected.length < MIN_GROUP_PICK}
            onClick={() => setNaming(true)}
            data-testid="pick-done"
          >
            完成（{selected.length}）
          </button>
        }
      />
      <FriendPicker selected={selected} onToggle={toggle} errors={errors} />
      {naming && (
        <Dialog
          sheet
          testId="group-name-sheet"
          title="群聊名称（选填）"
          onDismiss={() => setNaming(false)}
          actions={
            <>
              <button className="tt-btn" onClick={() => setNaming(false)}>
                取消
              </button>
              <button
                className="tt-btn tt-btn-primary"
                disabled={tooLong}
                onClick={() => void create()}
                data-testid="group-create"
              >
                创建
              </button>
            </>
          }
        >
          <input
            className="tt-input"
            aria-label="群聊名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="group-name-input"
          />
          {tooLong && (
            <p className="tt-field-error" role="alert">
              最多 {MAX_GROUP_NAME} 个字
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
