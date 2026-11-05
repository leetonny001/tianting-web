import { useSyncExternalStore } from 'react';

// 宽屏条件（PRD-ui 3.3 节）。手机横屏、iPad（触屏）不满足，保持窄屏居中布局。
export const WIDE_QUERY = '(min-width: 768px) and (min-height: 500px) and (hover: hover) and (pointer: fine)';

const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null);

export const isWide = () => query()?.matches ?? false;

function subscribe(cb: () => void) {
  const m = query();
  m?.addEventListener('change', cb);
  return () => m?.removeEventListener('change', cb);
}

/** 视口是否满足宽屏条件；跨过条件时实时变化，路由和连接都不受影响（F-UI-02 规则 2）。 */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, isWide);
}

export type Section = 'chats' | 'contacts' | 'me';

export interface WideRoute {
  /** 导航栏选中哪一项、列表栏显示什么。 */
  section: Section;
  /** 主区显示的路由。 */
  mainPath: string;
  /** 当前路由显示在主区右侧的侧板里（主区是 mainPath）。 */
  panel: boolean;
  /** 侧板后面留着的聊天页，下一次导航时传回来。 */
  chatBehind: string | null;
}

const CHAT_RE = /^(\/chat\/[^/]+)(?:\/(?:info|notice|members|invite))?$/;
const PROFILE_RE = /^\/(?:user\/[^/]+(?:\/remark)?|contacts\/apply\/[^/]+)$/;

/**
 * 宽屏下一个路由怎么放（3.3 节）：聊天信息、成员等是聊天页上的侧板；资料卡从聊天页进入时也是侧板，
 * 从通讯录进入或直接打开时在主区。
 */
export function wideRoute(pathname: string, chatBehind: string | null): WideRoute {
  const chat = CHAT_RE.exec(pathname);
  if (chat) {
    return { section: 'chats', mainPath: chat[1]!, panel: pathname !== chat[1], chatBehind: chat[1]! };
  }
  if (chatBehind && PROFILE_RE.test(pathname)) {
    return { section: 'chats', mainPath: chatBehind, panel: true, chatBehind };
  }
  const section: Section =
    pathname === '/contacts' || pathname.startsWith('/contacts/') || pathname.startsWith('/user/')
      ? 'contacts'
      : pathname === '/me' || pathname.startsWith('/me/')
        ? 'me'
        : 'chats';
  return { section, mainPath: pathname, panel: false, chatBehind: null };
}
