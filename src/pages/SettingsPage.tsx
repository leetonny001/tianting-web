import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Confirm } from '../components/Dialog';
import { TopBar } from '../components/TopBar';
import { useIm } from '../im/ImProvider';
import { useBlocks, usePendingCount } from '../im/hooks';
import { APP_NAME, APP_VERSION, BUILD_ID } from '../lib/config';

/** 设置（PRD-ui F-UI-16）。 */
export function SettingsPage() {
  const { logout } = useIm();
  const pending = usePendingCount();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const blocks = useBlocks();
  return (
    <div className="tt-page">
      <TopBar title="设置" back="/me" />
      <div className="tt-scroll">
        <Link className="tt-row" to="/me/settings/privacy" data-testid="settings-privacy">
          隐私
        </Link>
        <Link className="tt-row tt-row-between" to="/me/settings/blocks" data-testid="settings-blocks">
          <span>黑名单</span>
          {blocks.length > 0 && <span className="tt-secondary">{blocks.length}</span>}
        </Link>
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
