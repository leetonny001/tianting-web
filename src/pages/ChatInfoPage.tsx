import { parseConvIdStrict } from '@tianting/sdk';
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useConversations } from '../im/hooks';
import { chatPath } from '../lib/routes';
import { decodeParam } from './ChatPage';

/** 聊天信息页（PRD-ui F-UI-12，M3 只读）：没有任何群操作入口，也没有成员网格。 */
export function ChatInfoPage() {
  const convId = decodeParam(useParams().convId);
  const c = useClient();
  const self = useSelf();
  const conv = useConversations().find((x) => x.convId === convId);
  // 在聊天信息页期间不是"当前会话"，新消息照常计未读（AC-UI-06-7）。
  useEffect(() => c.setActiveConversation(null), [c]);
  let parsed;
  try {
    parsed = parseConvIdStrict(convId, self);
  } catch {
    return <Navigate to="/chats" replace />;
  }
  const group = parsed.convType === 'group';
  const name = conv?.name ?? parsed.to;
  return (
    <div className="tt-page">
      <TopBar title="聊天信息" back={chatPath(convId)} />
      <div className="tt-scroll tt-info">
        <div className="tt-card tt-info-head">
          <Avatar id={parsed.to} name={name} size={64} group={group} />
          <div>
            <div className="tt-info-name">{name}</div>
            <div className="tt-secondary">{group ? '群成员' : `账号：${parsed.to}`}</div>
          </div>
        </div>
        {group && !conv && <p className="tt-secondary tt-center">你已不在该群</p>}
      </div>
    </div>
  );
}
