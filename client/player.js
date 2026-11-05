// The embedded YouTube player, through YouTube's documented iframe postMessage protocol
// (the one its IFrame API script uses), so no third-party script has to run on our page.
// With `enablejsapi=1` the player reports its time and state to us once we say we're
// listening; we use that to save watch progress and to play the next video when one ends.

export const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';
const ENDED = 0;
const PLAYING = 1;

/**
 * @param {{ vid: string, title: string, start?: number, autoplay?: boolean,
 *           onProgress?: (seconds: number, duration: number) => void, onEnded?: () => void }} opts
 * @returns {{ iframe: HTMLIFrameElement, destroy: () => void }}
 */
export function createPlayer({ vid, title, start = 0, autoplay = true, onProgress, onEnded }) {
  const params = new URLSearchParams({
    rel: '0',
    playsinline: '1',
    enablejsapi: '1',
    origin: location.origin,
    widget_referrer: location.origin,
  });
  if (autoplay) params.set('autoplay', '1');
  if (start > 0) params.set('start', String(Math.floor(start)));
  const iframe = document.createElement('iframe');
  iframe.src = `${PLAYER_ORIGIN}/embed/${encodeURIComponent(vid)}?${params}`;
  iframe.title = title;
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allowFullscreen = true;

  const id = Math.floor(Math.random() * 1e9);
  let ready = false;
  let ended = false;
  let offVideo = false;
  let duration = 0;
  const post = (msg) => iframe.contentWindow?.postMessage(JSON.stringify({ ...msg, id, channel: 'widget' }), PLAYER_ORIGIN);

  // The player only starts reporting after it hears "listening"; it may not be ready for the
  // first one, so repeat until it answers.
  let tries = 0;
  const hello = setInterval(() => {
    if (ready || ++tries > 40) return clearInterval(hello);
    post({ event: 'listening' });
  }, 250);
  iframe.addEventListener('load', () => post({ event: 'listening' }));

  function onMessage(e) {
    if (e.origin !== PLAYER_ORIGIN || e.source !== iframe.contentWindow || typeof e.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.event === 'onReady' || msg.event === 'initialDelivery' || msg.event === 'infoDelivery') ready = true;
    const info = msg.info && typeof msg.info === 'object' ? msg.info : {};
    // The embed can switch to another video (end screen, channel links): then what it reports
    // isn't about our video, so nothing is saved and autoplay doesn't fire for it.
    const playing = info.videoData?.video_id;
    if (playing && playing !== vid) {
      offVideo = true;
      return;
    }
    if (playing === vid) offVideo = false;
    if (offVideo) return;
    if (Number.isFinite(info.duration) && info.duration > 0) duration = info.duration;
    if (Number.isFinite(info.currentTime) && duration > 0) onProgress?.(info.currentTime, duration);
    const stateNow = msg.event === 'onStateChange' ? msg.info : info.playerState;
    if (stateNow === PLAYING) ended = false; // a replay can end (and autoplay) again
    if (stateNow === ENDED && !ended) {
      ended = true;
      onEnded?.();
    }
  }
  addEventListener('message', onMessage);

  return {
    iframe,
    /** Run a player command, e.g. command('pauseVideo') or command('seekTo', [0, true]). */
    command(func, args = []) {
      post({ event: 'command', func, args });
    },
    destroy() {
      clearInterval(hello);
      removeEventListener('message', onMessage);
    },
  };
}
