// 图标全部来自 Lucide（ISC 许可，见 LICENSES/lucide.txt），统一 stroke-width 1.75、currentColor（PRD-ui 6.6 节）。
import {
  BellOff,
  BookUser,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  CircleUserRound,
  Download,
  Ellipsis,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image,
  ImageOff,
  LoaderCircle,
  MessageSquareText,
  Settings,
  Smile,
  UserPlus,
  Users,
  X,
  ZoomIn,
  ZoomOut,
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
  smile: Smile,
  settings: Settings,
  users: Users,
  // 图片和文件（PRD-chat 第 13.3 节，PRD-ui 6.6 节清单）
  image: Image,
  imageOff: ImageOff,
  file: File,
  fileText: FileText,
  fileArchive: FileArchive,
  fileAudio: FileAudio,
  fileImage: FileImage,
  fileSheet: FileSpreadsheet,
  fileVideo: FileVideo,
  download: Download,
  close: X,
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  // 会话列表的免打扰（C5，PRD-chat F-CVS-02 规则 5；PRD-ui 6.6 节清单随 BE-488）
  notifyOff: BellOff,
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
