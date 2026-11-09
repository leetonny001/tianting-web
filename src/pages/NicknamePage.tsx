import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useIm, useSelf } from '../im/ImProvider';
import { useProfile } from '../im/hooks';
import { accountErrorText } from '../lib/accountText';
import { textLen } from '../lib/social';
import { AvatarEditor } from './AvatarEditor';

const MAX_NICKNAME = 32;

/** 改昵称、头像（F-ACC-06）：本端立即显示，其他端按 10 分钟缓存更新。头像见 AvatarEditor（FE-633）。 */
export function NicknamePage() {
  const userId = useSelf();
  const profile = useProfile(userId);
  return (
    <NicknameForm
      key={profile?.nickname ?? ''}
      current={profile?.nickname ?? ''}
      avatar={<AvatarEditor userId={userId} name={profile?.nickname || userId} current={profile?.avatar} />}
    />
  );
}

function NicknameForm({ current, avatar }: { current: string; avatar: ReactNode }) {
  const { account } = useIm();
  const navigate = useNavigate();
  const toast = useToast();
  const [value, setValue] = useState(current);
  const inFlight = useRef(false);
  const next = value.trim();
  const tooLong = textLen(value) > MAX_NICKNAME;
  const invalid = next === '' || tooLong;

  async function done() {
    if (inFlight.current || invalid) return;
    if (next === current) {
      navigate('/me', { replace: true });
      return;
    }
    inFlight.current = true;
    try {
      await account.updateProfile({ nickname: next });
      navigate('/me', { replace: true });
    } catch (e) {
      toast(accountErrorText(e));
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="tt-page">
      <TopBar
        title="修改昵称"
        back="/me"
        right={
          <button
            className="tt-link tt-topbar-action"
            disabled={invalid}
            onClick={() => void done()}
            data-testid="nickname-done"
          >
            完成
          </button>
        }
      />
      <div className="tt-scroll tt-form">
        {avatar}
        <label className="tt-field">
          <span>昵称</span>
          <input
            className="tt-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="nickname-input"
          />
        </label>
        {tooLong && <p className="tt-field-error">昵称最多 32 个字</p>}
      </div>
    </div>
  );
}
