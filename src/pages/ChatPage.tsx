import {
  ConvIdError,
  IMError,
  NotConnectedError,
  parseConvIdStrict,
  quoteLabel,
  tipText,
  type Message,
  type QuoteView,
} from '@tianting/sdk';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { ConnBanner } from '../components/ConnBanner';
import { Confirm } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useIm, useSelf } from '../im/ImProvider';
import {
  useAttachments,
  useConnState,
  useConversations,
  useDisplayName,
  useFriends,
  useMessages,
  useMute,
  useProfile,
  useProfiles,
  useSendTips,
  useSnapshot,
  useSocialSettings,
} from '../im/hooks';
import { copyText } from '../lib/clipboard';
import { useEscape } from '../lib/focus';
import { isWide } from '../lib/layout';
import {
  GROUP_ALL_MUTED,
  MESSAGE_DELETED,
  MESSAGE_RECALLED,
  messageFor,
  mutedText,
  SOURCE_MISSING,
} from '../lib/errors';
import { noticePath } from '../lib/group';
import { chatPath } from '../lib/routes';
import { applyPath, userPath, type UserRouteState } from '../lib/social';
import { formatTime, needsDivider } from '../lib/time';
import { AttachButton, AttachmentError, FileBubble, ImageBubble, ImageViewer, useSendAttachments } from './Attach';
import { Composer, type ComposerHandle } from './Composer';

const BOTTOM_SLACK = 100; // 距底部不超过 100px 算"在底部"（F-MSG-06 规则 5）
const QUOTE_JUMP_MAX = 200; // 引用跳转：距已加载范围 200 条以内才翻页（F-QUO-02 规则 5，问题 20 按 seq 差算）
const HIGHLIGHT_MS = 2000;

