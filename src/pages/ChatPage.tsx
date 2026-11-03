import { ConvIdError, parseConvIdStrict, type Message } from '@tianting/sdk';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { ConnBanner } from '../components/ConnBanner';
import { Confirm } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useConversations, useConversationsLoaded, useMessages } from '../im/hooks';
import { copyText } from '../lib/clipboard';
import { chatPath } from '../lib/routes';
import { formatTime, needsDivider } from '../lib/time';
import { Composer } from './Composer';

const BOTTOM_SLACK = 100; // 距底部不超过 100px 算"在底部"（F-MSG-06 规则 5）

/** 聊天页（PRD-ui F-UI-06～F-UI-10）。路由里的会话 ID 先严格解析（G-UI-03），不合法回到会话列表。 */
export function ChatPage() {
  const raw = decodeParam(useParams().convId);
  const self = useSelf();
  const toast = useToast();
  let parsed: { convType: 'c2c' | 'group'; to: string } | null = null;
  try {
    parsed = parseConvIdStrict(raw, self);
  } catch (e) {
    if (!(e instanceof ConvIdError)) throw e;
  }
  useEffect(() => {
    if (!parsed) toast('会话不存在');
  }, [parsed, toast]);
  if (!parsed) return <Navigate to="/chats" replace />;
  return <Chat key={raw} convId={raw} type={parsed.convType} to={parsed.to} />;
}

