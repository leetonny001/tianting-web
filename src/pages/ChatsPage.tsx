import type { Conversation } from '@tianting/sdk';
import { attachmentSummary } from '../lib/media';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { ConnBanner } from '../components/ConnBanner';
import { Confirm } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { badgeText, TabBar } from '../components/TabBar';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useIm, useSelf } from '../im/ImProvider';
import {
  useConversations,
  useConversationsLoaded,
  useConversationsTruncated,
  useDisplayName,
  useFriends,
  useProfile,
  useProfiles,
} from '../im/hooks';
import { MESSAGE_DELETED, messageFor } from '../lib/errors';
import { useEscape } from '../lib/focus';
import { isWide } from '../lib/layout';
import { chatPath } from '../lib/routes';
import { errCode } from '../lib/social';
import { formatTime } from '../lib/time';
import { StartChatDialog } from './StartChatDialog';

// 返回会话列表时恢复滚动位置（AC-UI-01-5）。只在本页生命周期之外保存一个数字，不存任何会话内容。
let savedScrollTop = 0;

/** 会话列表（PRD-ui F-UI-04）。宽屏在列表栏，activeConvId 是主区打开的会话（高亮，规则 8）。 */
export function ChatsPage({ activeConvId }: { activeConvId?: string }) {
  const convs = useConversations();
  const loaded = useConversationsLoaded();
  const truncated = useConversationsTruncated();
  const friends = useFriends();
  const self = useSelf();
  // 单聊显示名：备注 > 服务端给的会话名（备注只在本机，PRD-social 5.5 节）。算好传给 memo 的会话项，避免每项都订阅。
  const remarks = useMemo(() => new Map(friends.filter((f) => f.remark).map((f) => [f.userId, f.remark])), [friends]);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const { drafts: draftStore, knownConfig } = useIm();
  const drafts = useSyncExternalStore(draftStore.subscribe, draftStore.snapshot);
  useEscape(menu, () => setMenu(false));
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const c = useClient();
  const toast = useToast();

  // 会话菜单（PRD-chat 第 13.3 节，F-UI-04 规则 9 随 C5 改写）：GET /v1/config 的 features.convSettings（IM_CONV_SETTINGS_ENABLED）
  // 打开才有；关闭时只是没有入口，已有的置顶、免打扰照常显示（P-46 ②）。
  const convMenuOn = !!knownConfig?.features?.convSettings;
  // 只记 convId，菜单文字按会话当前的状态（其他端改了也跟着变）；会话不在列表里了菜单就关掉。
  const [convMenu, setConvMenu] = useState<{ convId: string; x: number; y: number; opener: HTMLElement } | null>(null);
  // 删除确认框打开时焦点在会话项上（菜单关闭时还回去的），取消后焦点陷阱还给它。
  const [deleting, setDeleting] = useState<{ convId: string } | null>(null);
  const menuConv = convMenu ? convs.find((x) => x.convId === convMenu.convId) : undefined;
  const closeConvMenu = useCallback((refocus: boolean) => {
    setConvMenu((cur) => {
      if (refocus && cur?.opener.isConnected) cur.opener.focus();
      return null;
    });
  }, []);
  useEscape(convMenu !== null, () => closeConvMenu(true));
  const openConvMenu = useCallback(
    (convId: string, x: number, y: number, opener: HTMLElement) => setConvMenu({ convId, x, y, opener }),
    [],
  );

  async function pickConvAction(item: ConvMenuItem) {
    const conv = menuConv;
    const opener = convMenu?.opener;
    closeConvMenu(true);
    if (!conv || !opener) return;
    if (item === 'delete') {
      setDeleting({ convId: conv.convId });
      return;
    }
    // SDK 乐观更新，失败回滚并抛出，这里只提示，不自动重试（frontend-chat 第 56 条）：4220"最多置顶 20 个会话"，4290"操作过于频繁"。
    try {
      if (item === 'pin') await c.setConvPinned(conv.convId, !conv.pinned);
      else await c.setConvNotifyOff(conv.convId, !conv.notifyOff);
    } catch (e) {
      toast(messageFor(errCode(e), 'convSet'));
    }
  }

  async function confirmDelete() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    // 确认后才删：草稿由 convDeleted 清（ImProvider），失败消息、上传和排队的附件、图片缓存由 SDK 清（F-CVS-03 规则 7，第 59 条）。
    // 失败时 SDK 让会话恢复，草稿也还在。
    try {
      await c.deleteConv(target.convId);
      if (target.convId === activeConvId) navigate('/chats', { replace: true }); // 宽屏主区开着的就是它
    } catch (e) {
      toast(messageFor(errCode(e), 'convDelete'));
    }
  }

  // 菜单开着时会话被其他端删除：关掉（不只是不显示，免得会话重新出现时菜单又冒出来）。
  useEffect(
    () =>
      c.on('convDeleted', (id) => {
        setConvMenu((cur) => (cur?.convId === id ? null : cur));
        setDeleting((cur) => (cur?.convId === id ? null : cur));
      }),
    [c],
  );

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
            ref={plusRef}
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
            <button role="menuitem" onClick={() => navigate('/groups/new')} data-testid="plus-new-group">
              <Icon name="users" size={20} />
              发起群聊
            </button>
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
            {convs.map((x) => (
              <ConvItem
                key={x.convId}
                conv={x}
                remark={x.type === 'c2c' ? remarks.get(peerOf(x.convId, self)) : undefined}
                draft={drafts.get(x.convId)?.text}
                selected={x.convId === activeConvId}
                onMenu={convMenuOn ? openConvMenu : undefined}
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
      {dialog && <StartChatDialog onClose={() => setDialog(false)} returnFocus={plusRef} />}
      {convMenu && menuConv && convMenuOn && (
        <ConvMenu
          x={convMenu.x}
          y={convMenu.y}
          pinned={menuConv.pinned === true}
          notifyOff={menuConv.notifyOff === true}
          onPick={(item) => void pickConvAction(item)}
          onClose={() => closeConvMenu(true)}
        />
      )}
      {deleting && (
        <Confirm
          testId="conv-delete-dialog"
          text="删除后聊天记录不再显示，确定删除？"
          ok="删除"
          danger
          onOk={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
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
  if (m.deleted) return m.recalled ? <RecallSummary conv={c} /> : MESSAGE_DELETED;
  // 提示消息用服务端摘要（F-UI-40 规则 3），不加发送者前缀。
  if (m.type === 'text' || m.type === 'tip') return m.text ?? '';
  // 图片、文件只显示类型，不带文件名（F-FILE-02 规则 5、F-FILE-03 规则 5：LastMsg 本来就没有文件名）。
  return attachmentSummary(m.type) ?? '[暂不支持的消息]';
};

/** 最后一条被撤回（F-RCL-03 规则 4）：和聊天页同一张表（F-RCL-02 规则 1a），不加发送者前缀。 */
function RecallSummary({ conv }: { conv: Conversation }) {
  const c = useClient();
  const m = conv.lastMsg!;
  useProfiles([m.from, m.recalledBy ?? ''].filter(Boolean));
  return <>{c.recallText(conv.convId, m)}</>;
}

/** 群摘要的发送者前缀（PRD-ui F-UI-04 规则 5）：显示名未就绪时先显示 userId，就绪后替换。 */
function SenderPrefix({ userId }: { userId: string }) {
  return <>{useDisplayName(userId)}: </>;
}

function PeerOfficial({ id }: { id: string }) {
  return useProfile(id)?.official ? <OfficialTag /> : null;
}

const ConvItem = memo(function ConvItem({
  conv,
  remark,
  draft,
  selected,
  onMenu,
}: {
  conv: Conversation;
  remark?: string;
  draft?: string;
  selected: boolean;
  /** 会话菜单（C5）：features.convSettings 关闭时不传，长按、右键、菜单键都没有反应。 */
  onMenu?: (convId: string, x: number, y: number, opener: HTMLElement) => void;
}) {
  const self = useSelf();
  const press = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout> } | null>(null);
  // 长按打开了菜单：松手后的那次点击不进入聊天页。
  const pressed = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  useEffect(() => cancelPress, []);
  // 键盘打开时菜单贴着会话项左上（名字那一行下面），鼠标、长按打开时在按下的位置。
  const openAtItem = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onMenu?.(conv.convId, r.left + KEYBOARD_MENU_INSET, r.top + r.height / 2, el);
  };
  const notifyOff = conv.notifyOff === true;
  const mentioned = (conv.mentionUnread ?? 0) > 0;
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
    <Link
      className={`tt-conv${conv.pinned ? ' tt-conv-pinned' : ''}${selected ? ' tt-conv-selected' : ''}`}
      to={chatPath(conv.convId)}
      aria-current={selected ? 'page' : undefined}
      aria-haspopup={onMenu ? 'menu' : undefined}
      aria-keyshortcuts={onMenu ? 'Shift+F10' : undefined}
      data-testid="conv-item"
      data-conv-id={conv.convId}
      data-pinned={conv.pinned || undefined}
      data-notify-off={notifyOff || undefined}
      onClick={(e) => {
        if (!pressed.current) return;
        pressed.current = false;
        e.preventDefault();
      }}
      onKeyDown={
        onMenu &&
        ((e: KeyboardEvent<HTMLAnchorElement>) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            openAtItem(e.currentTarget);
          }
        })
      }
      onPointerDown={
        onMenu &&
        ((e) => {
          pressed.current = false;
          // 宽屏用右键（和消息菜单一样，F-UI-09 规则 1）；窄屏长按 500ms，移动超过 10px 取消
          if (isWide() || e.button !== 0) return;
          const el = e.currentTarget;
          const { clientX: x, clientY: y } = e;
          cancelPress();
          press.current = {
            x,
            y,
            t: setTimeout(() => {
              press.current = null;
              pressed.current = true;
              onMenu(conv.convId, x, y, el);
            }, LONG_PRESS_MS),
          };
        })
      }
      onPointerMove={
        onMenu &&
        ((e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) cancelPress();
        })
      }
      onPointerUp={onMenu && cancelPress}
      onPointerCancel={onMenu && cancelPress}
      onContextMenu={
        onMenu &&
        ((e) => {
          // 右键；手机浏览器长按也会发 contextmenu（同一个菜单）；键盘的菜单键发出的没有坐标，贴着会话项
          e.preventDefault();
          cancelPress();
          if (e.clientX === 0 && e.clientY === 0) openAtItem(e.currentTarget);
          else onMenu(conv.convId, e.clientX, e.clientY, e.currentTarget);
        })
      }
    >
      <span className="tt-conv-avatar">
        <Avatar id={group ? id : peerOf(conv.convId, self)} name={name} size={48} group={group} />
        {conv.unread > 0 &&
          (notifyOff ? (
            // 免打扰：小红点、没有数字（F-CVS-02 规则 5；有 @ 我也是小红点，frontend-chat 第 61 条）。数量在摘要的"[N 条]"里
            <span className="tt-dot" data-testid="conv-dot" />
          ) : (
            <span className="tt-badge" data-testid="conv-badge">
              {badgeText(conv.unread)}
            </span>
          ))}
      </span>
      <span className="tt-conv-main">
        <span className="tt-conv-row">
          <span className="tt-conv-name">{name}</span>
          {!group && <PeerOfficial id={peerOf(conv.convId, self)} />}
          {conv.lastMsg && <span className="tt-conv-time">{formatTime(conv.lastMsg.ts, now)}</span>}
        </span>
        <span className="tt-conv-row">
          <span className="tt-conv-summary">
            {/* 摘要前缀只显示一个，优先级"[有人@我]" > "[草稿]" > "[N 条]"（F-MEN-03 规则 2，PRD-ui F-UI-04 规则 5，frontend-chat 第 61 条） */}
            {mentioned && (
              <>
                <span className="tt-draft-tag" data-testid="mention-tag">
                  [有人@我]
                </span>{' '}
              </>
            )}
            {draft !== undefined && !mentioned ? (
              <>
                <span className="tt-draft-tag" data-testid="draft-tag">
                  [草稿]
                </span>{' '}
                {draft}
              </>
            ) : (
              <>
                {notifyOff && conv.unread > 0 && !mentioned && (
                  // 免打扰的未读条数（F-CVS-02 规则 5）：N 照实显示，不是角标，没有"99+"（第 61 条）
                  <span data-testid="unread-count-tag">[{conv.unread} 条] </span>
                )}
                {group && from && from !== self && conv.lastMsg?.type !== 'tip' && !conv.lastMsg?.deleted && (
                  <SenderPrefix userId={from} />
                )}
                {summaryText(conv)}
              </>
            )}
          </span>
          {notifyOff && (
            <span className="tt-conv-mute" role="img" aria-label="免打扰" data-testid="notify-off-icon">
              <Icon name="notifyOff" size={16} />
            </span>
          )}
        </span>
      </span>
    </Link>
  );
});

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const KEYBOARD_MENU_INSET = 72;
const MENU_EDGE = 4;

