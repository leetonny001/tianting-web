import type { ConnState, Conversation, IMClient, Message } from '@tianting/sdk';
import { useSyncExternalStore } from 'react';
import { useClient } from './ImProvider';

type Listener = () => void;

/**
 * 把 SDK 事件适配成 React 的外部 store：缓存事件里带来的快照，读取时返回同一个引用，
 * 只有 SDK 发出新快照时引用才变（useSyncExternalStore 要求 getSnapshot 在没有变化时返回相同的值）。
 */
class ClientStore {
  convs: Conversation[];
  convsLoaded = false;
  state: ConnState;
  banner = false;
  totalUnread: number;
  pendingCount: number;
  private msgs = new Map<string, Message[]>();
  private listeners = new Set<Listener>();

  constructor(private c: IMClient) {
    this.convs = c.conversations();
    this.state = c.state;
    this.totalUnread = c.totalUnread();
    this.pendingCount = c.pendingCount();
    const set = (fn: () => void) => () => {
      fn();
      this.listeners.forEach((l) => l());
    };
    c.on(
      'conversations',
      set(() => {
        this.convs = c.conversations();
        // disconnect() 会清空 SDK 的数据（退出登录、演示面板的"模拟断网"），缓存的消息列表一起丢弃，重连后重新拉取。
        if (c.state === 'disconnected' && this.convs.length === 0) this.msgs.clear();
        // 连上之后 SDK 先拉 convs 再发事件；连接前（重置时）发的空列表不算"已加载"（PRD-ui F-UI-20 骨架屏）。
        if (c.state === 'connected') this.convsLoaded = true;
      }),
    );
    c.on('messages', (id, list) =>
      set(() => {
        this.msgs.set(id, list);
      })(),
    );
    c.on('state', (s) => set(() => (this.state = s))());
    c.on('banner', (b) => set(() => (this.banner = b))());
    c.on('totalUnread', (n) => set(() => (this.totalUnread = n))());
    c.on('pendingCount', (n) => set(() => (this.pendingCount = n))());
  }

  messages(convId: string): Message[] {
    let list = this.msgs.get(convId);
    if (!list) {
      list = this.c.messages(convId);
      this.msgs.set(convId, list);
    }
    return list;
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
export const useMessages = (convId: string) => useStore((s) => s.messages(convId));
export const useConnState = () => useStore((s) => s.state);
export const useBanner = () => useStore((s) => s.banner);
export const useTotalUnread = () => useStore((s) => s.totalUnread);
export const usePendingCount = () => useStore((s) => s.pendingCount);
