import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { FriendPicker } from '../components/FriendPicker';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useGroupMembers } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { groupIdOf, infoPath, inviteResultText, MAX_GROUP_BATCH } from '../lib/group';
import { errCode } from '../lib/social';
import { decodeParam } from './ChatPage';

/** 邀请成员（PRD-ui F-UI-39）：已加载到的群成员显示"已在群里"；没加载到的由服务端忽略。 */
export function GroupInvitePage() {
  const convId = decodeParam(useParams().convId);
  const groupId = groupIdOf(convId);
  const c = useClient();
  const self = useSelf();
  const navigate = useNavigate();
  const toast = useToast();
  const { members } = useGroupMembers(groupId);
  const joined = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(false);

  function toggle(id: string) {
    if (selected.includes(id)) return setSelected(selected.filter((x) => x !== id));
    if (selected.length >= MAX_GROUP_BATCH) return toast(`一次最多邀请 ${MAX_GROUP_BATCH} 人`);
    setSelected([...selected, id]);
  }

  async function invite() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { added, failed } = await c.inviteToGroup(groupId, selected);
      toast(inviteResultText(added.length, failed, c, self));
      if (added.length > 0) navigate(infoPath(convId), { replace: true });
      else setErrors(new Set(failed.map((f) => f.userId)));
    } catch (e) {
      toast(messageFor(errCode(e), 'groupInvite'));
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="tt-page">
      <TopBar
        title="邀请成员"
        back={infoPath(convId)}
        right={
          <button
            className="tt-link tt-topbar-action"
            disabled={selected.length === 0}
            onClick={() => void invite()}
            data-testid="pick-done"
          >
            完成（{selected.length}）
          </button>
        }
      />
      <FriendPicker selected={selected} onToggle={toggle} joined={joined} errors={errors} />
    </div>
  );
}
