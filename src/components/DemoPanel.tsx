import { useState } from 'react';
import { useIm } from '../im/ImProvider';
import { useConnState, useConversations } from '../im/hooks';

/** 演示面板（PRD-core F-DEMO-01）：?demo=1 时浮在视口右下角，显示连接状态、各会话本地 maxSeq，可以"模拟断网"。 */
export function DemoPanel() {
  const { client, session } = useIm();
  const state = useConnState();
  const convs = useConversations();
  const [open, setOpen] = useState(true);
  const [offline, setOffline] = useState(false);
  return (
    <aside className="tt-demo" data-testid="demo-panel">
      <button className="tt-demo-toggle" onClick={() => setOpen((v) => !v)}>
        演示面板 {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="tt-demo-body">
          <div>
            连接状态：<b data-testid="demo-state">{state}</b>
          </div>
          <label className="tt-demo-switch">
            <input
              type="checkbox"
              checked={offline}
              onChange={(e) => {
                setOffline(e.target.checked);
                // 模拟断网：断开并暂停自动重连；关闭开关时用同一个 token 恢复连接，SDK 补拉断开期间的消息。
                if (e.target.checked) client?.disconnect();
                else if (session) client?.connect(session.token);
              }}
              data-testid="demo-offline"
            />
            模拟断网
          </label>
          <table>
            <tbody>
              {convs.map((c) => (
                <tr key={c.convId}>
                  <td>{c.name}</td>
                  <td data-testid="demo-maxseq">{c.maxSeq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
