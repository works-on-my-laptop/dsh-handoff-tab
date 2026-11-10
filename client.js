/**
 * dsh-handoff-tab — Client half (Web browser bundle).
 *
 * Registers one `conversation.view` tab ("交接" / "Handoff") beside Chat and
 * Trajectory. The tab owns a small state machine backed by the Host routes:
 *
 *   idle        empty state with a "generate" button
 *   generating  spinner-ish progress; the Host keeps working when the tab is
 *               left, the session is switched, or the page is closed
 *   ready       toolbar (generated time · regenerate · copy) + the prompt body
 *   error       failure message and a retry button
 *
 * The prompt text itself is the whole copy target. Rendering is a plain
 * `<pre>` so there is no Markdown dependency. The component is remounted on
 * every tab/session selection, so mounting re-reads the Host state.
 *
 * Official guidance for plain-JS client plugins: do not `require` Harness
 * client packages (they are untyped and version-mutable, and a throwing
 * component blanks the slot entry). Only `react` is required; styling uses
 * the host's `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-handoff-tab',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const NS = 'handoff';
    const POLL_INTERVAL_MS = 1500;
    const MAX_WAIT_MS = 5 * 60 * 1000;

    const zh = {
      'view.handoff': '交接',
      'empty.title': '还没有交接提示词',
      'empty.desc': '在后台读取本会话的日志，生成一段可直接粘贴到新会话第一条消息的提示词。生成期间可以切走，回来继续看。',
      'empty.action': '生成交接提示词',
      'loading': '读取中…',
      'generating': '正在生成交接提示词…（可以切走，稍后回来查看）',
      'toolbar.generatedAt': '生成于',
      'toolbar.regenerate': '重新生成',
      'toolbar.copy': '复制',
      'toolbar.copied': '已复制',
      'toolbar.copyFailed': '复制失败',
      'error.title': '生成失败',
      'error.retry': '重试',
      'error.timeout': '生成超时，请刷新或重试',
      'error.noSession': '当前会话不可用',
      'error.unknown': '未知错误',
    };

    const en = {
      'view.handoff': 'Handoff',
      'empty.title': 'No handoff prompt yet',
      'empty.desc': 'Reads this session\'s log in the background and writes a prompt you can paste as the first message of a new session. You may leave while it runs and come back later.',
      'empty.action': 'Generate handoff prompt',
      'loading': 'Loading…',
      'generating': 'Generating the handoff prompt… (you can leave and come back)',
      'toolbar.generatedAt': 'Generated',
      'toolbar.regenerate': 'Regenerate',
      'toolbar.copy': 'Copy',
      'toolbar.copied': 'Copied',
      'toolbar.copyFailed': 'Copy failed',
      'error.title': 'Generation failed',
      'error.retry': 'Retry',
      'error.timeout': 'Generation timed out; refresh or retry',
      'error.noSession': 'This session is unavailable',
      'error.unknown': 'Unknown error',
    };

    const CSS = [
      // Only while this tab is mounted: hide the resident composer. The
      // attribute selector uses stable Host attributes (data-conversation-session,
      // data-composer-seat) rather than hashed module classes, and :has() makes
      // the rule reactive — switching away unmounts the view, restoring the
      // composer. The view is read-only, so losing the input box is intended.
      '[data-conversation-session]:has([data-dsh-handoff-view]) [data-composer-seat]{display:none!important}',
      '.dsh-handoff-tab-root{display:flex;flex-direction:column;flex:1 1 0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);box-sizing:border-box}',
      '.dsh-handoff-tab-root *,.dsh-handoff-tab-root *::before,.dsh-handoff-tab-root *::after{box-sizing:border-box}',
      '.dsh-handoff-tab-center{flex:1 1 0;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px 24px;text-align:center}',
      '.dsh-handoff-tab-title{font-size:15px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary)}',
      '.dsh-handoff-tab-desc{font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary);max-width:520px;margin:0}',
      '.dsh-handoff-tab-note{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}',
      '.dsh-handoff-tab-pulse{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#247bbf);animation:dsh-handoff-tab-pulse 1.2s ease-in-out infinite}',
      '@keyframes dsh-handoff-tab-pulse{0%,100%{opacity:.25;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}',
      '.dsh-handoff-tab-error{font-size:13px;line-height:1.7;color:var(--dsw-alias-state-error-primary);max-width:560px;word-break:break-word}',
      // Buttons own their full hover surface: an explicit border keeps the
      // hover/focus background visually bounded to the whole padded box.
      '.dsh-handoff-tab-btn{display:inline-flex;align-items:center;justify-content:center;width:auto;height:28px;padding:0 12px;margin:0;border:1px solid transparent;border-radius:calc(var(--dsw-radius-md, 8px) - 1px);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease,box-shadow .12s ease}',
      '.dsh-handoff-tab-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      '.dsh-handoff-tab-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.18))}',
      '.dsh-handoff-tab-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}',
      '.dsh-handoff-tab-btn:disabled{opacity:.55;cursor:default;background:transparent;border-color:transparent;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-handoff-tab-btn[data-copied="true"]{color:var(--dsw-alias-state-success-primary,#3fb950)}',
      '.dsh-handoff-tab-btn[data-copied="failed"]{color:var(--dsw-alias-state-error-primary,#f85149)}',
      '.dsh-handoff-tab-btn-primary{height:32px;padding:0 18px;font-size:13px;background:var(--dsw-alias-brand-primary,#247bbf);border-color:var(--dsw-alias-brand-primary,#247bbf);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.dsh-handoff-tab-btn-primary:hover{background:var(--dsw-alias-brand-primary,#247bbf);border-color:var(--dsw-alias-brand-primary,#247bbf);color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.18)}',
      '.dsh-handoff-tab-btn-primary:active{background:var(--dsw-alias-brand-primary,#247bbf);opacity:.92;box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      '.dsh-handoff-tab-toolbar{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsh-handoff-tab-time{flex:1 1 auto;min-width:0;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-handoff-tab-actions{flex:none;display:flex;align-items:center;gap:10px}',
      '.dsh-handoff-tab-body{flex:1 1 0;min-height:0;overflow:auto;padding:16px 20px 28px}',
      '.dsh-handoff-tab-pre{max-width:920px;margin:0 auto;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary)}',
    ].join('');

    function injectStyle() {
      const element = document.createElement('style');
      element.setAttribute('data-plugin', 'dsh-handoff-tab');
      element.textContent = CSS;
      document.head.append(element);
      return () => element.remove();
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
      } catch (error) {
        return new Date(ms).toLocaleString();
      }
    }

    async function writeClipboard(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        // fall through to the textarea fallback
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (error) {
        return false;
      }
    }

    function messageOf(error) {
      if (!error) return 'unknown error';
      return String((error && error.message) || error);
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-handoff-tab: dictionaries');
      ctx.effect(() => injectStyle(), 'dsh-handoff-tab: styles');
      const t = ctx.locale.bind(NS);

      function HandoffView(props) {
        const sessionId = props && props.sessionId ? String(props.sessionId) : '';
        const [status, setStatus] = React.useState('loading');
        const [document, setDocument] = React.useState(null);
        const [error, setError] = React.useState('');
        const [copyState, setCopyState] = React.useState('idle');
        const [nonce, setNonce] = React.useState(0);
        const copyTimer = React.useRef(null);

        React.useEffect(() => () => {
          if (copyTimer.current) clearTimeout(copyTimer.current);
        }, []);

        React.useEffect(() => {
          if (!sessionId) {
            setStatus('error');
            setError(t('error.noSession'));
            return undefined;
          }
          let cancelled = false;
          let timer = null;
          const controller = new AbortController();
          const startedAt = Date.now();
          setError('');
          setStatus((previous) => (previous === 'generating' ? 'generating' : 'loading'));

          const read = async () => {
            try {
              const response = await fetch('/handoff/doc?sessionId=' + encodeURIComponent(sessionId), {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller.signal,
              });
              let data = null;
              try {
                data = await response.json();
              } catch (error) {
                data = null;
              }
              if (cancelled) return;
              if (!response.ok) {
                setStatus('error');
                setError((data && data.error) || 'HTTP ' + response.status);
                return;
              }
              if (data && data.state === 'ready') {
                setDocument({
                  text: typeof data.text === 'string' ? data.text : '',
                  generatedAt: data.generatedAt,
                  model: data.model,
                });
                setStatus('ready');
                return;
              }
              if (data && data.state === 'generating') {
                setStatus('generating');
                if (Date.now() - startedAt > MAX_WAIT_MS) {
                  setStatus('error');
                  setError(t('error.timeout'));
                  return;
                }
                timer = window.setTimeout(read, POLL_INTERVAL_MS);
                return;
              }
              if (data && data.state === 'error') {
                setStatus('error');
                setError(data.error || t('error.unknown'));
                return;
              }
              setDocument(null);
              setStatus('idle');
            } catch (fetchError) {
              if (cancelled || (fetchError && fetchError.name === 'AbortError')) return;
              setStatus('error');
              setError(messageOf(fetchError));
            }
          };

          read();
          return () => {
            cancelled = true;
            controller.abort();
            if (timer) clearTimeout(timer);
          };
        }, [sessionId, nonce]);

        const generate = React.useCallback(async () => {
          if (!sessionId) return;
          setError('');
          setCopyState('idle');
          setStatus('generating');
          try {
            const response = await fetch('/handoff/generate', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            });
            let data = null;
            try {
              data = await response.json();
            } catch (error) {
              data = null;
            }
            if (!response.ok || (data && data.state === 'error')) {
              setStatus('error');
              setError((data && data.error) || 'HTTP ' + response.status);
              return;
            }
            setNonce((value) => value + 1);
          } catch (generateError) {
            setStatus('error');
            setError(messageOf(generateError));
          }
        }, [sessionId]);

        const copy = React.useCallback(async () => {
          const text = document && document.text;
          if (!text) return;
          const ok = await writeClipboard(text);
          setCopyState(ok ? 'done' : 'failed');
          if (copyTimer.current) clearTimeout(copyTimer.current);
          copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1600);
        }, [document]);

        const retry = () => {
          void generate();
        };

        const rootProps = {
          className: 'dsh-handoff-tab-root',
          'data-dsh-handoff-view': '',
          'data-conversation-composer-overlay': '',
        };

        if (status === 'loading') {
          return h('div', rootProps, h('div', { className: 'dsh-handoff-tab-center' },
            h('div', { className: 'dsh-handoff-tab-note' }, t('loading')),
          ));
        }

        if (status === 'idle') {
          return h('div', rootProps, h('div', { className: 'dsh-handoff-tab-center' },
            h('div', { className: 'dsh-handoff-tab-title' }, t('empty.title')),
            h('div', { className: 'dsh-handoff-tab-desc' }, t('empty.desc')),
            h('button', { type: 'button', className: 'dsh-handoff-tab-btn dsh-handoff-tab-btn-primary', onClick: () => void generate() }, t('empty.action')),
          ));
        }

        if (status === 'generating') {
          return h('div', rootProps, h('div', { className: 'dsh-handoff-tab-center' },
            h('div', { className: 'dsh-handoff-tab-note' }, h('span', { className: 'dsh-handoff-tab-pulse', 'aria-hidden': true }), t('generating')),
          ));
        }

        if (status === 'error') {
          return h('div', rootProps, h('div', { className: 'dsh-handoff-tab-center' },
            h('div', { className: 'dsh-handoff-tab-title' }, t('error.title')),
            h('div', { className: 'dsh-handoff-tab-error' }, error || t('error.unknown')),
            h('button', { type: 'button', className: 'dsh-handoff-tab-btn dsh-handoff-tab-btn-primary', onClick: retry }, t('error.retry')),
          ));
        }

        const text = (document && document.text) || '';
        const generatedAt = document && document.generatedAt;
        const copyLabel = copyState === 'done'
          ? t('toolbar.copied')
          : copyState === 'failed'
            ? t('toolbar.copyFailed')
            : t('toolbar.copy');
        const copyStateAttr = copyState === 'done' ? 'true' : copyState === 'failed' ? 'failed' : 'false';

        return h('div', rootProps,
          h('div', { className: 'dsh-handoff-tab-toolbar' },
            h('div', { className: 'dsh-handoff-tab-time', title: generatedAt ? new Date(generatedAt).toLocaleString() : '' },
              t('toolbar.generatedAt') + ' ' + formatTime(generatedAt)),
            h('div', { className: 'dsh-handoff-tab-actions' },
              h('button', { type: 'button', className: 'dsh-handoff-tab-btn', onClick: () => void generate() }, t('toolbar.regenerate')),
              h('button', { type: 'button', className: 'dsh-handoff-tab-btn', 'data-copied': copyStateAttr, onClick: () => void copy() }, copyLabel),
            ),
          ),
          h('div', { className: 'dsh-handoff-tab-body' },
            h('pre', { className: 'dsh-handoff-tab-pre' }, text),
          ),
        );
      }

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'handoff',
        order: 20,
        locale: NS,
        label: () => t('view.handoff'),
        inject: (sessionId) => ({ sessionId }),
      }, HandoffView));
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
