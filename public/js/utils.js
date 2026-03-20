/** Apply a theme ('dark' | 'light') and persist the choice. */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('signalfi_theme', theme);
}

/** Read the persisted theme, defaulting to 'dark'. */
export function getTheme() {
  return localStorage.getItem('signalfi_theme') || 'dark';
}

/**
 * Throttle — fires immediately on the leading edge, then at most once per `ms`.
 * A trailing call is always scheduled so the final value is never dropped.
 */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer) { clearTimeout(timer); timer = null; }
      last = now;
      fn(...args);
    } else {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); timer = null; fn(...args); }, remaining);
    }
  };
}

/**
 * Audio-taper (A-type) conversion utilities.
 *
 * Maps a linear slider position (0–100) to a logarithmic gain (0.0–1.0)
 * so that the midpoint (50) corresponds to -20 dB (gain ≈ 0.1), matching
 * the feel of a hardware audio-taper potentiometer.
 *
 *   gain  = 10 ^ (2 * (position/100 - 1))
 *   position = (log10(gain) / 2 + 1) * 100
 */

/** Round a 0.0–1.0 gain value to 2 decimal places before sending over MQTT. */
export function roundGain(gain) {
  return Math.round(gain * 10000) / 10000;
}

export function sliderToGain(slider) {
  if (slider <= 0) return 0;
  if (slider >= 100) return 1;
  return Math.pow(10, 2 * (slider / 100 - 1));
}

export function gainToSlider(gain) {
  if (gain <= 0) return 0;
  if (gain >= 1) return 100;
  return Math.round((Math.log10(gain) / 2 + 1) * 100);
}

/** Convert a dB value back to a slider position (0–100). */
export function dbToSlider(db) {
  const s = (db / 40 + 1) * 100;
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** Convert a slider position (0–100) to a dB string, e.g. "-20.0" or "-∞". */
export function sliderToDb(slider) {
  if (slider <= 0) return '-∞';
  return (40 * (slider / 100 - 1)).toFixed(1);
}

/** Convert a linear gain (0.0–1.0) to a dB string, e.g. "-20.0" or "-∞". */
export function gainToDb(gain) {
  if (gain <= 0) return '-∞';
  return (20 * Math.log10(gain)).toFixed(1);
}
