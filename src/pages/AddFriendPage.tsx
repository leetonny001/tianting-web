import type { SearchedUser } from '@tianting/sdk';
import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useRelation } from '../im/hooks';
import { copyText } from '../lib/clipboard';
import { messageFor } from '../lib/errors';
import { chatPath } from '../lib/routes';
import { applyPath, errCode, USER_ID_RE, userPath, type UserRouteState } from '../lib/social';
import { c2cConvId } from '@tianting/sdk';

/** 添加朋友（PRD-ui F-UI-26）：只做精确匹配。不存在、不可被搜索、被封禁，界面完全相同。 */
export function AddFriendPage() {
  const c = useClient();
  const self = useSelf();
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ user: SearchedUser | null } | null>(null);
  const [searching, setSearching] = useState(false);
  const inFlight = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const kw = keyword.trim();
    if (!kw || inFlight.current) return;
    if (!USER_ID_RE.test(kw)) {
      setError(messageFor(4004));
      setResult(null);
      return;
    }
    inFlight.current = true;
    setSearching(true);
    setError('');
    try {
      setResult({ user: await c.searchUser(kw) });
    } catch (err) {
      setResult(null);
      setError(messageFor(errCode(err), 'userSearch'));
    } finally {
      inFlight.current = false;
      setSearching(false);
    }
  }

  return (
    <div className="tt-page">
      <TopBar title="添加朋友" back="/contacts" />
      <div className="tt-scroll">
        <form className="tt-search" onSubmit={(e) => void submit(e)}>
          <input
            className="tt-input"
            placeholder="输入对方账号"
            aria-label="输入对方账号"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            data-testid="search-input"
          />
          {error && (
            <p className="tt-field-error" role="alert" data-testid="search-error">
              {error}
            </p>
          )}
        </form>
        <div className="tt-row-static tt-secondary">
          我的账号：{self}
          <button
            className="tt-link tt-inline-btn"
            onClick={async () => toast((await copyText(self)) ? '已复制' : '复制失败，请长按文字手动复制')}
          >
            复制
          </button>
        </div>
        {searching && (
          <p className="tt-history" data-testid="search-loading">
            搜索中…
          </p>
        )}
        {!searching && result && (
          <div data-testid="search-result">
            {result.user ? <ResultCard user={result.user} /> : <p className="tt-center tt-secondary">未找到该用户</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ user }: { user: SearchedUser }) {
  const c = useClient();
  const self = useSelf();
  const navigate = useNavigate();
  const toast = useToast();
  const local = useRelation(user.userId);
  const relation = local !== 'none' ? local : user.relation; // 通过验证、申请之后按本地最新状态
  const name = c.displayName(user.userId);
  const state: UserRouteState = {
    source: 'search',
    profile: { nickname: user.nickname, avatar: user.avatar, official: user.official },
  };
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className="tt-card tt-info-head tt-clickable"
      data-testid="search-card"
      onClick={() => navigate(userPath(user.userId), { state })}
    >
      <Avatar id={user.userId} name={name} size={48} src={user.avatar} />
      <div className="tt-user-text tt-grow">
        <span className="tt-ellipsis">
          {name} {user.official && <OfficialTag />}
        </span>
        <span className="tt-secondary">账号：{user.userId}</span>
        {relation === 'self' && <span className="tt-secondary">这是你自己</span>}
        {relation === 'pendingOut' && <span className="tt-secondary">已发送申请</span>}
        {relation === 'blocked' && <span className="tt-secondary">已加入黑名单</span>}
      </div>
      {relation === 'friend' && (
        <button
          className="tt-btn tt-btn-primary tt-btn-small"
          onClick={stop(() => navigate(chatPath(c2cConvId(self, user.userId))))}
        >
          发消息
        </button>
      )}
      {relation === 'pendingIn' && (
        <button
          className="tt-btn tt-btn-primary tt-btn-small"
          onClick={stop(() => {
            c.respondFriend(user.userId, 'accept').catch((e: unknown) =>
              toast(messageFor(errCode(e), 'friendRespond')),
            );
          })}
        >
          通过验证
        </button>
      )}
      {relation === 'pendingOut' && (
        <button className="tt-btn tt-btn-small" onClick={stop(() => navigate(applyPath(user.userId), { state }))}>
          重新发送
        </button>
      )}
      {relation === 'blocked' && (
        <button className="tt-btn tt-btn-small" onClick={stop(() => navigate(userPath(user.userId), { state }))}>
          查看资料
        </button>
      )}
      {relation === 'none' && (
        <button
          className="tt-btn tt-btn-primary tt-btn-small"
          onClick={stop(() => navigate(applyPath(user.userId), { state }))}
          data-testid="search-add"
        >
          添加到通讯录
        </button>
      )}
    </div>
  );
}
