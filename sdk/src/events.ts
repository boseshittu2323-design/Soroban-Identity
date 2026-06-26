import { SorobanRpc, Contract, xdr, scValToNative } from '@stellar/stellar-sdk';

/** Filter applied to an event subscription or one-shot query. */
export interface EventFilter {
  /** Topic filter — single topic array or matrix of OR-able topics. */
  topic?: string[] | string[][];
  /** Restrict results to events from this contract ID. */
  contractId?: string;
}

/** Decoded Soroban contract event returned by {@link getEvents} or the listener callback. */
export interface ContractEvent {
  type: string;
  /** Stellar contract ID that emitted this event. */
  contractId: string;
  /** JSON-serialised topic values. */
  topic: string[];
  /** Decoded event payload. */
  value: Record<string, unknown>;
  /** Ledger sequence number the event was emitted in. */
  ledger: number;
  /** Transaction hash of the transaction that produced this event. */
  txHash: string;
}

/** Options for a one-shot historical event query via {@link getEvents}. */
export interface GetEventsOptions {
  /** Soroban RPC URL to query. */
  rpcUrl: string;
  /** Contract whose events to fetch. */
  contractId: string;
  /** Ledger to start scanning from. Omit to start from the oldest available. */
  startLedger?: number;
  /** Maximum number of events to return. Defaults to 100. */
  limit?: number;
  filter?: EventFilter;
}

/**
 * One-shot fetch of historical contract events via the Soroban RPC `getEvents`
 * endpoint.
 *
 * For real-time updates use {@link SorobanEventListener} instead.
 *
 * **Indexing strategy:** For lightweight queries, call this utility with a
 * known `startLedger`. For production indexing, consider checkpointing the
 * last processed ledger and paging forward on each invocation.
 *
 * @param options Query parameters — RPC URL, contract, ledger range, and filter.
 * @returns Array of decoded {@link ContractEvent} records. Empty when no events
 *   match.
 * @throws If the RPC request fails.
 */
export async function getEvents(options: GetEventsOptions): Promise<ContractEvent[]> {
  const { rpcUrl, contractId, startLedger, limit = 100, filter } = options;
  const server = new SorobanRpc.Server(rpcUrl);

  const topicsFilter = buildTopicsFilter(filter);

  const response = await server.getEvents({
    startLedger: startLedger ?? undefined,
    filters: [{ type: 'contract', contractIds: [contractId], topics: topicsFilter }],
    limit,
  });

  if (!response.events?.length) return [];

  return response.events
    .map(parseRawEvent)
    .filter((e): e is ContractEvent => e !== null);
}

function buildTopicsFilter(filter?: EventFilter): string[][] | undefined {
  const topic = filter?.topic;
  if (!topic) return undefined;
  return Array.isArray(topic[0]) ? (topic as string[][]) : [topic as string[]];
}

function parseRawEvent(event: SorobanRpc.Api.EventResponse): ContractEvent | null {
  try {
    if (event.type !== 'contract') return null;

    const contractId =
      typeof event.contractId === 'string'
        ? event.contractId
        : (event.contractId as Contract).contractId();

    const topic = Array.isArray(event.topic)
      ? (event.topic as xdr.ScVal[]).map((t) => JSON.stringify(scValToNative(t)))
      : [];

    const value =
      event.value instanceof xdr.ScVal
        ? (scValToNative(event.value) as Record<string, unknown>)
        : {};

    return { type: event.type, contractId, topic, value, ledger: event.ledger, txHash: event.txHash };
  } catch {
    return null;
  }
}

/**
 * Long-running, polling-based listener for real-time Soroban contract events.
 *
 * Polls the RPC `getEvents` endpoint at a configurable interval and delivers
 * new events to a callback. Tracks the last seen ledger so each poll returns
 * only fresh events.
 *
 * @example
 * ```ts
 * const listener = new SorobanEventListener(rpcUrl, contractId, {
 *   topic: ['credential', 'issued'],
 * });
 * listener.start((events) => console.log(events));
 * // later...
 * listener.stop();
 * ```
 */
export class SorobanEventListener {
  private server: SorobanRpc.Server;
  private contractId: string;
  private filter?: EventFilter;
  private isRunning = false;
  private intervalId?: ReturnType<typeof setInterval>;
  private lastLedger = 0;

  /**
   * @param rpcUrl     Soroban RPC endpoint URL.
   * @param contractId Contract whose events to subscribe to.
   * @param filter     Optional topic / contract-ID filter applied to each poll.
   */
  constructor(rpcUrl: string, contractId: string, filter?: EventFilter) {
    this.server = new SorobanRpc.Server(rpcUrl);
    this.contractId = contractId;
    this.filter = filter;
  }

  /**
   * Start polling for events at the specified interval.
   * @param callback Function called with matching events
   * @param intervalMs Polling interval in milliseconds (default: 5000)
   */
  start(callback: (events: ContractEvent[]) => void, intervalMs = 5000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const poll = async () => {
      try {
        const events = await this.server.getEvents({
          startLedger: this.lastLedger || undefined,
          filters: [
            {
              type: 'contract',
              contractIds: [this.contractId],
              topics: this.getTopicsFilter(),
            },
          ],
          limit: 100,
        });

        if (events.events && events.events.length > 0) {
          const contractEvents = events.events
            .map((e) => this.parseEvent(e))
            .filter((e) => e !== null) as ContractEvent[];

          if (contractEvents.length > 0) {
            callback(contractEvents);
            this.lastLedger =
              Math.max(...contractEvents.map((e) => e.ledger)) + 1;
          }
        }
      } catch (error) {
        console.error('Error polling events:', error);
      }
    };

    poll();
    this.intervalId = setInterval(poll, intervalMs);
  }

  /**
   * Stop polling for events.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
  }

  private parseEvent(event: SorobanRpc.Api.EventResponse): ContractEvent | null {
    return parseRawEvent(event);
  }

  private getTopicsFilter(): string[][] | undefined {
    return buildTopicsFilter(this.filter);
  }
}
