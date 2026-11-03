import { parseConvIdStrict } from '@tianting/sdk';
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useConnState, useConversations, useSnapshot } from '../im/hooks';
import { chatPath } from '../lib/routes';
import { decodeParam } from './ChatPage';

/** 聊天信息页（PRD-ui F-UI-12，M3 只读）：没有任何群操作入口，也没有成员网格。 */
export function ChatInfoPage() {
  const convId = decodeParam(useParams().convId);
  const c = useClient();
  const self = useSelf();
  const conv = useConversations().find((x) => x.convId === convId);
  const snapshot = useSnapshot(convId);
  const connected = useConnState() === 'connected';
  // 在聊天信息页期间不是"当前会话"，新消息照常计未读（AC-UI-06-7）。
  useEffect(() => c.setActiveConversation(null), [c]);
  // 进入时刷新成员数（F-UI-12 规则 3）。
  useEffect(() => {
    if (connected && convId.startsWith('group:')) c.refreshConversations().catch(() => {});
  }, [c, convId, connected]);
  let parsed;
  try {
    parsed = parseConvIdStrict(convId, self);
  } catch {
    return <Navigate to="/chats" replace />;
  }
  const group = parsed.convType === 'group';
  const name = conv?.name ?? snapshot?.name ?? parsed.to;
  const members = conv?.memberCount !== undefined ? `群成员（${conv.memberCount}）` : '群成员';
  return (
    <div className="tt-page">
      <TopBar title="聊天信息" back={chatPath(convId)} />
      <div className="tt-scroll tt-info">
        <div className="tt-card tt-info-head">
          <Avatar id={parsed.to} name={name} size={64} group={group} />
          <div>
            <div className="tt-info-name">{name}</div>
            <div className="tt-secondary" data-testid="info-sub">
              {group ? members : `账号：${parsed.to}`}
            </div>
          </div>
        </div>
        {group && !conv && (
          <p className="tt-secondary tt-center" data-testid="info-removed">
            {snapshot?.reason === 'dissolved' ? '群聊已解散' : '你已不在该群'}
          </p>
        )}
      </div>
    </div>
  );
}
