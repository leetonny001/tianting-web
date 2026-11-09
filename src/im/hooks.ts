import {
  IMError,
  type BlockedUser,
  type ConnState,
  type Conversation,
  type ConversationSnapshot,
  type Friend,
  type FriendRequest,
  type GroupInfo,
  type GroupMemberInfo,
  type IMClient,
  type Message,
  type MuteInfo,
  type SocialSettings,
  type UserProfile,
} from '@tianting/sdk';
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { useClient, useIm } from './ImProvider';
import type { NoticeSnapshot } from './notices';

type Listener = () => void;

/**
 * 把 SDK 事件适配成 React 的外部 store：缓存事件里带来的快照，读取时返回同一个引用，
 * 只有 SDK 发出新快照时引用才变（useSyncExternalStore 要求 getSnapshot 在没有变化时返回相同的值）。
 */
class ClientStore {
  convs: Conversation[];
  convsLoaded = false;
  truncated = false;
  /** 被移出群的快照（G-UI-21），convRemoved / conversations 事件时刷新。 */
  snapshots = new Map<string, ConversationSnapshot | undefined>();
  state: ConnState;
  banner = false;
  totalUnread: number;
  pendingCount: number;
  friends: Friend[];
  requests: { items: FriendRequest[]; unseen: number };
  blocks: BlockedUser[];
  settings: SocialSettings;
  socialLoaded: boolean;
  official: boolean;
  /** 私聊权限提示条的来源（F-UI-31）：convId → clientMsgId → 错误码。只在内存，刷新后消失。 */
  sendTips = new Map<string, Map<string, number>>();
  tipsVersion = 0;
  /** 禁言状态的版本号：muteChanged 时加一，取值用 client.muteState（按服务端时间判断）。 */
  muteVersion = 0;
  private msgs = new Map<string, Message[]>();
  private listeners = new Set<Listener>();

  constructor(private c: IMClient) {
    this.convs = c.conversations();
    this.state = c.state;
    this.totalUnread = c.totalUnread();
    this.pendingCount = c.pendingCount();
    this.friends = c.friends();
    this.requests = c.friendRequests();
    this.blocks = c.blocks();
    this.settings = c.socialSettings();
    this.socialLoaded = c.socialLoaded();
    this.official = c.isOfficial();
    const set = (fn: () => void) => () => {
      fn();
      this.listeners.forEach((l) => l());
    };
    c.on(
      'conversations',
      set(() => {
        this.convs = c.conversations();
        this.truncated = c.truncated();
        this.snapshots.clear();
        // disconnect() 会清空 SDK 的数据（退出登录、演示面板的"模拟断网"），缓存的消息列表一起丢弃，重连后重新拉取。
        if (c.state === 'disconnected' && this.convs.length === 0) this.msgs.clear();
        // 连上之后 SDK 先拉 convs 再发事件；连接前（重置时）发的空列表不算"已加载"（PRD-ui F-UI-20 骨架屏）。
        if (c.state === 'connected' && !this.convsLoaded) {
          this.convsLoaded = true;
          performance.mark('tt-convs-loaded'); // 性能检查（AC-UI-90-6）：convs 到达
        }
      }),
    );
    c.on('messages', (id, list) =>
      set(() => {
        this.msgs.set(id, list);
      })(),
    );
    c.on('convRemoved', () => set(() => this.snapshots.clear())());
    c.on('state', (s) => set(() => (this.state = s))());
    c.on('banner', (b) => set(() => (this.banner = b))());
    c.on('totalUnread', (n) => set(() => (this.totalUnread = n))());
    c.on('pendingCount', (n) => set(() => (this.pendingCount = n))());
    c.on('friends', (list) =>
      set(() => {
        this.friends = list;
        this.socialLoaded = c.socialLoaded();
        this.official = c.isOfficial();
      })(),
    );
    c.on('friendRequests', (r) => set(() => (this.requests = r))());
    c.on('blocks', (list) => set(() => (this.blocks = list))());
    c.on('socialSettings', (v) => set(() => (this.settings = v))());
    c.on(
      'muteChanged',
      set(() => this.muteVersion++),
    );
    c.on('sendFailed', (convId, id, err) => {
      if (err !== 4035 && err !== 4036 && err !== 4137) return;
      set(() => {
        const m = this.sendTips.get(convId) ?? new Map<string, number>();
        m.set(id, err);
        this.sendTips.set(convId, m);
        this.tipsVersion++;
      })();
    });
  }

