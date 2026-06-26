const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

export class SorobanUnavailableError extends Error {
  constructor(message = 'Soroban RPC is unavailable') {
    super(message);
    this.name = 'SorobanUnavailableError';
  }
}

/**
 * Three-state circuit breaker for Soroban RPC calls.
 *
 * States:
 *   CLOSED   — normal operation; failures are counted.
 *   OPEN     — failing fast; calls reject immediately without hitting the RPC.
 *   HALF_OPEN — probing; a success closes the breaker, a failure reopens it.
 *
 * Configuration (all optional, defaults shown):
 *   failureThreshold  5   — consecutive failures before opening.
 *   successThreshold  2   — consecutive successes in HALF_OPEN before closing.
 *   openDurationMs    30000 — ms to wait in OPEN before probing.
 */
export class CircuitBreaker {
  #state = STATE.CLOSED;
  #failures = 0;
  #successes = 0;
  #openedAt = null;
  #lastStateChange;
  #cfg;

  constructor({ failureThreshold = 5, successThreshold = 2, openDurationMs = 30_000 } = {}) {
    this.#cfg = { failureThreshold, successThreshold, openDurationMs };
    this.#lastStateChange = new Date().toISOString();
  }

  get state() { return this.#state; }
  get failures() { return this.#failures; }
  get lastStateChange() { return this.#lastStateChange; }

  /**
   * Execute `fn`. In OPEN state rejects immediately. In CLOSED/HALF_OPEN,
   * runs `fn` and updates failure/success counters accordingly.
   *
   * @param {() => Promise<any>} fn
   */
  async call(fn) {
    if (this.#state === STATE.OPEN) {
      if (Date.now() - this.#openedAt >= this.#cfg.openDurationMs) {
        this.#transition(STATE.HALF_OPEN);
      } else {
        throw new SorobanUnavailableError('Circuit breaker is OPEN — Soroban RPC is unavailable');
      }
    }

    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (err) {
      this.#onFailure();
      throw err;
    }
  }

  #onSuccess() {
    if (this.#state === STATE.HALF_OPEN) {
      this.#successes++;
      if (this.#successes >= this.#cfg.successThreshold) {
        this.#failures = 0;
        this.#successes = 0;
        this.#transition(STATE.CLOSED);
      }
    } else {
      this.#failures = 0;
    }
  }

  #onFailure() {
    this.#failures++;
    if (this.#state === STATE.HALF_OPEN || this.#failures >= this.#cfg.failureThreshold) {
      this.#openedAt = Date.now();
      this.#successes = 0;
      this.#transition(STATE.OPEN);
    }
  }

  #transition(newState) {
    const prev = this.#state;
    this.#state = newState;
    this.#lastStateChange = new Date().toISOString();
    console.log(`[circuit-breaker] ${prev} → ${newState}`);
  }

  /** Snapshot suitable for inclusion in the /health response. */
  toHealthInfo() {
    return {
      state: this.#state,
      failures: this.#failures,
      lastStateChange: this.#lastStateChange,
    };
  }
}
