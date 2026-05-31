import { useEffect, useMemo, useRef, useState } from 'react';

export interface ContractEventFilter {
  contractId?: string;
  topic?: string[];
}

export interface StreamedContractEvent {
  id: string;
  type: string;
  contractId: string;
  topic: string[];
  value: unknown;
  ledger: number;
  txHash: string;
  timestamp: string;
}

const MAX_EVENTS = 200;
export function useContractEvents(filter?: ContractEventFilter) {
  const [events, setEvents] = useState<StreamedContractEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const eventsUrl = import.meta.env.VITE_EVENTS_URL ?? 'http://localhost:3001/events';

  const topicKey = filter?.topic?.join(',') ?? '';

  const streamUrl = useMemo(() => {
    const url = new URL(eventsUrl);
    if (filter?.contractId) {
      url.searchParams.set('contractId', filter.contractId);
    }
    if (filter?.topic && filter.topic.length > 0) {
      url.searchParams.set('topic', filter.topic.join(','));
    }
    return url.toString();
  }, [eventsUrl, filter?.contractId, topicKey]);

  useEffect(() => {
    const source = new EventSource(streamUrl);
    sourceRef.current = source;

    source.addEventListener('connected', () => {
      setConnected(true);
      setError(null);
    });

    source.addEventListener('contract-event', (evt) => {
      try {
        const parsed = JSON.parse((evt as MessageEvent).data) as StreamedContractEvent;
        setEvents((prev) => [parsed, ...prev].slice(0, MAX_EVENTS));
      } catch {
        // Ignore invalid payloads
      }
    });

    source.addEventListener('heartbeat', () => {
      setConnected(true);
    });

    source.onerror = () => {
      setConnected(false);
      setError('Event stream disconnected');
    };

    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [streamUrl]);

  return { events, connected, error };
}
