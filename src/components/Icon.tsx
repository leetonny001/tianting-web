// 图标全部来自 Lucide（ISC 许可，见 LICENSES/lucide.txt），统一 stroke-width 1.75、currentColor（PRD-ui 6.6 节）。
import {
  BookUser,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  CircleUserRound,
  Ellipsis,
  LoaderCircle,
  MessageSquareText,
  UserPlus,
  type LucideProps,
} from 'lucide-react';

const icons = {
  chats: MessageSquareText,
  contacts: BookUser,
  me: CircleUserRound,
  plus: CirclePlus,
  addFriend: UserPlus,
  back: ChevronLeft,
  forward: ChevronRight,
  more: Ellipsis,
  failed: CircleAlert,
  loading: LoaderCircle,
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 24, ...rest }: { name: IconName; size?: number } & Omit<LucideProps, 'ref'>) {
  const C = icons[name];
  return (
    <C
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      className={name === 'loading' ? 'tt-spin' : undefined}
      {...rest}
    />
  );
}