/** 消息菜单项（PRD-ui F-UI-09 规则 3，PRD-chat 第 13.3 节）。举报随 C6。 */
type MenuItem = 'copy' | 'quote' | 'recall' | 'retry' | 'delete';
const MENU_TEXT: Record<MenuItem, string> = {
  copy: '复制',
  quote: '引用',
  recall: '撤回',
  retry: '重发',
  delete: '删除',
};

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
  const conv = convs.find((x) => x.convId === convId);
  const snapshot = useSnapshot(convId);
  const messages = useMessages(convId);
  // 群不在会话列表、也没有快照时先向服务端确认（G-UI-26）：确认前只显示加载状态，不显示输入框和"不在该群"。
  const [probe, setProbe] = useState<'idle' | 'loading' | 4033 | 4043>('idle');
  const [history, setHistory] = useState<'idle' | 'loading' | 'end' | 'error'>('idle');
  const [newCount, setNewCount] = useState(0);
  // 只记 clientMsgId，渲染时从最新列表取：打开着菜单时消息被删除，这里不能留着一份原文（F-UI-42）。
  const [retryId, setRetryId] = useState<string | null>(null);
  // items 是打开时算好的：菜单开着的时候过了撤回时限，"撤回"还在，点了按服务端 4097 提示（AC-RCL-01-8）。
  const [menuAt, setMenuAt] = useState<{
    id: string;
    top: number;
    below: boolean;
    left?: number;
    items: MenuItem[];
    opener: HTMLElement;
  } | null>(null);
  const closeMenu = useCallback(() => {
    setMenuAt((cur) => {
      // 键盘打开的菜单关掉后焦点回到气泡（AC-CHAT-90-9 的键盘走查）
      if (cur && (document.activeElement === document.body || document.activeElement?.closest('[role="menu"]'))) {
        cur.opener.focus();
      }
      return null;
    });
  }, []);
  useEscape(menuAt !== null, closeMenu);
  const liveMessage = (id: string | undefined) => {
    const m = id === undefined ? undefined : messages.find((x) => x.clientMsgId === id);
    return m && !m.deleted ? m : null;
  };
  const retry = liveMessage(retryId ?? undefined);
  const menuMessage = liveMessage(menuAt?.id);
  const menu = menuAt && menuMessage ? { ...menuAt, m: menuMessage } : null;
  const { drafts, knownConfig, attachments } = useIm();
  // 图片、文件入口（第 13.3 节）：服务端开关 features.files 打开、这次登录配了文件接口才有。
  const filesOn = !!knownConfig?.features?.files && !!attachments?.files;
  // 撤回、引用、@（C4）：GET /v1/config 的 features.msgActions（IM_MSG_ACTIONS_ENABLED）打开才有（PRD-ui F-UI-09 规则 4）。
  // sdk-ts 的 AccountConfig 还没有这个字段（问题 36，frontend-chat），这里按服务端的 JSON 读。
  const actionsOn = !!(knownConfig?.features as { msgActions?: boolean } | undefined)?.msgActions;
  const composer = useRef<ComposerHandle>(null);
  const [viewer, setViewer] = useState<{ fileId: string; id: string } | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [jump, setJump] = useState<number | null>(null);
  // "有人@我"（F-MEN-03 规则 3）：打开会话时记下第一条提及的 seq（读到最新后服务端就清零了）。
  const [mentionAt, setMentionAt] = useState<number | null>(null);
  const mentionTaken = useRef(false);
  const [dragging, setDragging] = useState(false);
  const { send: sendFiles, dialog: fileDialog } = useSendAttachments(c, convId, () => {
    atBottom.current = true;
  });
  const mute = useMute(convId);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevLen = useRef(0);
  const anchor = useRef<number | null>(null); // 加载历史前的 scrollHeight，用来保持可视位置不跳动
  const connected = useConnState() === 'connected';

  // 只有聊天页实际可见时才是当前会话（F-UI-06 规则 8）；离开时设为 null。
  useEffect(() => {
    c.setActiveConversation(convId);
    return () => c.setActiveConversation(null);
  }, [c, convId]);

  // 打开本地没有的会话：向服务端要最新一页（F-UI-33 规则 1、G-UI-26）。
  const unknown = !conv && !snapshot && messages.length === 0;
  useEffect(() => {
    if (!unknown || !connected) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 发起请求前进入"确认中"，和请求是同一个外部同步过程
    setProbe('loading');
    c.loadHistory(convId)
      .then(() => live && setProbe('idle'))
      .catch((e: unknown) => {
        if (!live) return;
        const code = e instanceof IMError ? e.code : 0;
        if (code === 4033 || code === 4043) setProbe(code);
        else if (code === 4032) {
          toast('会话不存在');
          navigate('/chats', { replace: true });
        } else setProbe('idle');
      });
    return () => {
      live = false;
    };
    // 只在打开会话或连上之后确认一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, connected]);

  // 不能发送的原因（F-UI-33 规则 2～4）：快照按 reason 映射（不认识的值按"被移出"），服务端确认 4033 / 4043。
  const blocked: { tip: string; bar: string } | null = snapshot
    ? snapshot.reason === 'dissolved'
      ? { tip: '群聊已解散', bar: '群聊已解散' }
      : snapshot.reason === 'left'
        ? { tip: '你已退出该群聊', bar: '你已退出该群聊' }
        : { tip: '你已不在该群', bar: '你已不在该群，无法发送消息' }
    : probe === 4033
      ? { tip: '你已不在该群', bar: '你已不在该群，无法发送消息' }
      : probe === 4043
        ? { tip: '群聊不存在或已解散', bar: '群聊不存在或已解散' }
        : null;
  const probing = type === 'group' && unknown && probe !== 4033 && probe !== 4043;

  // 不能发送时输入内容不保留（F-UI-33 规则 5）。子组件 Composer 卸载时存的草稿先于这里运行；禁言不走这条，内容保留。
  const isBlocked = blocked !== null;
  useEffect(() => {
    if (isBlocked) drafts.remove(convId);
  }, [isBlocked, drafts, convId]);

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
  // 跳转（引用、"有人@我"）的滚动在下一个 effect，排在这个后面。
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

  // 跳到某条消息：滚到中间并高亮（AC-QUO-02-3、AC-MEN-03-6）。
  useLayoutEffect(() => {
    if (jump === null) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-seq="${jump}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center' });
    setHighlight(jump);
    setJump(null);
  }, [jump, messages]);
  useEffect(() => {
    if (highlight === null) return;
    const t = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlight]);

  /**
   * 跳到 seq（F-QUO-02 规则 5）：已加载的直接跳；更早的，距已加载范围 limit 条以内向上翻页再跳（已加载范围保持连续），
   * 更远的提示"消息太早，请翻页查看"；拉不到提示"消息不存在"。limit 为 Infinity 时一页页翻到为止（"有人@我"）。
   */
  async function jumpTo(seq: number | undefined, limit: number) {
    if (seq === undefined) return toast('消息不存在');
    const has = (list: Message[]) => list.some((m) => m.seq === seq);
    if (has(c.messages(convId))) return setJump(seq);
    const oldest = () => Math.min(...c.messages(convId).map((m) => m.seq ?? Infinity));
    if (seq > oldest()) return toast('消息不存在'); // 在已加载范围里却没有（不该发生）
    if (oldest() - seq > limit) return toast('消息太早，请翻页查看');
    const el = scroller.current;
    try {
      while (!has(c.messages(convId))) {
        const gap = oldest() - seq;
        if (!(gap > 0)) break;
        anchor.current = el ? el.scrollHeight - el.scrollTop : null;
        setHistory('loading');
        const more = await c.loadHistory(convId, Math.min(QUOTE_JUMP_MAX, gap));
        setHistory(more ? 'idle' : 'end');
        if (!more) break;
      }
    } catch {
      setHistory('error');
      anchor.current = null;
    }
    if (has(c.messages(convId))) setJump(seq);
    else toast('消息不存在');
  }

  // 记下第一条提及（会话列表到了以后只取一次）。
  useEffect(() => {
    if (mentionTaken.current || !conv) return;
    mentionTaken.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 会话列表是 SDK 事件带来的，只在第一次到达时取一次
    if ((conv.mentionUnread ?? 0) > 0 && conv.firstMentionSeq !== undefined) setMentionAt(conv.firstMentionSeq);
  }, [conv]);
  // 那条在视口里了就不再显示按钮。
  const mentionInView = useCallback(() => {
    const list = scroller.current;
    if (mentionAt === null || !list) return false;
    const el = list.querySelector<HTMLElement>(`[data-seq="${mentionAt}"]`);
    if (!el) return false;
    const a = el.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    return a.height > 0 && a.bottom > b.top && a.top < b.bottom;
  }, [mentionAt]);
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 量过 DOM 才知道那条在不在视口里
    if (mentionInView()) setMentionAt(null);
  }, [messages, mentionInView]);

  // 发送失败的提示（4293 "@所有人次数已用完"、4040 引用不可用等）由 App 统一弹一次（F-UI-08 规则 3），这里不重复。

  // 正在全屏看的图片被撤回、删除：退出全屏并提示（AC-RCL-03-8）。
  const viewing = viewer ? messages.find((x) => x.clientMsgId === viewer.id) : undefined;
  useEffect(() => {
    if (!viewer || !viewing?.deleted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 消息状态是外部来的（SDK 事件），跟着关掉全屏
    setViewer(null);
    toast(viewing.recalled ? MESSAGE_RECALLED : MESSAGE_DELETED);
  }, [viewer, viewing, toast]);

  /** 菜单项（F-UI-09 规则 3～5）：C4 开关关时只有"复制"和失败消息的两项；开时按 SDK 的 messageActions。 */
  const menuItems = (m: Message): MenuItem[] => {
    const out: MenuItem[] = actionsOn
      ? c.messageActions(m, conv?.myRole)
      : !m.deleted && m.type === 'text'
        ? ['copy']
        : [];
    if (m.status === 'failed' && m.error !== 'sourceMissing') out.push('retry');
    if (m.status === 'failed') out.push('delete');
    return out;
  };

  async function act(item: MenuItem, m: Message) {
    closeMenu();
    if (item === 'copy') {
      const ok = await copyText(m.body.text ?? '');
      toast(ok ? '已复制' : '复制失败，请长按文字手动复制');
    } else if (item === 'retry') {
      c.retry(convId, m.clientMsgId); // 菜单里的"重发"不再二次确认（F-UI-09 规则 3）
    } else if (item === 'delete') {
      removeFailed(m); // 只从本地移除，不影响服务端（F-UI-09 规则 3）
    } else if (item === 'quote') {
      composer.current?.quote(m.msgId!);
    } else if (item === 'recall' && m.msgId) {
      try {
        await c.recall(convId, m.msgId);
      } catch (e) {
        // 4097 按 windowSeconds 选时限；4030 "你没有权限撤回这条消息"（AC-RCL-02-5）；不自动重试（问题 26）。
        const windowSeconds = e instanceof IMError ? (e.details?.windowSeconds as number | undefined) : undefined;
        toast(messageFor(e instanceof IMError ? e.code : 5000, 'recall', { windowSeconds }));
      }
    }
  }

  // 标题（F-UI-06 规则 2）：群聊"群名（N）"，群名省略、（N）始终完整；成员数缺失、快照状态只显示群名；
  // 服务端确认不在群里时显示"群聊"。临时单聊（还没有会话）显示对方账号。
  useFriends(); // 备注变化时刷新标题
  const peerProfile = useProfile(type === 'c2c' ? to : self);
  const remarkOrNickname = c.displayName(to);
  const name =
    type === 'c2c' && remarkOrNickname !== to
      ? remarkOrNickname // 单聊：备注 > 昵称（会话名是服务端给的昵称，备注只在本机）
      : (conv?.name ?? snapshot?.name ?? (type === 'group' && probe !== 'idle' && probe !== 'loading' ? '群聊' : to));
  const count = type === 'group' && conv?.memberCount !== undefined ? `（${conv.memberCount}）` : '';
  const tips = useSendTips(convId);
  const strangerMsgLimit = useSocialSettings().strangerMsgLimit;
  const rows = useMemo(() => withDividers(messages), [messages]);
  const tipFor = useMemo(() => permissionTips(messages, tips), [messages, tips]);
  // 资料卡的申请来源（F-UI-14 规则 7）：从群进入为 group，从单聊进入为 conv。
  const userState: UserRouteState = type === 'group' ? { source: 'group', sourceRef: to } : { source: 'conv' };

  const canSendFiles = filesOn && !probing && !blocked && !mute;
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  // 删除失败的附件：没完成的上传顺便取消（DELETE，F-FILE-01 规则 6a）；文本照旧只删本地。
  const removeFailed = (m: Message) =>
    m.type === 'image' || m.type === 'file'
      ? c.cancelUpload(convId, m.clientMsgId)
      : c.removeFailed(convId, m.clientMsgId);
  return (
    <div
      className={`tt-page tt-chat${dragging ? ' tt-chat-drop' : ''}`}
      onDragOver={(e) => {
        if (!canSendFiles || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!canSendFiles || !hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        sendFiles([...e.dataTransfer.files], 'auto');
      }}
      data-testid="chat-page"
    >
      <TopBar
        title={
          <span className="tt-title-row" data-testid="chat-title">
            <span className="tt-ellipsis">{name}</span>
            {type === 'c2c' && peerProfile?.official && <OfficialTag />}
            {count && <span className="tt-title-count">{count}</span>}
          </span>
        }
        back="/chats"
        primary
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
          if (mentionAt !== null && mentionInView()) setMentionAt(null);
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
          ) : r.m.deleted ? (
            r.m.recalled ? (
              <RecallRow key={r.m.clientMsgId} m={r.m} convId={convId} highlight={highlight === r.m.seq} />
            ) : (
              <div
                className={`tt-tip${highlight !== null && highlight === r.m.seq ? ' tt-highlight' : ''}`}
                key={r.m.clientMsgId}
                data-testid="msg-deleted"
                data-seq={r.m.seq}
                onContextMenu={noBrowserMenu}
              >
                {MESSAGE_DELETED}
              </div>
            )
          ) : r.m.type === 'tip' ? (
            <TipRow key={r.m.clientMsgId} m={r.m} convId={convId} />
          ) : (
            <Fragment key={r.m.clientMsgId}>
              <Bubble
                m={r.m}
                self={r.m.from === self}
                showName={type === 'group' && r.m.from !== self}
                userState={userState}
                convId={convId}
                highlight={highlight !== null && highlight === r.m.seq}
                mentioned={r.m.from !== self && mentionsMe(r.m, self)}
                hasMenu={menuItems(r.m).length > 0}
                onOpenImage={(fileId) => setViewer({ fileId, id: r.m.clientMsgId })}
                onCancel={() => c.cancelUpload(convId, r.m.clientMsgId)}
                onRetry={() => setRetryId(r.m.clientMsgId)}
                onQuote={(q) => void jumpTo(q.seq, QUOTE_JUMP_MAX)}
                onMenu={(el, top, below, left) => {
                  const items = menuItems(r.m);
                  if (items.length > 0) setMenuAt({ id: r.m.clientMsgId, top, below, left, items, opener: el });
                }}
                menuHeight={() => menuItems(r.m).length * MENU_ITEM_HEIGHT + MENU_PADDING}
              />
              {tipFor.get(r.m.clientMsgId) !== undefined && (
                <div className="tt-permission-tip" data-testid="permission-tip">
                  {messageFor(tipFor.get(r.m.clientMsgId)!, 'send', { strangerMsgLimit })}
                  {tipFor.get(r.m.clientMsgId) === 4035 && (
                    <>
                      {' '}
                      <Link
                        className="tt-link"
                        to={applyPath(to)}
                        state={{ source: 'conv' } satisfies UserRouteState}
                        data-testid="permission-apply"
                      >
                        发送好友申请
                      </Link>
                    </>
                  )}
                </div>
              )}
            </Fragment>
          ),
        )}
        {probing && (
          <div className="tt-history" data-testid="chat-probing">
            加载中…
          </div>
        )}
        {blocked && (
          <div className="tt-divider" data-testid="chat-blocked-tip">
            {blocked.tip}
          </div>
        )}
      </div>
      {mentionAt !== null && (
        <button
          className="tt-new-pill tt-mention-pill"
          onClick={() => {
            const seq = mentionAt;
            setMentionAt(null); // 点过就消失（AC-MEN-03-6）
            void jumpTo(seq, Infinity);
          }}
          data-testid="mention-jump"
        >
          有人@我
        </button>
      )}
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
      {probing ? null : blocked ? (
        <div className="tt-composer-disabled" data-testid="composer-disabled">
          {blocked.bar}
        </div>
      ) : mute ? (
        <div className="tt-composer-disabled" data-testid="composer-disabled">
          {mute.scope === 'groupAll' ? GROUP_ALL_MUTED : mutedText(mute.mutedUntil)}
        </div>
      ) : (
        <Composer
          ref={composer}
          convId={convId}
          attach={canSendFiles ? <AttachButton onPick={sendFiles} /> : undefined}
          onPasteFiles={canSendFiles ? (files) => sendFiles(files, 'auto') : undefined}
          group={type === 'group' && actionsOn ? { groupId: to, myRole: conv?.myRole } : undefined}
          onSend={(text, extras) => {
            try {
              const r = c.send(convId, text, actionsOn ? extras : undefined);
              if (r.ok) {
                atBottom.current = true;
                return true;
              }
              return false;
            } catch (e) {
              // 第一次连接成功之前 SDK 还不知道自己是谁，发不了也排不了队：输入框内容留着，让用户再按一次。
              if (!(e instanceof NotConnectedError)) throw e;
              toast('正在连接，请稍后再发送');
              return false;
            }
          }}
        />
      )}
      {retry && retry.error === 'sourceMissing' ? (
        // 原文件已经不在（F-FILE-07 规则 4）：不能重发，只能删除。
        <Confirm
          text={SOURCE_MISSING}
          ok="删除"
          danger
          testId="source-missing-dialog"
          onCancel={() => setRetryId(null)}
          onOk={() => {
            removeFailed(retry);
            setRetryId(null);
          }}
        />
      ) : (
        retry && (
          <Confirm
            text="重发该消息？"
            ok="重发"
            testId="retry-dialog"
            onCancel={() => setRetryId(null)}
            onOk={() => {
              c.retry(convId, retry.clientMsgId);
              setRetryId(null);
            }}
          />
        )
      )}
      {fileDialog}
      {viewer && <ImageViewer fileId={viewer.fileId} onClose={() => setViewer(null)} />}
      {menu && (
        <BubbleMenu
          top={menu.top}
          left={menu.left}
          below={menu.below}
          items={menu.items}
          onPick={(item) => void act(item, menu.m)}
          onClose={closeMenu}
        />
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

/**
 * 私聊权限提示条（F-UI-31）：跟在失败消息下面；相邻的提示内容相同时只保留最后一条。
 * 重发成功后消息不再是失败状态，提示条随之消失。
 */
function permissionTips(ms: Message[], tips: ReadonlyMap<string, number> | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!tips) return out;
  let lastId = '';
  let lastCode = 0;
  for (const m of ms) {
    const code = m.status === 'failed' ? tips.get(m.clientMsgId) : undefined;
    if (code === undefined) continue;
    if (lastCode === code) out.delete(lastId);
    out.set(m.clientMsgId, code);
    lastId = m.clientMsgId;
    lastCode = code;
  }
  return out;
}

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;
const MENU_ITEM_HEIGHT = 44;
const MENU_PADDING = 10; // 上下内边距 + 边框
const MENU_HALF_WIDTH = 70;
/** 没有菜单项的消息（提示消息、已删除、已撤回）也不出现浏览器菜单（F-UI-09 规则 5）。 */
const noBrowserMenu = (e: MouseEvent) => e.preventDefault();

/** 被 @ 的是我（含 @ 所有人）：气泡整体用样式提示（F-MEN-01 规则 4）。 */
function mentionsMe(m: Message, self: string): boolean {
  const x = m.body.mentions;
  return !!x && (x.all === true || (x.userIds ?? []).includes(self));
}

/**
 * 消息菜单（F-UI-09，PRD-chat 第 13.4 节键盘入口）：打开时焦点落在第一项，上下方向键、Home、End 移动，
 * 回车执行，Esc 关闭（焦点回到气泡），Tab 离开时关闭。
 */
function BubbleMenu({
  top,
  left,
  below,
  items,
  onPick,
  onClose,
}: {
  top: number;
  left?: number;
  below: boolean;
  items: MenuItem[];
  onPick: (item: MenuItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
  return (
    <div className="tt-menu-layer" onClick={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        className="tt-menu tt-bubble-menu"
        role="menu"
        aria-label="消息操作"
        style={{ top, left }}
        data-below={below || undefined}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        data-testid="bubble-menu"
      >
        {items.map((item) => (
          <button key={item} role="menuitem" tabIndex={-1} onClick={() => onPick(item)} data-testid={`menu-${item}`}>
            {MENU_TEXT[item]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 撤回提示行（F-RCL-02 规则 1a 的表，F-RCL-03 规则 6）：居中小字，没有菜单；显示名到了再替换。 */
function RecallRow({ m, convId, highlight }: { m: Message; convId: string; highlight: boolean }) {
  const c = useClient();
  useProfiles([m.from, m.recalledBy ?? ''].filter(Boolean));
  return (
    <div
      className={`tt-tip${highlight ? ' tt-highlight' : ''}`}
      data-testid="msg-recalled"
      data-seq={m.seq}
      onContextMenu={noBrowserMenu}
    >
      {c.recallText(convId, m)}
    </div>
  );
}

/**
 * 气泡顶部的引用（F-QUO-02 规则 3）：四种状态的文字来自 SDK 的 quoteLabel，正常时前面加原发送者的显示名；
 * 按纯文本渲染（AC-QUO-02-5）。点击跳到原消息（规则 5）。
 */
function QuoteBlock({ q, onOpen }: { q: QuoteView; onOpen: () => void }) {
  const self = useSelf();
  const name = useDisplayName(q.from || self);
  const label = quoteLabel(q);
  const text = q.state === 'normal' && q.from ? `${name}: ${label}` : label;
  return (
    <button
      type="button"
      className="tt-quote"
      data-state={q.state}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="msg-quote"
    >
      {text}
    </button>
  );
}

/**
 * 消息气泡（F-UI-07、F-UI-08）。长按 500ms（移动超过 10px 取消）或右键打开菜单（F-UI-09）；
 * 有菜单的气泡可以 Tab 到，菜单键或 Shift+F10 打开（PRD-chat 第 13.4 节，AC-CHAT-90-9）。
 */
function Bubble({
  m,
  self,
  showName,
  userState,
  convId,
  highlight,
  mentioned,
  hasMenu,
  onOpenImage,
  onCancel,
  onRetry,
  onQuote,
  onMenu,
  menuHeight,
}: {
  m: Message;
  self: boolean;
  showName: boolean;
  userState: UserRouteState;
  convId: string;
  highlight: boolean;
  mentioned: boolean;
  hasMenu: boolean;
  onOpenImage: (fileId: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onQuote: (q: QuoteView) => void;
  onMenu: (el: HTMLElement, top: number, below: boolean, left?: number) => void;
  menuHeight: () => number;
}) {
  const press = useRef<{ x: number; y: number; t: ReturnType<typeof setTimeout> } | null>(null);
  const navigate = useNavigate();
  const senderName = useDisplayName(m.from);
  const sender = useProfile(m.from);
  const attachment = m.type === 'image' || m.type === 'file';
  const supported = m.type === 'text';
  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const list = el.closest('.tt-messages')?.getBoundingClientRect();
    const height = menuHeight();
    const below = !!list && r.top - list.top < height + 4;
    const top = below ? Math.min(r.bottom + 4, window.innerHeight - height - 4) : r.top - height - 4;
    // 窄屏容器不宽，菜单水平居中；宽屏跟着气泡（transform 让 left 指菜单中心）。
    const left = isWide()
      ? Math.min(Math.max(r.left + r.width / 2, MENU_HALF_WIDTH), window.innerWidth - MENU_HALF_WIDTH)
      : undefined;
    onMenu(el, top, below, left);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  const quote = m.body.quote;
  return (
    <div
      className={`tt-msg${self ? ' tt-msg-self' : ''}${highlight ? ' tt-highlight' : ''}`}
      data-testid="message"
      data-status={m.status}
      data-client-msg-id={m.clientMsgId}
      data-seq={m.seq}
      data-mentioned={mentioned || undefined}
    >
      <button
        className="tt-msg-avatar-btn"
        aria-label={`查看 ${senderName} 的资料`}
        onClick={() => navigate(userPath(m.from), { state: userState })}
        data-testid="msg-avatar"
      >
        {self ? (
          <SelfAvatar id={m.from} name={senderName} src={sender?.avatar} />
        ) : (
          <Avatar id={m.from} name={senderName} size={40} src={sender?.avatar} />
        )}
      </button>
      <div className="tt-msg-body">
        {showName && <div className="tt-msg-name">{senderName}</div>}
        <div className="tt-msg-line">
          {self && m.status !== 'sent' && (m.status === 'failed' || !attachment) && (
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
            className={`tt-bubble${attachment ? ' tt-bubble-att' : supported ? '' : ' tt-bubble-unsupported'}${mentioned ? ' tt-bubble-mention' : ''}`}
            tabIndex={hasMenu ? 0 : undefined}
            aria-keyshortcuts={hasMenu ? 'Shift+F10' : undefined}
            onKeyDown={(e) => {
              if (!hasMenu || e.target !== e.currentTarget) return;
              if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                e.preventDefault();
                open(e.currentTarget);
              }
            }}
            onPointerDown={(e) => {
              if (!hasMenu || isWide()) return; // 宽屏用右键（F-UI-09 规则 1），按住鼠标是选择文字
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
            data-testid="bubble"
          >
            {quote && <QuoteBlock q={quote} onOpen={() => onQuote(quote)} />}
            {supported ? (
              m.body.text
            ) : m.type === 'image' ? (
              <ImageBubble m={m} onCancel={onCancel} onOpen={onOpenImage} />
            ) : m.type === 'file' ? (
              <FileBubble m={m} self={self} convId={convId} onCancel={onCancel} />
            ) : (
              '[暂不支持的消息]' // 不认识的类型（F-FILE-02 规则 8 的老版本说法，留给以后的新类型）
            )}
          </div>
        </div>
        <AttachmentError m={m} />
      </div>
    </div>
  );
}

/** 群提示消息（PRD-ui F-UI-40）：居中小字，没有头像、气泡和菜单；文案用本地显示名渲染。 */
function TipRow({ m, convId }: { m: Message; convId: string }) {
  const c = useClient();
  const self = useSelf();
  const tip = m.body.tip;
  useProfiles(tip ? [tip.actor, ...tip.targets].filter(Boolean) : []);
  const text = tip ? tipText(tip, self, (u) => c.displayName(u)) : '[群通知]';
  if (tip?.kind === 'noticeUpdated') {
    return (
      <Link
        className="tt-tip tt-tip-link"
        to={noticePath(convId)}
        data-testid="tip"
        data-kind={tip.kind}
        onContextMenu={noBrowserMenu}
      >
        {text}
      </Link>
    );
  }
  return (
    <div className="tt-tip" data-testid="tip" data-kind={tip?.kind} onContextMenu={noBrowserMenu}>
      {text}
    </div>
  );
}

/** 自己的头像：刚换过的用这次登录里上传的那张（F-ACC-06，问题 H13）。 */
function SelfAvatar({ id, name, src }: { id: string; name: string; src?: string }) {
  const att = useAttachments();
  return <Avatar id={id} name={name} size={40} src={src} local={att?.ownAvatar} />;
}

/** 路由参数里的会话 ID 是 URL 编码的（单聊 ID 含 :，PRD-ui 3.2 节）；解码失败按不合法处理。 */
export function decodeParam(v: string | undefined): string {
  try {
    return decodeURIComponent(v ?? '');
  } catch {
    return '';
  }
}
