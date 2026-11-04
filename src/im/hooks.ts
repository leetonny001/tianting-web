import type {
  BlockedUser,
  ConnState,
  Conversation,
  ConversationSnapshot,
  Friend,
  FriendRequest,
  IMClient,
  Message,
  SocialSettings,
  UserProfile,
} from '@tianting/sdk';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useClient } from './ImProvider';

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
  return loaded?.userId === userId ? loaded : c.profileOf(userId);
}

/** 显示名：好友备注 → 昵称 → userId。 */
export function useDisplayName(userId: string): string {
  const c = useClient();
  useFriends();
  useProfile(userId);
  return c.displayName(userId);
}
