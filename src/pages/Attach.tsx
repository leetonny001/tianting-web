// 聊天页的图片和文件（PRD-chat F-FILE-02、03、05、07，第 13.2～13.4 节，FE-633、FE-634）。
// 发：输入区"+"（图片、文件）、拖放、粘贴；一次最多 9 个；图片先在本页处理（canvas），文件原样。
// 收：图片按宽高占位、进入视口才取缩略图、点开看原图（缩放、保存）；文件显示图标、文件名（中间省略）、大小，浏览器下载。
import { NotConnectedError, type IMClient, type Message } from '@tianting/sdk';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Confirm, Dialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { useToast } from '../components/Toast';
import type { Attachments, MediaState } from '../im/attachments';
import { useAttachments } from '../im/hooks';
import { browserCodec, processImage, type ImageCodec } from '../lib/imageProcess';
import { attachmentErrorText, displaySize, formatSize, looksLikeImage, MAX_PICK, splitName } from '../lib/media';

export type PickMode = 'image' | 'file';

/** 测试注入：图片处理用的平台接口（jsdom 没有 canvas）。 */
let codec: ImageCodec = browserCodec;
export function setImageCodecForTest(c: ImageCodec | null) {
  codec = c ?? browserCodec;
}

/**
 * 发送一批选中的文件。mode=image 的都走图片处理；mode=file 原样发送，选中的里面有图片时先提示保留原始信息
 * （F-FILE-03 规则 2，AC-FILE-03-6），确认后才发。拖放、粘贴的按内容分开：图片按图片发，其他按文件发。
 */
export function useSendAttachments(c: IMClient, convId: string, onSent: () => void) {
  const toast = useToast();
  const att = useAttachments();
  const [confirm, setConfirm] = useState<File[] | null>(null);

  const sendNow = useCallback(
    (files: File[], mode: PickMode) => {
      if (!att) return;
      try {
        for (const f of files) {
          let id = '';
          const onProgress = (sent: number, total: number) => att.setProgress(id, sent, total);
          const m =
            mode === 'image'
              ? c.sendImage(
                  convId,
                  async () => {
                    const p = await processImage(f, codec);
                    att.setPreview(id, p.thumb.data as Blob);
                    return p;
                  },
                  { onProgress },
                )
              : c.sendFile(convId, { data: f, name: f.name || 'file', mime: f.type || undefined }, { onProgress });
          id = m.clientMsgId;
        }
        onSent();
      } catch (e) {
        if (!(e instanceof NotConnectedError)) throw e;
        toast('正在连接，请稍后再发送'); // 第一次连上之前不知道自己是谁（同文本，问题 H11）
      }
    },
    [att, c, convId, onSent, toast],
  );

  const send = useCallback(
    (files: File[], mode: PickMode | 'auto') => {
      if (files.length === 0) return;
      if (files.length > MAX_PICK) {
        toast(`一次最多选择 ${MAX_PICK} 个`);
        return;
      }
      if (mode === 'auto') {
        const images = files.filter(looksLikeImage);
        const others = files.filter((f) => !looksLikeImage(f));
        if (images.length) sendNow(images, 'image');
        if (others.length) sendNow(others, 'file');
        return;
      }
      if (mode === 'file' && files.some(looksLikeImage)) {
        setConfirm(files);
        return;
      }
      sendNow(files, mode);
    },
    [sendNow, toast],
  );

  const dialog = confirm && (
    <Confirm
      text="文件会保留原始信息（可能包含位置）"
      ok="发送"
      testId="file-meta-confirm"
      onCancel={() => setConfirm(null)}
      onOk={() => {
        const files = confirm;
        setConfirm(null);
        sendNow(files, 'file');
      }}
    />
  );
  return { send, dialog };
}