type ConvMenuItem = 'pin' | 'notify' | 'delete';

/**
 * 会话菜单（PRD-chat F-CVS-01、02、03，AC-CVS-01-6；键盘入口同 C4 的消息菜单，第 13.4 节）：
 * 打开时焦点在第一项，上下方向键、Home、End 移动，回车执行，Esc 关闭（焦点回到会话项），Tab 离开时关闭。
 * 菜单放在 (x, y)，放不下时往左、往上挪，不超出窗口。
 */
function ConvMenu({
  x,
  y,
  pinned,
  notifyOff,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  pinned: boolean;
  notifyOff: boolean;
  onPick: (item: ConvMenuItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(MENU_EDGE, Math.min(x, window.innerWidth - width - MENU_EDGE)),
      top: y + height + MENU_EDGE > window.innerHeight ? Math.max(MENU_EDGE, y - height) : y,
    });
  }, [x, y]);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Tab') onClose();
  };
  const items: [ConvMenuItem, string][] = [
    ['pin', pinned ? '取消置顶' : '置顶'],
    ['notify', notifyOff ? '取消免打扰' : '免打扰'],
    ['delete', '删除'],
  ];
  return (
    <div className="tt-menu-layer" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="tt-menu tt-conv-menu"
        role="menu"
        aria-label="会话操作"
        style={pos}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        data-testid="conv-menu"
      >
        {items.map(([item, text]) => (
          <button
            key={item}
            role="menuitem"
            tabIndex={-1}
            onClick={() => onPick(item)}
            data-testid={`conv-menu-${item}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function peerOf(convId: string, self: string): string {
  const [, a = '', b = ''] = convId.split(':');
  return a === self ? b : a;
}