function Chat({ convId, type, to }: { convId: string; type: 'c2c' | 'group'; to: string }) {
  const c = useClient();
  const self = useSelf();
  const navigate = useNavigate();
  const toast = useToast();
  const convs = useConversations();
  const loaded = useConversationsLoaded();
  const conv = convs.find((x) => x.convId === convId);
  const messages = useMessages(convId);
  const [removed, setRemoved] = useState(false);
  const [history, setHistory] = useState<'idle' | 'loading' | 'end' | 'error'>('idle');
  const [newCount, setNewCount] = useState(0);
  const [retry, setRetry] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ m: Message; top: number; below: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevLen = useRef(0);
  const anchor = useRef<number | null>(null); // 加载历史前的 scrollHeight，用来保持可视位置不跳动

  // 只有聊天页实际可见时才是当前会话（F-UI-06 规则 8）；离开时设为 null。
  useEffect(() => {
    c.setActiveConversation(convId);
    return () => c.setActiveConversation(null);
  }, [c, convId]);

  useEffect(() => c.on('convRemoved', (id) => id === convId && setRemoved(true)) as () => void, [c, convId]);
  useEffect(
    () =>
      c.on('sendFailed', (id, _cid, err) => {
        if (id === convId && err === 4033) setRemoved(true);
      }) as () => void,
    [c, convId],
  );

  // 群不在会话列表里：本次登录期间被移出，或者不是成员 / 群不存在（F-UI-33）。
  // 打开时向服务端确认（sync 返回 4033 / 4043 再区分文案）由 SDK 的 G-UI-26（FE-206）补上。
  const notMember = type === 'group' && (removed || (loaded && !conv));

  // 打开会话时加载最新一页（F-MSG-05 规则 3）。
  useEffect(() => {
    if (conv && conv.maxSeq > 0 && c.messages(convId).length === 0) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv?.maxSeq === undefined]);

  async function loadMore() {
    if (history === 'loading' || history === 'end') return;
    const el = scroller.current;
    anchor.current = el ? el.scrollHeight - el.scrollTop : null;
    setHistory('loading');
    try {
      const more = await c.loadHistory(convId);
      setHistory(more ? 'idle' : 'end');
    } catch {
      setHistory('error');
      anchor.current = null;
    }
  }

  // 新消息：在底部时自动滚到底，否则累计"↓ N 条新消息"。历史加载后保持可视位置。
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (messages.length > prevLen.current) {
      const last = messages[messages.length - 1];
      if (atBottom.current || last?.from === self || prevLen.current === 0) {
        el.scrollTop = el.scrollHeight;
        setNewCount(0);
      } else {
        setNewCount((n) => n + (messages.length - prevLen.current));
      }
    }
    prevLen.current = messages.length;
  }, [messages, self]);

  const title = conv?.name ?? to; // 临时单聊（还没有会话）显示对方账号
  const rows = useMemo(() => withDividers(messages), [messages]);

  return (
    <div className="tt-page tt-chat">
      <TopBar
        title={<span className="tt-ellipsis">{title}</span>}
        back="/chats"
        right={
          <button
            className="tt-icon-btn"
            aria-label="聊天信息"
            onClick={() => navigate(`${chatPath(convId)}/info`)}
            data-testid="chat-more"
          >
            <Icon name="more" />
          </button>
        }
      />
      <ConnBanner />
      <div
        className="tt-messages"
        ref={scroller}
        data-testid="message-list"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
          if (atBottom.current) setNewCount(0);
          if (el.scrollTop < 40 && messages.length > 0 && history === 'idle') void loadMore();
        }}
      >
        {messages.length > 0 && (
          <div className="tt-history" data-testid="history-state">
            {history === 'loading' && '加载中…'}
            {history === 'end' && '没有更多了'}
            {history === 'error' && (
              <button className="tt-link" onClick={() => void loadMore()}>
                加载失败，点击重试
              </button>
            )}
          </div>
        )}
        {rows.map((r) =>
          r.kind === 'divider' ? (
            <div className="tt-divider" key={r.key}>
              {formatTime(r.ts)}
            </div>
          ) : (
            <Bubble
              key={r.m.clientMsgId}
              m={r.m}
              self={r.m.from === self}
              showName={type === 'group' && r.m.from !== self}
              onRetry={() => setRetry(r.m)}
              onMenu={(top, below) => setMenu({ m: r.m, top, below })}
            />
          ),
        )}
        {notMember && <div className="tt-divider">你已不在该群</div>}
      </div>
      {newCount > 0 && (
        <button
          className="tt-new-pill"
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
            setNewCount(0);
          }}
          data-testid="new-messages"
        >
          ↓ {newCount} 条新消息
        </button>
      )}
      {notMember ? (
        <div className="tt-composer-disabled" data-testid="composer-disabled">
          你已不在该群，无法发送消息
        </div>
      ) : (
        <Composer
          onSend={(text) => {
            const r = c.send(convId, text);
            if (r.ok) {
              atBottom.current = true;
              return true;
            }
            return false;
          }}
        />
      )}
      {retry && (
        <Confirm
          text="重发该消息？"
          ok="重发"
          testId="retry-dialog"
          onCancel={() => setRetry(null)}
          onOk={() => {
            c.retry(convId, retry.clientMsgId);
            setRetry(null);
          }}
        />
      )}
      {menu && (
        <div className="tt-menu-layer" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div
            className="tt-menu tt-bubble-menu"
            role="menu"
            style={{ top: menu.top }}
            data-below={menu.below || undefined}
            onClick={(e) => e.stopPropagation()}
            data-testid="bubble-menu"
          >
            {menu.m.type === 'text' && (
              <button
                role="menuitem"
                onClick={async () => {
                  const ok = await copyText(menu.m.body.text ?? '');
                  toast(ok ? '已复制' : '复制失败，请长按文字手动复制');
                  setMenu(null);
                }}
              >
                复制
              </button>
            )}
            {menu.m.status === 'failed' && (
              <button
                role="menuitem"
                onClick={() => {
                  c.retry(convId, menu.m.clientMsgId); // 菜单里的"重发"不再二次确认（F-UI-09 规则 3）
                  setMenu(null);
                }}
              >
                重发
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type Row = { kind: 'divider'; key: string; ts: number } | { kind: 'msg'; m: Message };

function withDividers(ms: Message[]): Row[] {
  const out: Row[] = [];
  let prev: number | undefined;
  for (const m of ms) {
    if (needsDivider(prev, m.ts)) out.push({ kind: 'divider', key: `d-${m.clientMsgId}`, ts: m.ts });
    out.push({ kind: 'msg', m });
    prev = m.ts;
  }
  return out;
}

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const MENU_HEIGHT = 96;

/** 消息气泡（F-UI-07、F-UI-08）。长按 500ms（移动超过 10px 取消）或右键打开菜单（F-UI-09）。 */
function Bubble({
  m,
  self,
  showName,
  onRetry,
  onMenu,
}: {
  m: Message;
  self: boolean;
  showName: boolean;
  onRetry: () => void;
  onMenu: (top: number, below: boolean) => void;
}) {
  const press = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout> } | null>(null);
  const supported = m.type === 'text';
  const hasMenu = supported || m.status === 'failed';
  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const list = el.closest('.tt-messages')?.getBoundingClientRect();
    const below = !!list && r.top - list.top < MENU_HEIGHT;
    onMenu(below ? r.bottom + 4 : r.top - MENU_HEIGHT - 4, below);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  return (
    <div
      className={`tt-msg${self ? ' tt-msg-self' : ''}`}
      data-testid="message"
      data-status={m.status}
      data-client-msg-id={m.clientMsgId}
    >
      <Avatar id={m.from} name={m.from} size={40} />
      <div className="tt-msg-body">
        {showName && <div className="tt-msg-name">{m.from}</div>}
        <div className="tt-msg-line">
          {self && m.status !== 'sent' && (
            <span className="tt-msg-status">
              {m.status === 'failed' ? (
                <button
                  className="tt-failed-btn"
                  aria-label="发送失败，点击重发"
                  onClick={onRetry}
                  data-testid="failed-icon"
                >
                  <Icon name="failed" size={20} />
                </button>
              ) : (
                <span data-testid="sending-icon">
                  <Icon name="loading" size={16} />
                </span>
              )}
            </span>
          )}
          <div
            className={`tt-bubble${supported ? '' : ' tt-bubble-unsupported'}`}
            onPointerDown={(e) => {
              if (!hasMenu) return;
              const el = e.currentTarget;
              press.current = { x: e.clientX, y: e.clientY, t: setTimeout(() => open(el), LONG_PRESS_MS) };
            }}
            onPointerMove={(e) => {
              const p = press.current;
              if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) cancel();
            }}
            onPointerUp={cancel}
            onPointerCancel={cancel}
            onContextMenu={(e) => {
              e.preventDefault();
              if (hasMenu) open(e.currentTarget);
            }}
          >
            {supported ? m.body.text : '[暂不支持的消息]'}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 路由参数里的会话 ID 是 URL 编码的（单聊 ID 含 :，PRD-ui 3.2 节）；解码失败按不合法处理。 */
export function decodeParam(v: string | undefined): string {
  try {
    return decodeURIComponent(v ?? '');
  } catch {
    return '';
  }
}
