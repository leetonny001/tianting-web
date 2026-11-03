import { ConnBanner } from '../components/ConnBanner';
import { TabBar } from '../components/TabBar';
import { TopBar } from '../components/TopBar';

/** 通讯录（PRD-ui F-UI-13）。好友、新的朋友、群聊列表依赖服务端社交功能（PRD-social，BE-100 起），上线后替换本页。 */
export function ContactsPage() {
  return (
    <div className="tt-page">
      <TopBar title="通讯录" />
      <ConnBanner />
      <div className="tt-scroll">
        <div className="tt-empty" data-testid="contacts-pending">
          <p>好友功能即将上线</p>
          <p className="tt-secondary">现在可以在"消息"页通过"发起单聊"和任何人聊天</p>
        </div>
      </div>
      <TabBar />
    </div>
  );
}