/** 输入区的"+"：图片、文件两个入口（第 13.3 节）。`features.files` 关闭时整个不显示（调用方判断）。 */
export function AttachButton({ onPick }: { onPick: (files: File[], mode: PickMode) => void }) {
  const [open, setOpen] = useState(false);
  const image = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const take = (mode: PickMode) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = ''; // 同一个文件可以再选一次；File 只在内存里（F-FILE-07 规则 2）
    if (files.length) onPick(files, mode);
  };
  return (
    <>
      <button
        type="button"
        className="tt-icon-btn"
        aria-label="发送图片或文件"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        data-testid="attach-button"
      >
        <Icon name="plus" />
      </button>
      {open && (
        <div className="tt-menu-layer" onClick={() => setOpen(false)}>
          <div
            className="tt-menu tt-attach-menu"
            role="menu"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            data-testid="attach-menu"
          >
            <button
              role="menuitem"
              autoFocus
              onClick={() => {
                setOpen(false);
                image.current?.click();
              }}
              data-testid="attach-image"
            >
              <Icon name="image" size={20} />
              图片
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                file.current?.click();
              }}
              data-testid="attach-file"
            >
              <Icon name="file" size={20} />
              文件
            </button>
          </div>
        </div>
      )}
      <input
        ref={image}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={take('image')}
        data-testid="pick-image"
      />
      <input ref={file} type="file" multiple hidden onChange={take('file')} data-testid="pick-file" />
    </>
  );
}

const IMAGE_STATUS: Partial<Record<Message['status'], string>> = {
  processing: '处理中',
  uploading: '上传中',
  queued: '等待发送',
  sending: '发送中',
};

