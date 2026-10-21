import * as THREE from 'three';

/**
 * NIGHTFALL — round-based survival remix.
 *
 * The TDM garrison is replaced by a horde director: waves of enemies descend on
 * the market at blue hour, each wave larger and tougher than the last. Between
 * waves the player gets a short regroup window; dying rewinds the run but keeps
 * the best-wave record.
 *
 * This is a *game mode*, not part of the visual pipeline. It consumes only
 * public subsystem APIs (`ai.spawn`, `ai.clearAgents`, `ui.setWave`,
 * `sky.setTimeOfDay`) and is disabled in deterministic capture runs, except
 * when a shot explicitly stages it via `debugStage()`.
 */

const NIGHT_HOUR = 20.6;
const FIRST_PREP = 5.0;
const PREP_TIME = 8.0;
const DEATH_TIME = 4.0;
const CORPSE_LIFE = 22;

const PHASE = {
  PREP: 'prep',
  ACTIVE: 'active',
  DEAD: 'dead',
};

const VARIANT_CYCLE = ['vanguard', 'irregular', 'breacher'];

export class SurvivalMode {
  static id = 'survival';
  static deps = ['ai', 'player', 'ui', 'world', 'sky'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    this.ai = ctx.peek('ai');
    this.player = ctx.peek('player');
    this.ui = ctx.peek('ui');
    this.world = ctx.peek('world');
    this.sky = ctx.peek('sky');

    /** Every actor the director owns this run. */
    this.enemies = [];
    this.waveSquads = [];
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.best = this._loadBest();
    this.phase = PHASE.PREP;
    this.timer = FIRST_PREP;
    this.spawnTimer = 0;
    this.deadTimer = 0;
    this.targetThisWave = 0;
    this.spawnedThisWave = 0;
    this.alive = 0;
    this.remaining = 0;
    this.maxAlive = 4;
    this.hostileVariant = 0;
    this.staged = false;
    this.active = false;
    this._retarget = 0;

    this._spawnPos = new THREE.Vector3();
    this._huntPoint = new THREE.Vector3();
    this._huntRoute = [this._huntPoint];
    this.spawnAnchors = [];

    const params = new URLSearchParams(location.search);
    // Capture runs are owned by the shot harness; classic TDM remains available
    // for anyone who wants the original sandbox back.
    this.active = !ctx.config.deterministic && params.get('mode') !== 'classic';
    if (!this.active) return;

    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));
    on('actor:death', (e) => this._actorDied(e));
    on('player:death', () => this._playerDied());

    // The imported garrison is TDM set dressing; the director owns spawning now.
    this.ai?.clearAgents?.();
    this.sky?.setTimeOfDay?.(NIGHT_HOUR);
    this._buildSpawnAnchors();

    this.ui?.setWave?.({
      active: true,
      wave: 1,
      hostiles: 0,
      score: 0,
      best: this.best,
      phase: PHASE.PREP,
      timer: FIRST_PREP,
    });
    this.ui?.banner?.show?.('NIGHTFALL', 'SURVIVE THE HORDE', 3.6);
    console.info(`[survival] nightfall active · best wave ${this.best}`);
  }

  /* ================================================================== */
  /* run state                                                          */
  /* ================================================================== */

  _beginPrep(seconds) {
    this.phase = PHASE.PREP;
    this.timer = seconds;
    this.spawnTimer = 0;
    const title = this.wave > 0 ? `WAVE ${pad(this.wave)} CLEARED` : 'NIGHTFALL';
    const sub =
      this.wave > 0
        ? `+${this.wave * 100} BONUS · NEXT WAVE IN ${Math.round(seconds)}`
        : 'SURVIVE THE HORDE';
    this.ui?.banner?.show?.(title, sub, 3.2);
    // A breather is also a small reward: the health system still caps at max.
    this.player?.heal?.(25);
    this._retireSquads();
  }

  _beginWave() {
    this.wave++;
    this.spawnedThisWave = 0;
    this.spawnTimer = 0;
    this.phase = PHASE.ACTIVE;
    this.targetThisWave = Math.min(32, 4 + this.wave * 2);
    this.maxAlive = Math.min(12, 3 + this.wave);
    this.hostileVariant = 0;
    this.ui?.banner?.show?.(
      `WAVE ${pad(this.wave)}`,
      this.wave === 1 ? 'HOSTILES INBOUND' : 'THEY KEEP COMING',
      2.8
    );
    this._retarget = 0;
    console.info(`[survival] wave ${this.wave} · ${this.targetThisWave} hostiles`);
  }

  _completeWave() {
    this.score += this.wave * 100;
    if (this.wave > this.best) {
      this.best = this.wave;
      this._saveBest(this.best);
    }
    this._beginPrep(PREP_TIME);
  }

  _playerDied() {
    if (!this.active || this.staged) return;
    this.phase = PHASE.DEAD;
    this.deadTimer = DEATH_TIME;
    if (this.wave > this.best) {
      this.best = this.wave;
      this._saveBest(this.best);
    }
    this.ui?.banner?.show?.('YOU DIED', `WAVE ${pad(this.wave)} · REDEPLOYING`, DEATH_TIME);
    console.info(`[survival] player died on wave ${this.wave} · score ${this.score}`);
  }

  _restart() {
    this.ai?.clearAgents?.();
    this.enemies.length = 0;
    this.waveSquads.length = 0;
    this.score = 0;
    this.kills = 0;
    this.alive = 0;
    this.remaining = 0;
    this.wave = 0;
    this.targetThisWave = 0;
    this.spawnedThisWave = 0;
    this.phase = PHASE.PREP;
    this.timer = FIRST_PREP;
    this.player?.respawn?.(0);
    this.ui?.banner?.show?.('REDEPLOYED', 'WAVE 01 INCOMING', 2.6);
  }

  _actorDied(e) {
    const a = e?.actor;
    if (!a || !this.enemies.includes(a)) return;
    this.kills++;
    this.score += 100 + this.wave * 10;
    // The corpse stays: the ragdoll is the visual payoff of the kill and is
    // reaped later by deadTime. Only the score is booked here.
  }

  _retireSquads() {
    for (const s of this.waveSquads) s.members.length = 0;
    this.waveSquads.length = 0;
    if (this.ai?.squads) {
      this.ai.squads = this.ai.squads.filter((s) => s.alive > 0);
    }
  }

  /* ================================================================== */
  /* spawning                                                           */
  /* ================================================================== */

  /**
   * Not every author-placed spawn is connected to the street: the gate spawn,
   * for instance, sits behind the closed perimeter and A* cannot reach the
   * player from it. Filter once, at boot, so a wave is never sent to a pocket
   * it can never leave.
   */
  _buildSpawnAnchors() {
    const pts = this.world?.spawnPoints ?? [];
    const g = this.ai?.grid;
    const goal = this.player?.position ?? this.ctx.camera.position;
    const path = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i].position;
      const v = new THREE.Vector3(p.x, p.y, p.z);
      if (g) {
        const ci = g.nearest(v.x, v.z, v.y, 6, 1.4);
        if (ci < 0) continue;
        v.set(g.worldX(ci % g.nx), g.floor[ci], g.worldZ((ci / g.nx) | 0));
        const n = g.findPath(v, goal, path);
        if (n === 0 && v.distanceTo(goal) > 3) continue;
      }
      this.spawnAnchors.push(v);
    }
    if (!this.spawnAnchors.length) {
      for (const p of pts) this.spawnAnchors.push(p.position.clone());
    }
    console.info(
      `[survival] ${this.spawnAnchors.length}/${pts.length} spawn anchors reachable`
    );
  }

  _pickSpawn(player) {
    const pts = this.spawnAnchors;
    if (!pts?.length) return null;
    let best = null;
    let bestScore = -Infinity;
    // One candidate in the far half of the level, with a little jitter so two
    // spawns on the same beat do not stack on one doorway.
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const d = p.distanceTo(player);
      if (d < 18 || d > 90) continue;
      const s = d * 0.02 + this.rng.float() * 1.6;
      if (s > bestScore) {
        bestScore = s;
        best = p;
      }
    }
    if (best) return best;
    // The player holed up next to every authored point: fall back to the
    // farthest one so a wave can never stall waiting for a legal spawn.
    for (let i = 0; i < pts.length; i++) {
      const d = pts[i].distanceTo(player);
      if (d > bestScore) {
        bestScore = d;
        best = pts[i];
      }
    }
    return best;
  }

  _spawn() {
    const player = this.player?.position ?? this.ctx.camera.position;
    const anchor = this._pickSpawn(player);
    if (!anchor) return false;

    this._spawnPos.copy(anchor);
    // Scatter the squad around the anchor instead of stacking it on one point.
    const ja = this.rng.range(0, Math.PI * 2);
    const jr = this.rng.range(0.8, 2.6);
    this._spawnPos.x += Math.cos(ja) * jr;
    this._spawnPos.z += Math.sin(ja) * jr;

    // Snap to the navigation floor where possible: spawn points are authored at
    // ground level but a jittered or rebuilt level can leave them a step out.
    const g = this.ai?.grid;
    if (g) {
      const ci = g.nearest(this._spawnPos.x, this._spawnPos.z, anchor.y, 3, 1.4);
      if (ci >= 0) {
        this._spawnPos.set(
          g.worldX(ci % g.nx),
          g.floor[ci],
          g.worldZ((ci / g.nx) | 0)
        );
      } else {
        this._spawnPos.copy(anchor);
      }
    }

    const variant = VARIANT_CYCLE[this.hostileVariant++ % VARIANT_CYCLE.length];
    const yaw = Math.atan2(player.x - this._spawnPos.x, player.z - this._spawnPos.z);
    this._huntPoint.copy(player);
    const a = this.ai.spawn(variant, this._spawnPos, yaw, { patrol: this._huntRoute });
    if (!a) return false;

    // Escalation: later waves are not just more numerous, they absorb more.
    if (this.wave > 2) {
      const extra = Math.min(120, (this.wave - 2) * 7);
      a.maxHealth = 100 + extra;
      a.health = a.maxHealth;
      a.weaponDamage = Math.min(31, 17 + (this.wave - 1) * 0.9);
    }

    if (this.spawnedThisWave % 4 === 0) {
      const squad = this.ai.createSquad();
      this.waveSquads.push(squad);
      this._squad = squad;
    }
    this._squad?.add(a);
    this.enemies.push(a);
    this.spawnedThisWave++;
    return true;
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt, ctx) {
    if (!this.active) return;

    if (this.staged) {
      this._pushHud();
      return;
    }

    if (this.phase === PHASE.DEAD) {
      this.deadTimer -= dt;
      this._pushHud();
      if (this.deadTimer <= 0) this._restart();
      return;
    }

    // Reap settled corpses so a long run cannot accumulate ragdolls forever.
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const a = this.enemies[i];
      if (!a.alive && a.deadTime > CORPSE_LIFE) {
        this.ai.removeAgent(a);
        this.enemies.splice(i, 1);
      }
    }

    let alive = 0;
    for (let i = 0; i < this.enemies.length; i++) if (this.enemies[i].alive) alive++;
    this.alive = alive;

    if (this.phase === PHASE.PREP) {
      this.timer -= dt;
      if (this.timer <= 0) this._beginWave();
    } else if (this.phase === PHASE.ACTIVE) {
      const player = this.player?.position ?? ctx.camera.position;

      // Keep pressure on: anyone not already in contact gets the player's
      // current position as their patrol target, so the wave converges instead
      // of idling where it spawned.
      this._retarget -= dt;
      if (this._retarget <= 0) {
        this._retarget = 1.6;
        this._huntPoint.copy(player);
        for (let i = 0; i < this.enemies.length; i++) {
          const a = this.enemies[i];
          if (a.alive && !a.hasTarget && a.state !== 'combat') a.patrolPoints = this._huntRoute;
        }
      }

      if (this.spawnedThisWave < this.targetThisWave) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0 && alive < this.maxAlive) {
          if (this._spawn()) this.spawnTimer = Math.max(0.4, 0.95 - this.wave * 0.03);
          else this.spawnTimer = 0.4;
        }
      } else if (alive === 0) {
        this._completeWave();
      }
    }

    this.remaining = Math.max(0, this.targetThisWave - this.spawnedThisWave) + this.alive;
    this._pushHud();
  }

  _pushHud() {
    this.ui?.setWave?.({
      active: true,
      wave: Math.max(1, this.wave),
      hostiles: this.remaining,
      score: this.score,
      best: this.best,
      phase: this.phase,
      timer: this.timer,
    });
  }

  /* ================================================================== */
  /* capture / dev                                                      */
  /* ================================================================== */

  /** Stage a night wave for the screenshot harness. */
  debugStage() {
    this.active = true;
    this.staged = true;
    this.phase = PHASE.ACTIVE;
    this.wave = 4;
    this.score = 1860;
    this.kills = 18;
    this.best = Math.max(this.best, 7);
    this.timer = 0;
    this.remaining = 5;
    this.alive = 5;
    this.targetThisWave = 5;
    this.spawnedThisWave = 5;

    this.ai?.debugStage?.('firefight');
    this.sky?.setTimeOfDay?.(NIGHT_HOUR);
    this._pushHud();
    return { mode: 'survival', wave: this.wave, hostiles: this.remaining };
  }

  /** Undo `debugStage()` when the harness moves on to another shot. */
  clearDebug() {
    if (!this.staged) return;
    this.staged = false;
    this.active = false;
    this.ui?.setWave?.({ active: false });
  }

  /* ================================================================== */

  _loadBest() {
    try {
      return Number(localStorage.getItem('nightfall.best') ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  _saveBest(v) {
    try {
      localStorage.setItem('nightfall.best', String(v));
    } catch {
      /* private mode / storage disabled */
    }
  }

  dispose() {
    for (const off of this._off ?? []) off();
    this._off = null;
  }
}

function pad(n) {
  return String(Math.max(0, n | 0)).padStart(2, '0');
}
