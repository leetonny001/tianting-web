import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Confirm } from '../components/Dialog';
import { TopBar } from '../components/TopBar';
import { useIm } from '../im/ImProvider';
import { usePendingCount } from '../im/hooks';
import { APP_NAME, APP_VERSION, BUILD_ID } from '../lib/config';

/** 设置（PRD-ui F-UI-16）。"隐私""黑名单"依赖服务端社交功能，随 PRD-social 上线。 */
export function SettingsPage() {
  const { logout } = useIm();
  const pending = usePendingCount();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="tt-page">
      <TopBar title="设置" back="/me" />
      <div className="tt-scroll">
        <div className="tt-card" data-testid="about">
          <div className="tt-row-static">关于{APP_NAME}</div>
          <div className="tt-row-static tt-secondary">
            版本 <span data-testid="app-version">{APP_VERSION}</span>（构建 {BUILD_ID}）
          </div>
          <div className="tt-row-static tt-secondary">图标：Lucide（ISC 许可）</div>
        </div>
        <button className="tt-row tt-danger-text" onClick={() => setConfirm(true)} data-testid="logout">
          退出登录
        </button>
      </div>
      {confirm && (
        <Confirm
          testId="logout-dialog"
          text={pending > 0 ? `有 ${pending} 条消息未发送，退出后将丢失` : '确定退出登录？'}
          ok="退出"
          danger
          onCancel={() => setConfirm(false)}
          onOk={() => {
            logout();
            navigate('/login', { replace: true });
          }}
        />
      )}
    </div>
  );
}
