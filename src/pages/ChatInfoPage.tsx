import { parseConvIdStrict } from '@tianting/sdk';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useConversations, useFriends, useProfile, useSnapshot } from '../im/hooks';
import { chatPath } from '../lib/routes';
import { userPath } from '../lib/social';
import { decodeParam } from './ChatPage';
import { GroupSettings } from './GroupSettings';

const GONE_TEXT: Record<string, string> = { dissolved: '群聊已解散', left: '你已退出该群聊' };

/** 聊天信息页：单聊只读（PRD-ui F-UI-12）；群聊是群设置（F-UI-36），已不在群里时只显示群名和提示。 */
export function ChatInfoPage() {
  const convId = decodeParam(useParams().convId);
  const c = useClient();
  const self = useSelf();
  const conv = useConversations().find((x) => x.convId === convId);
  const snapshot = useSnapshot(convId);
  const navigate = useNavigate();
  useFriends(); // 备注变化时刷新显示名
  // 在聊天信息页期间不是"当前会话"，新消息照常计未读（AC-UI-06-7）。
  useEffect(() => c.setActiveConversation(null), [c]);
  const [gone, setGone] = useState(false);
  const onGone = useCallback(() => setGone(true), []);
  let parsed;
  try {
    parsed = parseConvIdStrict(convId, self);
  } catch {
    return <Navigate to="/chats" replace />;
  }
  const group = parsed.convType === 'group';
  if (group && !snapshot && !gone) return <GroupSettings key={convId} convId={convId} onGone={onGone} />;
  const to = parsed.to;
  const local = group ? to : c.displayName(to);
  const name = !group && local !== to ? local : (conv?.name ?? snapshot?.name ?? to);
  return (
    <div className="tt-page">
      <TopBar title="聊天信息" back={chatPath(convId)} />
      <div className="tt-scroll tt-info">
        <div
          className={`tt-card tt-info-head${group ? '' : ' tt-clickable'}`}
          data-testid="info-head"
          onClick={group ? undefined : () => navigate(userPath(to), { state: { source: 'conv' } })}
        >
          <Avatar id={to} name={name} size={64} group={group} />
          <div>
            <div className="tt-info-name">
              {name} {!group && <PeerOfficial id={to} />}
            </div>
            <div className="tt-secondary" data-testid="info-sub">
              {group ? '群聊' : `账号：${to}`}
            </div>
          </div>
        </div>
        {group && !conv && (
          <p className="tt-secondary tt-center" data-testid="info-removed">
            {GONE_TEXT[snapshot?.reason ?? ''] ?? '你已不在该群'}
          </p>
        )}
      </div>
    </div>
  );
}

function PeerOfficial({ id }: { id: string }) {
  return useProfile(id)?.official ? <OfficialTag /> : null;
}
