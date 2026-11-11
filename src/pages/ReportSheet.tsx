import { IMError, type ReportInput } from '@tianting/sdk';
import { useId, useRef, useState } from 'react';
import { Confirm, Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useClient, useIm } from '../im/ImProvider';
import { useBlocks } from '../im/hooks';
import { NETWORK_ERROR } from '../lib/accountText';
import { messageFor } from '../lib/errors';
import {
  clampCodePoints,
  codePoints,
  REPORT_DONE,
  REPORT_HINT,
  REPORT_NOTE_MAX,
  REPORT_REASONS,
  type ReportReason,
} from '../lib/report';
import { BLOCK_TEXT, errCode } from '../lib/social';

/** 举报入口开不开（frontend-chat 第 76 条）：GET /v1/config 的 features.moderation，老服务端没有按关闭。 */
export function useReportOn(): boolean {
  return !!useIm().knownConfig?.features?.moderation;
}

/** 举报的对象：第一批只举报单条消息（第 85 条）。 */
export type ReportTarget =
  | { targetType: 'message'; convId: string; msgId: string }
  | { targetType: 'user'; userId: string }
  | { targetType: 'group'; groupId: string };

/** 这些码重试也没有用：提示后关闭举报单（第 83 条、RC2-20）。其他的（5000、4290、超时、断线）留着举报单，可以再点提交。 */
const FINAL = new Set([4040, 4030, 4292]);

/**
 * 举报单（PRD-chat F-MOD-03 规则 8，FE-693 第 2 条）：底部弹层，理由单选（方向键切换）、补充说明（可选，0～200 码点）、
 * 提示"所选内容将提交给平台审核"。提交中按钮禁用；成功轻提示，askBlock 有值时（单聊消息、举报用户，对方不在黑名单）
 * 接着询问是否拉黑（第 79 条），拉黑失败单独提示，不影响举报结果。
 */
export function ReportSheet({
  target,
  askBlock,
  onClose,
}: {
  target: ReportTarget;
  /** 成功后询问拉黑的对象；已经在黑名单里的不问（调用方不用判断，这里按黑名单再查一次）。 */
  askBlock?: string;
  onClose: () => void;
}) {
  const c = useClient();
  const toast = useToast();
  const blocks = useBlocks();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [clipped, setClipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'form' | 'block'>('form');
  const pasted = useRef(false);
  const inFlight = useRef(false);
  const ids = { reasons: useId(), note: useId(), count: useId() };
  const blockTarget = askBlock && !blocks.some((b) => b.userId === askBlock) ? askBlock : undefined;

  async function submit() {
    if (!reason || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const text = note.trim();
    const input: ReportInput =
      target.targetType === 'message'
        ? { targetType: 'message', convId: target.convId, msgIds: [target.msgId], reason }
        : target.targetType === 'user'
          ? { targetType: 'user', userId: target.userId, reason }
          : { targetType: 'group', groupId: target.groupId, reason };
    try {
      await c.report(text ? { ...input, note: text } : input);
      toast(REPORT_DONE);
      if (blockTarget) setStage('block');
      else onClose();
    } catch (e) {
      // note 不进错误信息、不进日志（SDK 已保证）；不认识的错误按网络问题提示，可以再点提交（FE-693 第 2 条）。
      toast(e instanceof IMError ? messageFor(e.code, 'report') : NETWORK_ERROR);
      if (e instanceof IMError && FINAL.has(e.code)) onClose();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (stage === 'block' && blockTarget) {
    return (
      <Confirm
        testId="report-block-dialog"
        text={
          <>
            要把对方加入黑名单吗？
            <p className="tt-secondary">{BLOCK_TEXT}</p>
          </>
        }
        ok="加入黑名单"
        onCancel={onClose}
        onOk={() => {
          onClose();
          c.block(blockTarget).catch((e: unknown) => toast(messageFor(errCode(e), 'block')));
        }}
      />
    );
  }

  const len = codePoints(note);
  return (
    <Dialog
      sheet
      testId="report-sheet"
      title={
        <span className="tt-report-title">
          <Icon name="report" size={20} />
          举报
        </span>
      }
      onDismiss={() => !busy && onClose()}
      actions={
        <>
          <button
            className="tt-btn tt-btn-primary"
            disabled={!reason || busy}
            aria-busy={busy || undefined}
            onClick={() => void submit()}
            data-testid="report-submit"
          >
            {busy ? '提交中…' : '提交'}
          </button>
          <button className="tt-btn" disabled={busy} onClick={onClose} data-testid="report-cancel">
            取消
          </button>
        </>
      }
    >
      <fieldset className="tt-report-reasons" aria-labelledby={ids.reasons} data-testid="report-reasons">
        <legend id={ids.reasons} className="tt-report-legend">
          请选择举报理由
        </legend>
        {REPORT_REASONS.map((r) => (
          <label key={r.value} className="tt-report-reason">
            <input
              type="radio"
              name="report-reason"
              value={r.value}
              checked={reason === r.value}
              disabled={busy}
              onChange={() => setReason(r.value)}
              data-testid={`report-reason-${r.value}`}
            />
            {r.label}
          </label>
        ))}
      </fieldset>
      <label className="tt-report-legend" htmlFor={ids.note}>
        补充说明（可选）
      </label>
      <textarea
        id={ids.note}
        className="tt-input tt-textarea tt-report-note"
        rows={3}
        value={note}
        disabled={busy}
        aria-describedby={ids.count}
        onPaste={() => {
          pasted.current = true;
        }}
        onChange={(e) => {
          // 按码点数，超出不能再输入；粘贴超长的截断到 200 并提示（第 84 条）。
          const v = e.target.value;
          const over = codePoints(v) > REPORT_NOTE_MAX;
          setNote(over ? clampCodePoints(v) : v);
          setClipped(over && pasted.current);
          pasted.current = false;
        }}
        data-testid="report-note"
      />
      <span id={ids.count} className="tt-counter" data-testid="report-count">
        {len}/{REPORT_NOTE_MAX}
      </span>
      {clipped && (
        <p className="tt-field-error" role="status" data-testid="report-clipped">
          补充说明最多 {REPORT_NOTE_MAX} 个字，超出的部分已去掉
        </p>
      )}
      <p className="tt-secondary tt-report-hint" data-testid="report-hint">
        {REPORT_HINT}
      </p>
    </Dialog>
  );
}
