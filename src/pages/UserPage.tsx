import { c2cConvId } from '@tianting/sdk';
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Avatar, OfficialTag } from '../components/Avatar';
import { Confirm } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useBlocks, useFriendRequests, useFriends, useProfile, useRelation, useSocialSettings } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { chatPath } from '../lib/routes';
import { applyPath, BLOCK_TEXT, errCode, useGoBack, userPath, type UserRouteState } from '../lib/social';
import { decodeParam } from './ChatPage';
import { ReportSheet, useReportOn } from './ReportSheet';

/**
 * 资料卡（PRD-ui F-UI-14）。资料来源：好友 / 申请 / 黑名单项的 profile → users 缓存 → 路由状态 → 只显示 userId。
 * 不在可见范围内的用户 users 不返回，页面与不存在的用户结构相同，不显示"用户不存在"。
 */
export function UserPage() {
  const userId = decodeParam(useParams().userId);
  const self = useSelf();
  const c = useClient();
  const navigate = useNavigate();
  const toast = useToast();
  const goBack = useGoBack('/contacts');
  const state = (useLocation().state ?? {}) as UserRouteState;
  const friends = useFriends();
  const blocks = useBlocks();
  const requests = useFriendRequests().items;
  const mode = useSocialSettings().mode;
  const relation = useRelation(userId);
  const cached = useProfile(userId);
  const friend = friends.find((f) => f.userId === userId);
  const block = blocks.find((b) => b.userId === userId);
  const request = requests.find((r) => r.userId === userId && r.profile);
  const profile = friend?.profile ?? request?.profile ?? block?.profile ?? cached ?? state.profile;
  const nickname = profile?.nickname ?? '';
  const name = friend?.remark || nickname || userId;
  const official = profile?.official ?? false;
  const isFriend = !!friend;
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<'block' | 'delete' | 'report' | null>(null);
  const reportOn = useReportOn();
  const [busy, setBusy] = useState(false);

  const open = mode === 'open';
  const canChat =
    relation === 'friend' ||
    (relation === 'blocked' && (open || isFriend)) ||
    ((relation === 'pendingIn' || relation === 'pendingOut') && open) ||
    (relation === 'none' && (open || official));

  async function run(cmd: string, fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(messageFor(errCode(e), cmd));
    } finally {
      setBusy(false);
    }
  }

  const applyState: UserRouteState = {
    source: state.source ?? 'card',
    ...(state.sourceRef ? { sourceRef: state.sourceRef } : {}),
    ...(profile ? { profile: { nickname, avatar: profile.avatar, official } } : {}),
  };
  const toApply = () => navigate(applyPath(userId), { state: applyState });
  const toChat = () => navigate(chatPath(c2cConvId(self, userId)));
  const hasMenu = relation !== 'self';

  return (
    <div className="tt-page">
      <TopBar
        title=""
        back={goBack}
        right={
          hasMenu && (
            <button className="tt-icon-btn" aria-label="更多" onClick={() => setMenu(true)} data-testid="user-more">
              <Icon name="more" />
            </button>
          )
        }
      />
      {menu && (
        <div className="tt-menu-layer" onClick={() => setMenu(false)}>
          <div className="tt-menu tt-plus-menu" role="menu" data-testid="user-menu">
            {isFriend && (
              <button role="menuitem" onClick={() => navigate(`${userPath(userId)}/remark`)}>
                设置备注
              </button>
            )}
            {relation === 'blocked' ? (
              <button role="menuitem" onClick={() => void run('unblock', () => c.unblock(userId))}>
                移出黑名单
              </button>
            ) : (
              <button role="menuitem" onClick={() => setConfirm('block')}>
                加入黑名单
              </button>
            )}
            {isFriend && (
              <button role="menuitem" onClick={() => setConfirm('delete')}>
                删除朋友
              </button>
            )}
            {reportOn && (
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setConfirm('report');
                }}
                data-testid="user-report"
              >
                举报
              </button>
            )}
          </div>
        </div>
      )}
      <div className="tt-scroll">
        <div className="tt-card tt-info-head" data-testid="user-head">
          <Avatar id={userId} name={name} size={64} src={profile?.avatar} />
          <div className="tt-user-text">
            <div className="tt-info-name tt-large" data-testid="user-name">
              {name} {official && <OfficialTag />}
            </div>
            {friend?.remark && nickname && <div className="tt-secondary">昵称：{nickname}</div>}
            <div className="tt-secondary">账号：{userId}</div>
            {relation === 'blocked' && (
              <div className="tt-secondary" data-testid="user-blocked">
                已加入黑名单
              </div>
            )}
          </div>
        </div>
        <div className="tt-form" data-testid="user-actions">
          {relation === 'pendingIn' && (
            <button
              className="tt-btn tt-btn-primary tt-btn-block"
              disabled={busy}
              onClick={() => void run('friendRespond', () => c.respondFriend(userId, 'accept'))}
            >
              通过验证
            </button>
          )}
          {relation === 'pendingOut' && (
            <>
              <p className="tt-secondary tt-center">已发送申请，等待验证</p>
              <button className="tt-btn tt-btn-block" onClick={toApply}>
                重新发送
              </button>
            </>
          )}
          {relation === 'none' && (
            <button className="tt-btn tt-btn-primary tt-btn-block" onClick={toApply} data-testid="user-add">
              添加到通讯录
            </button>
          )}
          {relation !== 'self' && canChat && (
            <button
              className={`tt-btn tt-btn-block${relation === 'friend' ? ' tt-btn-primary' : ''}`}
              onClick={toChat}
              data-testid="user-chat"
            >
              发消息
            </button>
          )}
          {isFriend && relation === 'friend' && (
            <button className="tt-btn tt-btn-block" onClick={() => navigate(`${userPath(userId)}/remark`)}>
              设置备注
            </button>
          )}
        </div>
      </div>
      {confirm === 'block' && (
        <Confirm
          testId="block-dialog"
          text={BLOCK_TEXT}
          ok="确定"
          onCancel={() => setConfirm(null)}
          onOk={() => {
            setConfirm(null);
            setMenu(false);
            void run('block', () => c.block(userId));
          }}
        />
      )}
      {confirm === 'report' && (
        // 举报用户成功后询问拉黑；已在黑名单的不问（frontend-chat 第 79 条）。
        <ReportSheet
          target={{ targetType: 'user', userId }}
          askBlock={relation === 'blocked' ? undefined : userId}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'delete' && (
        <Confirm
          testId="delete-dialog"
          text={
            <>
              确定删除朋友"{name}"？
              {mode === 'friends' && <p>删除后你们将无法继续私聊</p>}
            </>
          }
          ok="删除"
          danger
          onCancel={() => setConfirm(null)}
          onOk={() => {
            setConfirm(null);
            setMenu(false);
            void run('friendDelete', () => c.deleteFriend(userId));
          }}
        />
      )}
    </div>
  );
}
