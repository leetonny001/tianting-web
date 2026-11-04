import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { useToast } from '../components/Toast';
import { TopBar } from '../components/TopBar';
import { useClient, useSelf } from '../im/ImProvider';
import { useProfile } from '../im/hooks';
import { messageFor } from '../lib/errors';
import {
  errCode,
  MAX_APPLY_MESSAGE,
  MAX_REMARK,
  textLen,
  useGoBack,
  userPath,
  type UserRouteState,
} from '../lib/social';
import { decodeParam } from './ChatPage';

/** 申请添加朋友（PRD-ui F-UI-27）。不论对方是否存在、是否拉黑了我，pending 时表现完全相同。 */
export function ApplyPage() {
  const userId = decodeParam(useParams().userId);
  const self = useSelf();
  const toast = useToast();
  const goBack = useGoBack('/contacts');
  const isSelf = userId === self;
  const done = useRef(false);
  useEffect(() => {
    if (isSelf && !done.current) {
      done.current = true;
      toast('不能添加自己');
      goBack();
    }
  }, [isSelf, toast, goBack]);
  if (isSelf) return null;
  return <ApplyForm key={userId} userId={userId} />;
}

function ApplyForm({ userId }: { userId: string }) {
  const c = useClient();
  const self = useSelf();
  const navigate = useNavigate();
  const toast = useToast();
  const goBack = useGoBack('/contacts');
  const state = (useLocation().state ?? {}) as UserRouteState;
  const me = useProfile(self);
  const peer = useProfile(userId);
  const nickname = peer?.nickname || state.profile?.nickname || '';
  const myName = me?.nickname || self;
  const [message, setMessage] = useState<string | null>(null); // null：用户还没改过，跟随默认值
  const [remark, setRemark] = useState('');
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const text = message ?? `我是${myName}`;
  const messageTooLong = textLen(text) > MAX_APPLY_MESSAGE;
  const remarkTooLong = textLen(remark) > MAX_REMARK;

  async function send() {
    if (inFlight.current || messageTooLong || remarkTooLong) return;
    inFlight.current = true;
    setSending(true);
    try {
      const status = await c.applyFriend(userId, {
        message: text.trim(),
        source: state.source ?? 'other',
        ...(state.sourceRef ? { sourceRef: state.sourceRef } : {}),
        ...(remark.trim() ? { remark: remark.trim() } : {}),
      });
      if (status === 'accepted') {
        toast('已添加到通讯录');
        navigate(userPath(userId), { replace: true });
      } else {
        toast('已发送');
        goBack();
      }
    } catch (e) {
      toast(messageFor(errCode(e), 'friendApply'));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  const name = nickname || userId;
  return (
    <div className="tt-page">
      <TopBar title="申请添加朋友" back={goBack} />
      <div className="tt-scroll">
        <div className="tt-card tt-info-head">
          <Avatar id={userId} name={name} size={48} src={peer?.avatar ?? state.profile?.avatar} />
          <div className="tt-info-name" data-testid="apply-name">
            {name}
          </div>
        </div>
        <div className="tt-form">
          <label className="tt-field">
            发送添加朋友申请
            <textarea
              className="tt-input tt-textarea"
              rows={3}
              value={text}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="apply-message"
            />
            <span className="tt-counter" data-testid="apply-count">
              {textLen(text)} / {MAX_APPLY_MESSAGE}
            </span>
          </label>
          {messageTooLong && (
            <p className="tt-field-error" role="alert">
              最多 {MAX_APPLY_MESSAGE} 个字
            </p>
          )}
          <label className="tt-field">
            设置备注
            <input
              className="tt-input"
              placeholder={name}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              data-testid="apply-remark"
            />
          </label>
          {remarkTooLong && (
            <p className="tt-field-error" role="alert">
              最多 {MAX_REMARK} 个字
            </p>
          )}
          <button
            className="tt-btn tt-btn-primary tt-btn-block"
            disabled={sending || messageTooLong || remarkTooLong}
            onClick={() => void send()}
            data-testid="apply-send"
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
