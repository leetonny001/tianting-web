import { useState } from 'react';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useSocialSettings } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { errCode } from '../lib/social';

/** 隐私设置（PRD-ui F-UI-30）：请求期间开关禁用，失败回到原值；其他端修改后实时更新。 */
export function PrivacyPage() {
  const c = useClient();
  const { searchable } = useSocialSettings();
  const toast = useToast();
  const [pending, setPending] = useState<boolean | null>(null);

  async function toggle(next: boolean) {
    setPending(next);
    try {
      await c.setSearchable(next);
    } catch (e) {
      toast(messageFor(errCode(e), 'setPrivacy'));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="tt-page">
      <TopBar title="隐私" back="/me/settings" />
      <div className="tt-scroll">
        <label className="tt-row tt-row-between">
          <span>允许通过账号搜索到我</span>
          <input
            type="checkbox"
            role="switch"
            className="tt-switch"
            checked={pending ?? searchable}
            disabled={pending !== null}
            onChange={(e) => void toggle(e.target.checked)}
            data-testid="privacy-switch"
          />
        </label>
        <p className="tt-secondary tt-note">
          关闭后，其他人无法通过账号搜索到你；已经是朋友、同在一个群聊或和你聊过天的人仍可以看到你的资料
        </p>
      </div>
    </div>
  );
}
