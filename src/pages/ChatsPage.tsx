import type { Conversation } from '@tianting/sdk';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { ConnBanner } from '../components/ConnBanner';
import { Icon } from '../components/Icon';
import { badgeText, TabBar } from '../components/TabBar';
import { TopBar } from '../components/TopBar';
import { useSelf } from '../im/ImProvider';
import {
  useConversations,
  useConversationsLoaded,
  useConversationsTruncated,
  useDisplayName,
  useFriends,
  useProfile,
} from '../im/hooks';
import { chatPath } from '../lib/routes';
import { formatTime } from '../lib/time';
import { StartChatDialog } from './StartChatDialog';

// 返回会话列表时恢复滚动位置（AC-UI-01-5）。只在本页生命周期之外保存一个数字，不存任何会话内容。
let savedScrollTop = 0;

/** 会话列表（PRD-ui F-UI-04）。 */
export function ChatsPage() {
  const convs = useConversations();
  const loaded = useConversationsLoaded();
  const truncated = useConversationsTruncated();
  const friends = useFriends();
  const self = useSelf();
  // 单聊显示名：备注 > 服务端给的会话名（备注只在本机，PRD-social 5.5 节）。算好传给 memo 的会话项，避免每项都订阅。
  const remarks = useMemo(() => new Map(friends.filter((f) => f.remark).map((f) => [f.userId, f.remark])), [friends]);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // 性能检查（AC-UI-90-6）：会话列表第一次渲染完成。
  const marked = useRef(false);
  useLayoutEffect(() => {
    if (!marked.current && loaded) {
      marked.current = true;
      performance.mark('tt-convs-rendered');
    }
  });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = savedScrollTop;
    return () => {
      if (el) savedScrollTop = el.scrollTop;
    };
  }, [loaded]);

  return (
    <div className="tt-page">
      <TopBar
        title="消息"
        right={
          <button
            className="tt-icon-btn"
            aria-label="更多操作"
            onClick={() => setMenu((v) => !v)}
            data-testid="plus-button"
          >
            <Icon name="plus" />
          </button>
        }
      />
      {menu && (
        <div className="tt-menu-layer" onClick={() => setMenu(false)}>
          <div
            className="tt-menu tt-plus-menu"
            role="menu"
            onClick={(e) => e.stopPropagation()}
            data-testid="plus-menu"
          >
            <button role="menuitem" onClick={() => navigate('/contacts/add')}>
              <Icon name="addFriend" size={20} />
              添加朋友
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(false);
                setDialog(true);
              }}
            >
              <Icon name="chats" size={20} />
              发起单聊
            </button>
          </div>
        </div>
      )}
      <ConnBanner />
      <div className="tt-scroll" ref={listRef} data-testid="conv-list">
        {!loaded && convs.length === 0 ? (
          <Skeleton />
        ) : convs.length === 0 ? (
          <div className="tt-empty" data-testid="chats-empty">
            <div className="tt-empty-art" aria-hidden="true" />
            <p>还没有聊天</p>
            <button className="tt-btn tt-btn-primary" onClick={() => setDialog(true)}>
              发起单聊
            </button>
          </div>
        ) : (
          <>
            {convs.map((c) => (
              <ConvItem
                key={c.convId}
                conv={c}
                remark={c.type === 'c2c' ? remarks.get(peerOf(c.convId, self)) : undefined}
              />
            ))}
            {truncated && (
              <p className="tt-list-foot" data-testid="convs-truncated">
                仅显示最近 500 个会话
              </p>
            )}
          </>
        )}
      </div>
      <TabBar onReselectChats={() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
      {dialog && <StartChatDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

function Skeleton() {
  return (
    <div data-testid="chats-skeleton" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div className="tt-conv tt-skeleton" key={i}>
          <span className="tt-skeleton-avatar" />
          <span className="tt-skeleton-lines">
            <span />
            <span />
          </span>
        </div>
      ))}
    </div>
  );
}

const summaryText = (c: Conversation) => {
  const m = c.lastMsg;
  if (!m) return '';
  return m.type === 'text' ? m.text : '[暂不支持的消息]';
};

/** 群摘要的发送者前缀（PRD-ui F-UI-04 规则 5）：显示名未就绪时先显示 userId，就绪后替换。 */
function SenderPrefix({ userId }: { userId: string }) {
  return <>{useDisplayName(userId)}: </>;
}

function PeerOfficial({ id }: { id: string }) {
  return useProfile(id)?.official ? <OfficialTag /> : null;
}

const ConvItem = memo(function ConvItem({ conv, remark }: { conv: Conversation; remark?: string }) {
  const self = useSelf();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const group = conv.type === 'group';
  const id = conv.convId.slice(conv.convId.indexOf(':') + 1);
  const name = remark || conv.name;
  const from = conv.lastMsg?.from;
  return (
    <Link className="tt-conv" to={chatPath(conv.convId)} data-testid="conv-item" data-conv-id={conv.convId}>
      <span className="tt-conv-avatar">
        <Avatar id={group ? id : peerOf(conv.convId, self)} name={name} size={48} group={group} />
        {conv.unread > 0 && (
          <span className="tt-badge" data-testid="conv-badge">
            {badgeText(conv.unread)}
          </span>
        )}
      </span>
      <span className="tt-conv-main">
        <span className="tt-conv-row">
          <span className="tt-conv-name">{name}</span>
          {!group && <PeerOfficial id={peerOf(conv.convId, self)} />}
          {conv.lastMsg && <span className="tt-conv-time">{formatTime(conv.lastMsg.ts, now)}</span>}
        </span>
        <span className="tt-conv-summary">
          {group && from && from !== self && <SenderPrefix userId={from} />}
          {summaryText(conv)}
        </span>
      </span>
    </Link>
  );
});

function peerOf(convId: string, self: string): string {
  const [, a = '', b = ''] = convId.split(':');
  return a === self ? b : a;
}
