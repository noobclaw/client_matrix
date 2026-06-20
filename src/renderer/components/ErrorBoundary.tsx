// ─────────────────────────────────────────────────────────────────────────
// ErrorBoundary.tsx — last-line defense against blank/black-screen crashes
//
// v1.x: 真实合伙人真到账 → RebateDrawer / LuckyBag / NotificationCenter
// 任一组件渲染时抛错 → React 18 默认 unmount 整个 App 树 → 用户只看到 body
// 暗色背景(看起来纯黑屏,无任何 UI 可交互)。这个 ErrorBoundary 拦住:
//   - 出错时显示一个可读的 fallback 卡片(含报错信息 + Reload 按钮)
//   - 不卸载兄弟组件,黑屏问题不再发生
//   - 错误打到 console 方便 dev tools 看 stack
//
// 用法:在 App.tsx 把会因为外部数据/事件触发崩溃的组件包起来,例如
//   <ErrorBoundary name="RebateDrawer"><RebateDrawer .../></ErrorBoundary>
// 给小范围 ErrorBoundary 比给整个 App 包一个 boundary 更友好:一个组件
// 崩了不影响其他视图,用户还能继续用 app 的其它功能。
// ─────────────────────────────────────────────────────────────────────────

import React from 'react';

interface ErrorBoundaryProps {
  /** 出错时 fallback 卡片上的来源名,方便用户复述 / dev 调试 */
  name?: string;
  /** 默认 fallback 卡片足够大部分情况用;特殊场景可传 null 静默(组件位置
   *  不重要,如 RebateDrawer 出错不显示 fallback 也不影响主功能) */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // log full stack — Sentry / 飞书 webhook 可在这里钩一下
    console.error(
      `[ErrorBoundary${this.props.name ? ' ' + this.props.name : ''}] Caught error:`,
      error,
      info.componentStack,
    );
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    // explicit null fallback → swallow,不渲染任何 UI(给非关键浮层用)
    if (this.props.fallback === null) return null;
    if (this.props.fallback !== undefined) return this.props.fallback;

    // default fallback: 居中黑底红字卡片,带 reload + retry
    const msg = this.state.error?.message || 'Unknown render error';
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            padding: '24px 28px',
            borderRadius: 14,
            background: '#1a1a2e',
            border: '2px solid #ef4444',
            boxShadow: '0 8px 32px rgba(239,68,68,0.3)',
            color: '#e8e8ff',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, color: '#ef4444', marginBottom: 8 }}>
            ⚠️ 渲染错误 {this.props.name ? `(${this.props.name})` : ''}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16, color: '#ccc' }}>
            页面里有一块崩了,但应用其他部分应该还能用。如果继续看到此提示,
            请把下面这行报错截图反馈给我们。
          </div>
          <pre
            style={{
              fontSize: 12,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              background: '#0c0c1a',
              padding: '8px 12px',
              borderRadius: 6,
              maxHeight: 200,
              overflow: 'auto',
              color: '#fca5a5',
              border: '1px solid #333',
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              marginBottom: 16,
            }}
          >
            {msg}
          </pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={this.reset}
              style={{
                flex: 1,
                padding: '8px 16px',
                borderRadius: 8,
                border: '1px solid #00FF88',
                background: 'rgba(0,255,136,0.1)',
                color: '#00FF88',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              重试渲染
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                flex: 1,
                padding: '8px 16px',
                borderRadius: 8,
                border: '1px solid #888',
                background: 'transparent',
                color: '#e8e8ff',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              刷新应用
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
