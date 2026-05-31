import { SorobanRpc, Contract, xdr, scValToNative } from '@stellar/stellar-sdk';

export interface EventFilter {
  topic?: string[] | string[][];
  contractId?: string;
}

export interface ContractEvent {
  type: string;
  contractId: string;
  topic: string[];
  value: Record<string, unknown>;
  ledger: number;
  txHash: string;
}

export interface GetEventsOptions {
  rpcUrl: string;
  contractId: string;
  /** Ledger to start scanning from. Omit to start from the oldest available. */
  startLedger?: number;
  /** Maximum number of events to return. Defaults to 100. */
  limit?: number;
  filter?: EventFilter;
}

/**
 * One-shot fetch of historical contract events via the Soroban RPC getEvents
 * endpoint. For real-time updates use SorobanEventListener instead.
 *
 * Event indexing strategy:
 *   - For lightweight queries: call this utility with a known startLedger.
 *   - For production indexing: consider the Mercury indexer for Soroban
 *     (https://mercurydata.app) or run a custom listener that checkpoints
 *     the last processed ledger and pages forward on each invocation.
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

export class SorobanEventListener {
  private server: SorobanRpc.Server;
  private contractId: string;
  private filter?: EventFilter;
  private isRunning = false;
  private intervalId?: ReturnType<typeof setInterval>;
  private lastLedger = 0;

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
