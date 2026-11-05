import { useEffect, useState, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

// 打开着的弹窗 / 侧板，最后打开的在最上面：Tab 和 Esc 只归它管。
const stack: HTMLElement[] = [];
const top = () => stack[stack.length - 1];

function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.closest('.tt-dialog, .tt-panel') === el);
}

function onTab(e: KeyboardEvent) {
  const el = top();
  if (e.key !== 'Tab' || !el) return;
  const items = focusables(el);
  const first = items[0] ?? el;
  const last = items[items.length - 1] ?? el;
  const active = document.activeElement;
  if (!el.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === el)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * 焦点陷阱（PRD-ui FE-301）：打开时把焦点移进来（内部已有焦点时不动），Tab 在内部循环，
 * 关闭时把焦点还给打开前的元素。还不回去（元素已不在页面上）时用 fallback。
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  opts: { initial?: 'container' | 'first'; fallback?: () => HTMLElement | null | undefined } = {},
) {
  const [trigger] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stack.length === 0) document.addEventListener('keydown', onTab);
    stack.push(el);
    if (!el.contains(document.activeElement)) {
      (opts.initial === 'first' ? (focusables(el)[0] ?? el) : el).focus();
    }
    return () => {
      stack.splice(stack.indexOf(el), 1);
      if (stack.length === 0) document.removeEventListener('keydown', onTab);
      if (el.isConnected) return; // StrictMode 的模拟卸载：还在页面上，不算关闭
      const back = trigger && trigger !== document.body && trigger.isConnected ? trigger : opts.fallback?.();
      back?.focus();
    };
    // 只在打开、关闭时处理焦点
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 只有最上面的弹窗 / 侧板响应 Esc（侧板里的确认框打开时，Esc 只关确认框）。 */
export const isTopLayer = (el: HTMLElement | null) => !!el && top() === el;

/** 打开着的菜单按 Esc 关闭。 */
export function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active, onEscape]);
}
