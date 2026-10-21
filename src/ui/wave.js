import { el, setText, setStyle, damp } from './util.js';

/**
 * Survival scoreline. Replaces the TDM match bar while a horde run is live:
 * wave number, hostiles left, score, personal best and the intermission clock.
 *
 * Values are written from `set()` (called by the mode each frame) but all
 * animation is integrated here from `dt`, so a capture frame is reproducible.
 */
export class WaveHud {
  constructor(parent) {
    this.root = el('div', 'ow-wave', parent);
    const row = el('div', 'row', this.root);

    const cell = (cls, label) => {
      const c = el('div', `cell ${cls}`, row);
      el('div', 'lbl', c, label);
      const v = el('b', 'num', c, '0');
      return v;
    };

    this.wave = cell('wave', 'Wave');
    el('div', 'sep', row);
    this.hostiles = cell('hostiles', 'Hostiles');
    el('div', 'sep', row);
    this.score = cell('score', 'Score');

    this.foot = el('div', 'foot', this.root);
    this.best = el('span', 'best', this.foot, 'BEST WAVE 0');
    this.phase = el('span', 'phase', this.foot, '');

    this.active = false;
    this.shown = 0;
    this.pulse = 0;
    this._lastHostiles = -1;
    this._lastPhase = '';
    this._lastBest = '';
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {object} s { wave, hostiles, score, best, phase, timer, dead }
   */
  set(s) {
    this.active = !!s.active;
    setText(this.wave, String(Math.max(1, s.wave ?? 1)).padStart(2, '0'));
    setText(this.hostiles, String(s.hostiles ?? 0).padStart(2, '0'));
    setText(this.score, String(s.score ?? 0).padStart(4, '0'));

    const best = `BEST WAVE ${String(s.best ?? 0).padStart(2, '0')}`;
    if (best !== this._lastBest) {
      this._lastBest = best;
      setText(this.best, best);
    }

    let phase = s.phase ?? '';
    if (phase === 'prep') {
      phase = `NEXT WAVE IN ${Math.max(0, s.timer ?? 0).toFixed(0)}`;
    } else if (phase === 'active') {
      phase = 'SURVIVE';
    } else if (phase === 'dead') {
      phase = 'REDEPLOYING';
    }
    if (phase !== this._lastPhase) {
      this._lastPhase = phase;
      setText(this.phase, phase);
    }

    if (this._lastHostiles >= 0 && (s.hostiles ?? 0) < this._lastHostiles) this.pulse = 1;
    this._lastHostiles = s.hostiles ?? 0;
  }

  update(dt) {
    this.shown = damp(this.shown, this.active ? 1 : 0, 14, dt);
    const vis = this.shown;
    setStyle(this.root, 'display', vis < 0.005 ? 'none' : '');
    if (vis < 0.005) return;

    this.pulse = Math.max(0, this.pulse - dt * 3.2);
    const p = this.pulse;
    const scale = 1 + 0.16 * p * p;
    const y = (1 - vis) * 8;
    setStyle(this.root, 'opacity', vis.toFixed(3));
    setStyle(this.root, 'transform', `translate(-50%, ${y.toFixed(2)}px)`);

    setStyle(this.hostiles, 'transform', `scale(${scale.toFixed(3)})`);
    setStyle(this.hostiles, 'color', p > 0.02 ? '#ffffff' : '');
  }

  dispose() {
    this.root.remove();
  }
}
