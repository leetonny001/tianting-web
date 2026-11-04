import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Avatar } from '../components/Avatar';
import { Confirm, Dialog } from '../components/Dialog';
import { RowsSkeleton } from '../components/RowsSkeleton';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient } from '../im/ImProvider';
import { useFriends, useGroupInfo, useGroupMembers } from '../im/hooks';
import { messageFor } from '../lib/errors';
import { groupIdOf, invitePath, MAX_GROUP_NAME, membersPath, noticePath } from '../lib/group';
import { chatPath } from '../lib/routes';
import { errCode, textLen, userPath, type UserRouteState } from '../lib/social';

const GRID_SIZE = 20;

/** 群设置（PRD-ui F-UI-36）：入口按我的角色和托管状态显示。已不在群里时回到只读提示。 */
export function GroupSettings({ convId, onGone }: { convId: string; onGone: () => void }) {
  const groupId = groupIdOf(convId);
  const c = useClient();
  const navigate = useNavigate();
  const toast = useToast();
  useFriends(); // 备注变化时刷新显示名
  const { info, gone, refresh } = useGroupInfo(groupId);
  const { members } = useGroupMembers(groupId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'leave' | 'dissolve' | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (gone !== null) onGone();
  }, [gone, onGone]);
  const back = chatPath(convId);
  if (!info) {
    return (
      <div className="tt-page">
        <TopBar title="聊天信息" back={back} />
        <RowsSkeleton testId="group-skeleton" />
      </div>
    );
  }

  const role = info.myRole;
  const manager = role === 'owner' || role === 'admin';
  const selfOwned = !info.managed && role === 'owner';
  const canInvite = !info.managed || info.owner !== '';
  const rowState: UserRouteState = { source: 'group', sourceRef: groupId };
  const nameTooLong = renaming !== null && textLen(renaming) > MAX_GROUP_NAME;
  const nameEmpty = renaming !== null && textLen(renaming) === 0;

  async function act(cmd: string, op: () => Promise<unknown>, done: () => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await op();
      done();
    } catch (e) {
      const code = errCode(e);
      toast(messageFor(code, cmd));
      if (code === 4030) await refresh();
    } finally {
      inFlight.current = false;
    }
  }

  const leaveChats = () => navigate('/chats', { replace: true });
  return (
    <div className="tt-page">
      <TopBar title={`聊天信息（${info.memberCount}）`} back={back} />
      <div className="tt-scroll tt-info">
        <div className="tt-member-grid" data-testid="member-grid">
          {members.slice(0, GRID_SIZE).map((m) => {
            const name = c.displayName(m.userId);
            return (
              <Link
                key={m.userId}
                className="tt-grid-cell"
                to={userPath(m.userId)}
                state={rowState}
                data-testid="grid-member"
              >
                <Avatar id={m.userId} name={name} size={48} src={m.avatar} />
                <span className="tt-grid-name">{name}</span>
              </Link>
            );
          })}
          {canInvite && (
            <Link className="tt-grid-cell" to={invitePath(convId)} aria-label="邀请成员" data-testid="grid-invite">
              <span className="tt-grid-op">+</span>
            </Link>
          )}
          {manager && (
            <Link
              className="tt-grid-cell"
              to={membersPath(convId, 'kick')}
              aria-label="移出成员"
              data-testid="grid-kick"
            >
              <span className="tt-grid-op">−</span>
            </Link>
          )}
        </div>
        <Link className="tt-row tt-row-between" to={membersPath(convId)} data-testid="all-members">
          查看全部成员（{info.memberCount}）
        </Link>

        <div className="tt-section">
          {manager ? (
            <button
              className="tt-row tt-row-between"
              onClick={() => setRenaming(info.name)}
              data-testid="group-name"
              data-editable="true"
            >
              <span>群聊名称</span>
              <span className="tt-secondary tt-ellipsis">{info.name}</span>
            </button>
          ) : (
            <div className="tt-row-static tt-row-between" data-testid="group-name">
              <span>群聊名称</span>
              <span className="tt-secondary tt-ellipsis">{info.name}</span>
            </div>
          )}
          <Link className="tt-row tt-notice-row" to={noticePath(convId)} data-testid="group-notice">
            <span>群公告</span>
            <span className="tt-secondary tt-notice-preview" data-testid="group-notice-preview">
              {info.notice || '暂无群公告'}
            </span>
          </Link>
        </div>

        {role === 'owner' && (
          <div className="tt-section" data-testid="group-manage">
            <Link className="tt-row" to={membersPath(convId, 'admin')} data-testid="manage-admin">
              设置管理员
            </Link>
            <Link className="tt-row" to={membersPath(convId, 'transfer')} data-testid="manage-transfer">
              转让群主
            </Link>
          </div>
        )}

        <div className="tt-section">
          <button className="tt-row tt-danger-text" onClick={() => setConfirm('leave')} data-testid="group-leave">
            退出群聊
          </button>
          {selfOwned && (
            <button
              className="tt-row tt-danger-text"
              onClick={() => setConfirm('dissolve')}
              data-testid="group-dissolve"
            >
              解散群聊
            </button>
          )}
        </div>
      </div>

      {renaming !== null && (
        <Dialog
          sheet
          testId="rename-sheet"
          title="修改群聊名称"
          onDismiss={() => setRenaming(null)}
          actions={
            <>
              <button className="tt-btn" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button
                className="tt-btn tt-btn-primary"
                disabled={nameTooLong || nameEmpty}
                onClick={() => {
                  const name = renaming.trim();
                  setRenaming(null);
                  if (name === info.name) return;
                  void act(
                    'groupUpdate',
                    () => c.updateGroup(groupId, { name }),
                    () => void refresh(),
                  );
                }}
                data-testid="rename-save"
              >
                保存
              </button>
            </>
          }
        >
          <input
            className="tt-input"
            aria-label="群聊名称"
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            data-testid="rename-input"
          />
          {nameTooLong && (
            <p className="tt-field-error" role="alert">
              最多 {MAX_GROUP_NAME} 个字
            </p>
          )}
        </Dialog>
      )}
      {confirm === 'leave' && (
        <Confirm
          testId="leave-confirm"
          text={selfOwned ? '你是群主，退出后群主将自动转让给其他成员' : '退出后，将不再接收此群聊消息'}
          ok="退出"
          danger
          onCancel={() => setConfirm(null)}
          onOk={() => {
            setConfirm(null);
            void act('groupLeave', () => c.leaveGroup(groupId), leaveChats);
          }}
        />
      )}
      {confirm === 'dissolve' && (
        <Confirm
          testId="dissolve-confirm"
          text="解散后，所有成员将被移出群聊，且不能恢复"
          ok="解散"
          danger
          onCancel={() => setConfirm(null)}
          onOk={() => {
            setConfirm(null);
            void act('groupDissolve', () => c.dissolveGroup(groupId), leaveChats);
          }}
        />
      )}
    </div>
  );
}