  messages(convId: string): Message[] {
    let list = this.msgs.get(convId);
    if (!list) {
      list = this.c.messages(convId);
      this.msgs.set(convId, list);
    }
    return list;
  }

  snapshot(convId: string): ConversationSnapshot | undefined {
    if (!this.snapshots.has(convId)) this.snapshots.set(convId, this.c.conversationSnapshot(convId));
    return this.snapshots.get(convId);
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}

const stores = new WeakMap<IMClient, ClientStore>();

function storeOf(c: IMClient): ClientStore {
  let s = stores.get(c);
  if (!s) {
    s = new ClientStore(c);
    stores.set(c, s);
  }
  return s;
}

function useStore<T>(read: (s: ClientStore) => T): T {
  const s = storeOf(useClient());
  return useSyncExternalStore(s.subscribe, () => read(s));
}

export const useConversations = () => useStore((s) => s.convs);
/** 会话列表是否已经从服务端拿到过（首次加载期间显示骨架屏）。 */
export const useConversationsLoaded = () => useStore((s) => s.convsLoaded);
/** 会话列表是否被截断（只返回最近 500 个，C-03）。 */
export const useConversationsTruncated = () => useStore((s) => s.truncated);
/** 被移出群后保留的快照；没有被移出时为 undefined。 */
export const useSnapshot = (convId: string) => useStore((s) => s.snapshot(convId));
export const useMessages = (convId: string) => useStore((s) => s.messages(convId));
export const useConnState = () => useStore((s) => s.state);
export const useBanner = () => useStore((s) => s.banner);
export const useTotalUnread = () => useStore((s) => s.totalUnread);
export const usePendingCount = () => useStore((s) => s.pendingCount);
export const useFriends = () => useStore((s) => s.friends);
export const useFriendRequests = () => useStore((s) => s.requests);
export const useBlocks = () => useStore((s) => s.blocks);
export const useSocialSettings = () => useStore((s) => s.settings);
/** 第一轮 socialSync 是否结束（之前通讯录显示骨架屏，F-UI-20）。 */
export const useSocialLoaded = () => useStore((s) => s.socialLoaded);
export const useOfficial = () => useStore((s) => s.official);
export const useTipsVersion = () => useStore((s) => s.tipsVersion);

/** 某条失败消息的权限错误码（4035 / 4036 / 4137）。 */
export function useSendTips(convId: string): ReadonlyMap<string, number> | undefined {
  useTipsVersion();
  return storeOf(useClient()).sendTips.get(convId);
}

/** 这个会话当前的禁言；没有被禁言时为 null（PRD-ui F-UI-41）。 */
export function useMute(convId: string): MuteInfo | null {
  useStore((s) => s.muteVersion);
  return useClient().muteState(convId);
}

/** 本地关系（social 状态变化时重新计算）。 */
export function useRelation(userId: string) {
  const c = useClient();
  useFriends();
  useFriendRequests();
  useBlocks();
  return c.relationOf(userId);
}

/**
 * 用户资料（F-SOC-10）：先给缓存里的，再用 getUsers 刷新（同一轮渲染的多个调用由 SDK 合并成一批）。
 * 不可见、不存在都是 undefined。连接恢复后重查。
 */
export function useProfile(userId: string): UserProfile | undefined {
  const c = useClient();
  const connected = useStore((s) => s.state === 'connected');
  const [loaded, setLoaded] = useState<UserProfile | undefined>(undefined);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    c.getUsers([userId])
      .then((list) => {
        if (live) setLoaded(list[0]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [c, userId, connected]);
  // 自己改了昵称（F-ACC-06）：不等下一次 getUsers，立即显示。
  useEffect(
    () =>
      c.on('profileChanged', (id) => {
        if (id === userId) setLoaded(c.profileOf(userId));
      }),
    [c, userId],
  );
  return loaded?.userId === userId ? loaded : c.profileOf(userId);
}

/** 确保这些人的资料进了缓存（渲染提示消息用，一次多个人）；资料到达后重新渲染，取名字用 c.displayName。 */
export function useProfiles(ids: readonly string[]): void {
  const c = useClient();
  const connected = useStore((s) => s.state === 'connected');
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useFriends();
  const key = ids.join(',');
  useEffect(() => {
    if (!connected || !key) return;
    let live = true;
    c.getUsers(key.split(','))
      .then(() => {
        if (live) bump();
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [c, key, connected]);
}

/**
 * 群资料（PRD-ui F-UI-36 规则 1）：进入和重连时查一次；之后由 groupChanged 带来（SDK 已查好，不重复请求）。
 * gone 是 4033 / 4043：已不在群里或群不存在。
 */
export function useGroupInfo(groupId: string) {
  const c = useClient();
  const connected = useStore((s) => s.state === 'connected');
  const [info, setInfo] = useState<GroupInfo | null>(null);
  const [gone, setGone] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      setInfo(await c.getGroupInfo(groupId));
    } catch (e) {
      const code = e instanceof IMError ? e.code : 0;
      if (code === 4033 || code === 4043) setGone(code);
    }
  }, [c, groupId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 异步请求的结果，不是同步 setState
    if (connected) void refresh();
  }, [connected, refresh]);
  useEffect(() => c.on('groupChanged', (g, next) => g === groupId && setInfo(next)), [c, groupId]);
  useEffect(() => c.on('convRemoved', (id) => id === `group:${groupId}` && setGone(4033)), [c, groupId]);
  return { info, gone, refresh };
}

function mergeMembers(list: GroupMemberInfo[], page: GroupMemberInfo[]): GroupMemberInfo[] {
  const seen = new Set(list.map((m) => m.userId));
  return [...list, ...page.filter((m) => !seen.has(m.userId))];
}

/**
 * 群成员分页（F-UI-38）：loadMore 加载下一页并按 userId 去重；reload 从头拉到之前的数量（列表不会缩回第一页），
 * 有更新的 reload 时丢弃旧结果。收到 groupChanged 时自动 reload。
 */
export function useGroupMembers(groupId: string) {
  const c = useClient();
  const connected = useStore((s) => s.state === 'connected');
  const [members, setMembers] = useState<GroupMemberInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const cursor = useRef('');
  const count = useRef(0);
  const generation = useRef(0);
  const busy = useRef(false);

  const current = useRef<GroupMemberInfo[]>([]);

  const publish = useCallback((list: GroupMemberInfo[], next: string) => {
    cursor.current = next;
    count.current = list.length;
    current.current = list;
    setMembers(list);
    setHasMore(next !== '');
    setLoaded(true);
  }, []);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    busy.current = true;
    try {
      let list: GroupMemberInfo[] = [];
      let next = '';
      do {
        const page = await c.loadGroupMembers(groupId, next || undefined);
        if (mine !== generation.current) return;
        list = mergeMembers(list, page.members);
        next = page.nextCursor;
      } while (next && list.length < count.current);
      publish(list, next);
    } catch {
      // 保留现有列表；连接恢复或下一次 groupChanged 时重查
    } finally {
      if (mine === generation.current) busy.current = false;
    }
  }, [c, groupId, publish]);

  const loadMore = useCallback(async () => {
    if (busy.current || !cursor.current) return;
    const mine = generation.current;
    busy.current = true;
    try {
      const page = await c.loadGroupMembers(groupId, cursor.current);
      if (mine !== generation.current) return;
      publish(mergeMembers(current.current, page.members), page.nextCursor);
    } catch {
      // 下次滚动时重试
    } finally {
      if (mine === generation.current) busy.current = false;
    }
  }, [c, groupId, publish]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 异步请求的结果，不是同步 setState
    if (connected) void reload();
  }, [connected, reload]);
  useEffect(() => c.on('groupChanged', (g) => void (g === groupId && reload())), [c, groupId, reload]);
  return { members, loaded, hasMore, loadMore, reload };
}

const NO_NOTICES: NoticeSnapshot = { list: [], unseen: 0, banner: null };
const noNoticesSubscribe = () => () => {};

/** 系统通知的列表、未查看条数和横幅（F-UI-44）。 */
export function useNotices(): NoticeSnapshot {
  const { notices } = useIm();
  return useSyncExternalStore(notices?.subscribe ?? noNoticesSubscribe, notices?.getSnapshot ?? (() => NO_NOTICES));
}

/** 显示名：好友备注 → 昵称 → userId。 */
export function useDisplayName(userId: string): string {
  const c = useClient();
  useFriends();
  useProfile(userId);
  return c.displayName(userId);
}

// ---- 图片和文件（PRD-chat F-FILE-02、03、07） ----

const noop = () => () => {};

/** 这次登录的附件状态；演示的旧客户端或测试里没有时为 null。 */
export function useAttachments() {
  const { attachments } = useIm();
  useSyncExternalStore(attachments?.subscribe ?? noop, () => attachments?.version ?? 0);
  return attachments;
}
