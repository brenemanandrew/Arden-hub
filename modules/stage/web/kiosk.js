/* TVs opening the board in their own browser.

   A Fire TV (Silk), or any smart TV browser, is a kiosk: no keyboard, a
   remote with an OK button, a browser bar that eats the top of the screen,
   and a screensaver waiting to take over. This file makes the page behave
   like F11 on a PC: it asks the browser for full screen, keeps the screen
   awake, and hides the parts of the header only a mouse could use.

   Browsers only allow full screen after a press, so the TV shows one line
   asking for OK on the remote; the first press does it and the line goes.
   Add ?tv=1 to any address to get the same behaviour on a PC or to test.
   Self-contained on purpose: the classic board has its own stylesheet. */
(function(){
  const ua = navigator.userAgent || '';
  const isTv = /Silk|AFT[A-Z0-9]{2,}|SMART-TV|SmartTV|Tizen|Web0S|BRAVIA|CrKey|GoogleTV|Roku/i.test(ua)
            || /[?&](tv|kiosk)=1/.test(location.search);
  /* inside the fit frame the frame page runs this instead, so full screen
     takes the whole scaled stage rather than the board on its own */
  if(!isTv || window.self !== window.top) return;
  const onBody = fn => { if(document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); };
  onBody(() => {
    document.body.classList.add('tv-kiosk');
    const css = document.createElement('style');
    css.textContent =
      'body.tv-kiosk{overflow:hidden}' +
      'body.tv-kiosk ::-webkit-scrollbar{display:none}' +
      'body.tv-kiosk .bar nav,body.tv-kiosk .bar .bartool,body.tv-kiosk .bar .bulb{display:none!important}' +
      '.fs-pill{position:fixed;left:50%;bottom:2.2vh;transform:translateX(-50%);z-index:99999;background:#f0b400;color:#000;' +
        'font:800 clamp(14px,1.6vw,26px) system-ui,Segoe UI,sans-serif;padding:.5em 1.2em;border-radius:999px;' +
        'box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none}';
    document.head.appendChild(css);
  });

  /* keep the screen on; the lock is dropped whenever the page is hidden and
     has to be asked for again */
  let lock = null;
  async function wake(){
    try{
      if(!navigator.wakeLock || lock) return;
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    }catch(e){ lock = null; }
  }
  wake();
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') wake(); });

  /* full screen, on the first press */
  const el = document.documentElement;
  const inFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const canFs = !!(el.requestFullscreen || el.webkitRequestFullscreen) && (document.fullscreenEnabled !== false);
  function goFs(){
    if(inFs()) return;
    try{
      const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen();
      if(p && p.catch) p.catch(() => {});
    }catch(e){}
  }
  let pill = null;
  function showPill(){
    if(pill || !canFs || inFs() || !document.body) return;
    pill = document.createElement('div');
    pill.className = 'fs-pill';
    pill.textContent = 'Press OK on the remote for full screen';
    document.body.appendChild(pill);
    // do not nag a browser that will never do it
    setTimeout(hidePill, 25000);
  }
  function hidePill(){ if(pill){ pill.remove(); pill = null; } }
  const press = () => { goFs(); hidePill(); };
  onBody(() => {
    showPill();
    document.addEventListener('keydown', press, { passive: true });
    document.addEventListener('click', press, { passive: true });
    document.addEventListener('touchend', press, { passive: true });
  });
  document.addEventListener('fullscreenchange', () => { if(inFs()) hidePill(); else showPill(); });
})();