/** 还没发出的附件：处理中、上传中（进度）、待发送，可以取消（AC-FILE-02-5）。 */
function Pending({ m, att, onCancel }: { m: Message; att: Attachments; onCancel: () => void }) {
  const p = att.progressOf(m.clientMsgId);
  const cancellable = m.status === 'processing' || m.status === 'uploading' || m.status === 'queued';
  const pct = m.status === 'uploading' && p !== undefined ? Math.floor(p * 100) : null;
  return (
    <div className="tt-att-pending" data-testid="att-pending">
      <span className="tt-att-progress-text" data-testid="att-progress">
        {IMAGE_STATUS[m.status]}
        {pct !== null && ` ${pct}%`}
      </span>
      {pct !== null && (
        <span className="tt-att-progress" role="progressbar" aria-label="上传进度" aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {cancellable && (
        <button className="tt-link tt-att-cancel" onClick={onCancel} data-testid="att-cancel">
          取消
        </button>
      )}
    </div>
  );
}

/** 失败原因（第 13.4 节"失败"）：跟在气泡下面，重发成功后消失。 */
export function AttachmentError({ m }: { m: Message }) {
  if (m.status !== 'failed' || (m.type !== 'image' && m.type !== 'file')) return null;
  return (
    <div className="tt-att-error" data-testid="att-error">
      {attachmentErrorText(m)}
    </div>
  );
}

/** 进入视口（懒加载，AC-FILE-02-9）。没有 IntersectionObserver 的环境直接算可见。 */
function useVisible(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || seen || !el) return;
    if (typeof IntersectionObserver !== 'function') {
      setSeen(true); // eslint-disable-line react-hooks/set-state-in-effect -- 没有观察器时立即可见
      return;
    }
    const root = el.closest('.tt-messages');
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), {
      root,
      rootMargin: '50px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled, seen]);
  return seen;
}

/** 图片气泡（F-FILE-02 规则 6）：按宽高预留位置，先缩略图，点开看原图。 */
export function ImageBubble({
  m,
  onCancel,
  onOpen,
}: {
  m: Message;
  onCancel: () => void;
  onOpen: (fileId: string, w?: number, h?: number) => void;
}) {
  const att = useAttachments();
  const img = m.body.image;
  const box = displaySize(img?.width, img?.height);
  const ref = useRef<HTMLDivElement>(null);
  const fileId = img?.fileId ?? '';
  const expired = img?.expired === true;
  const preview = att?.previewOf(m.clientMsgId);
  const visible = useVisible(ref, !!fileId && !expired && !preview);
  useEffect(() => {
    if (visible && fileId && att) att.request(fileId, 'thumb');
  }, [visible, fileId, att]);
  const state: MediaState | undefined = fileId && att ? att.state(fileId, 'thumb') : undefined;
  let inner: ReactNode;
  if (expired) {
    inner = <Placeholder icon="imageOff" text="图片已过期" testId="img-expired" />;
  } else if (preview) {
    inner = <img src={preview} alt="图片" className="tt-att-img" data-testid="img-thumb" />;
  } else if (state?.status === 'ready') {
    inner = (
      <img
        src={state.url}
        alt="图片"
        className="tt-att-img"
        onError={() => att?.markBroken(fileId, 'thumb')}
        data-testid="img-thumb"
      />
    );
  } else if (state?.status === 'gone') {
    inner = <Placeholder icon="imageOff" text="图片已过期" testId="img-gone" />;
  } else if (state?.status === 'broken') {
    // 解码失败或超过像素上限（AC-FILE-02-12）：占位，可以当文件下载原图（F-FILE-02 异常）。
    inner = <Placeholder icon="imageOff" text="图片无法显示" testId="img-broken" />;
  } else if (state?.status === 'error') {
    inner = (
      <button className="tt-att-retry" onClick={() => att?.retry(fileId, 'thumb')} data-testid="img-retry">
        <Icon name="imageOff" size={24} />
        加载失败，点击重试
      </button>
    );
  } else {
    inner = <Placeholder icon="image" text="" testId="img-loading" />;
  }
  const clickable = !!fileId && !expired && state?.status !== 'gone';
  return (
    <div className="tt-att-image-wrap">
      <div
        ref={ref}
        className="tt-att-image"
        style={{ width: box.width, height: box.height }}
        data-testid="img-bubble"
        data-file-id={fileId || undefined}
      >
        {clickable && (state?.status === 'ready' || state?.status === 'broken' || preview) ? (
          <button
            className="tt-att-image-btn"
            aria-label="查看图片"
            onClick={() => onOpen(fileId, img?.width, img?.height)}
            data-testid="img-open"
          >
            {inner}
          </button>
        ) : (
          inner
        )}
      </div>
      {m.status !== 'sent' && m.status !== 'failed' && att && <Pending m={m} att={att} onCancel={onCancel} />}
    </div>
  );
}

function Placeholder({ icon, text, testId }: { icon: IconName; text: string; testId: string }) {
  return (
    <span
      className="tt-att-placeholder"
      data-testid={testId}
      role={text ? undefined : 'img'}
      aria-label={text || '图片'}
    >
      <Icon name={icon} size={28} />
      {text && <span>{text}</span>}
    </span>
  );
}

const ICONS: [RegExp, IconName][] = [
  [/\.(pdf|txt|md|docx?|rtf|odt|pages)$/i, 'fileText'],
  [/\.(zip|rar|7z|tar|gz|bz2|xz)$/i, 'fileArchive'],
  [/\.(xlsx?|csv|ods|numbers)$/i, 'fileSheet'],
  [/\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i, 'fileImage'],
  [/\.(mp4|mov|avi|mkv|webm)$/i, 'fileVideo'],
  [/\.(mp3|wav|aac|flac|m4a|ogg)$/i, 'fileAudio'],
];

/** 按扩展名的类型图标（F-FILE-03 规则 3）。 */
export function fileIcon(name: string): IconName {
  return ICONS.find(([re]) => re.test(name))?.[1] ?? 'file';
}

/**
 * 文件气泡（F-FILE-03 规则 3）：图标、文件名（按纯文本，中间省略，扩展名可见）、大小。
 * 点击下载：别人发的文件每个会话第一次先提示来源（F-FILE-05 规则 3），浏览器下载，没有进度（第 13.2 节）。
 */
export function FileBubble({
  m,
  self,
  convId,
  onCancel,
}: {
  m: Message;
  self: boolean;
  convId: string;
  onCancel: () => void;
}) {
  const att = useAttachments();
  const toast = useToast();
  const f = m.body.file;
  const [ask, setAsk] = useState(false);
  const expired = f?.expired === true;
  const name = expired ? '' : f?.name || 'file';
  const { head, tail } = splitName(name);
  const fileId = f?.fileId ?? '';
  const size = f?.size !== undefined ? formatSize(f.size) : '';

  async function download() {
    if (!att) return;
    att.markPrompted(convId);
    const r = await att.downloadUrl(fileId);
    if ('error' in r) {
      toast(r.error === 4048 ? '文件不存在或已过期' : '下载失败');
      return;
    }
    // 跨域地址：download 属性不起作用，靠签进去的 Content-Disposition: attachment（F-FILE-03 规则 4）。
    const a = document.createElement('a');
    a.href = r.url;
    a.rel = 'noopener noreferrer';
    a.referrerPolicy = 'no-referrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const canDownload = !!fileId && !expired && m.status === 'sent';
  const body = (
    <>
      <Icon name={expired ? 'file' : fileIcon(name)} size={32} />
      <span className="tt-att-file-main">
        {expired ? (
          <span className="tt-att-file-name" data-testid="file-expired">
            文件已过期
          </span>
        ) : (
          <span className="tt-att-file-name" title={name} data-testid="file-name">
            <span className="tt-att-file-head">{head}</span>
            <span className="tt-att-file-tail">{tail}</span>
          </span>
        )}
        {!expired && (
          <span className="tt-att-file-size">
            <span className="tt-sr-only">，</span>
            {size}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div className="tt-att-file-wrap">
      {canDownload ? (
        <button
          className="tt-att-file"
          onClick={() => (!self && att?.needsPrompt(convId) ? setAsk(true) : void download())}
          data-testid="file-bubble"
        >
          {body}
          <Icon name="download" size={20} />
          <span className="tt-sr-only">，下载</span>
        </button>
      ) : (
        <div className="tt-att-file" data-testid="file-bubble">
          {body}
        </div>
      )}
      {m.status !== 'sent' && m.status !== 'failed' && att && <Pending m={m} att={att} onCancel={onCancel} />}
      {ask && (
        <Confirm
          text="文件来自其他用户，请确认来源可信"
          ok="下载"
          testId="file-source-confirm"
          onCancel={() => setAsk(false)}
          onOk={() => {
            setAsk(false);
            void download();
          }}
        />
      )}
    </div>
  );
}

/** 全屏看原图（F-FILE-02 规则 6、9）：缩放、保存；Esc 关闭。原图同样先看头部再解码。 */
export function ImageViewer({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const att = useAttachments();
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    att?.request(fileId, 'original');
  }, [att, fileId]);
  const state = att?.state(fileId, 'original');
  const thumb = att?.state(fileId, 'thumb');
  const z = (d: number) => setZoom((v) => Math.min(4, Math.max(0.5, Math.round((v + d) * 4) / 4)));
  return (
    <Dialog
      testId="image-viewer"
      onDismiss={onClose}
      actions={
        <>
          <button className="tt-icon-btn" aria-label="缩小" onClick={() => z(-0.25)} data-testid="viewer-zoom-out">
            <Icon name="zoomOut" />
          </button>
          <span className="tt-viewer-zoom" data-testid="viewer-zoom">
            {Math.round(zoom * 100)}%
          </span>
          <button className="tt-icon-btn" aria-label="放大" onClick={() => z(0.25)} data-testid="viewer-zoom-in">
            <Icon name="zoomIn" />
          </button>
          {state?.status === 'ready' && (
            <a
              className="tt-icon-btn"
              href={state.url}
              download="image"
              aria-label="保存图片"
              data-testid="viewer-save"
            >
              <Icon name="download" />
            </a>
          )}
          <button className="tt-icon-btn" aria-label="关闭" onClick={onClose} data-testid="viewer-close">
            <Icon name="close" />
          </button>
        </>
      }
    >
      <div
        className="tt-viewer"
        onWheel={(e) => z(e.deltaY < 0 ? 0.25 : -0.25)}
        onDoubleClick={() => setZoom((v) => (v === 1 ? 2 : 1))}
      >
        {state?.status === 'ready' ? (
          <img
            src={state.url}
            alt="图片"
            style={{ transform: `scale(${zoom})` }}
            onError={() => att?.markBroken(fileId, 'original')}
            data-testid="viewer-original"
          />
        ) : state?.status === 'error' ? (
          <button className="tt-att-retry" onClick={() => att?.retry(fileId, 'original')} data-testid="viewer-retry">
            加载失败，点击重试
          </button>
        ) : state?.status === 'broken' || state?.status === 'gone' ? (
          <Placeholder
            icon="imageOff"
            text={state.status === 'gone' ? '图片已过期' : '图片无法显示'}
            testId="viewer-broken"
          />
        ) : thumb?.status === 'ready' ? (
          <img src={thumb.url} alt="图片" className="tt-viewer-thumb" data-testid="viewer-loading" />
        ) : (
          <Placeholder icon="image" text="" testId="viewer-loading" />
        )}
      </div>
    </Dialog>
  );
}
